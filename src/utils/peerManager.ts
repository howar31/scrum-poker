import Peer, { type DataConnection } from 'peerjs';
import i18n from '../i18n';
import { usePokerStore, type CardValue, type Player, type RoomState } from '../store/usePokerStore';
import { generateRoomId } from './roomId';
import { isArcBrowser } from './browserDetect';

export type Action =
  | { type: 'JOIN'; payload: { id: string; name: string; peerId: string } }
  | { type: 'SELECT_CARD'; payload: { id: string; card: CardValue } }
  | { type: 'REVEAL' }
  | { type: 'RESET' }
  | { type: 'KICK'; payload: { id: string } }
  | { type: 'TRANSFER_HOST'; payload: { id: string } };

export type Message =
  | { type: 'STATE_UPDATE'; payload: RoomState }
  | { type: 'ACTION'; payload: Action }
  // Host → clients application-layer heartbeat. Sent every PING_INTERVAL_MS
  // over every open DataConnection. Clients reset a watchdog on any inbound
  // data (PING or otherwise); if the watchdog fires without a signal, they
  // treat the host as dead instead of waiting for WebRTC's own ICE consent
  // check (which can take 15–30 s).
  | { type: 'PING' }
  // Host → clients: I'm leaving gracefully; {{nextHostId}} is the designated
  // successor. Lets clients skip the reconnect grace period and trigger the
  // direct-connect-to-successor flow immediately. Computed by the leaving
  // host so every client trusts the same authoritative choice.
  | { type: 'HOST_LEAVING'; payload: { nextHostId: string | null } }
  // Client → old host: I received HOST_LEAVING, you can tear down now. Old
  // host waits for ACKs from every client (or HOST_LEAVING_ACK_TIMEOUT_MS)
  // before destroying its peer. Without this, a short pre-destroy flush
  // (50 ms) was losing HOST_LEAVING across higher-latency cross-network
  // DataChannels — the SCTP send queue would be dropped at destroy before
  // the message was ack'd, leaving some clients oblivious to the handoff.
  | { type: 'HOST_LEAVING_ACK' }
  // Host → kicked client. Sent right before the host closes the conn.
  // Without this, the client's conn.on('close') would call
  // onHostConnectionLost → probe well-known → succeed → JOIN again, and
  // the host would re-add them as a fresh player. With KICKED, the
  // client sets `intentionalLeave = true` and tears down locally so no
  // reconnect is attempted. Defense in depth: the host also remembers
  // kicked playerIds and rejects any subsequent JOIN from them (covers
  // the case where the KICKED message itself is lost).
  | { type: 'KICKED' };

const PEER_PREFIX = 'scrum-poker-';
// Reclaim backoff for new host taking over the well-known peer ID. Covers the
// full PeerJS broker `alive_timeout` (~60 s) in case a silently-crashed old
// host still holds the ID there; the new host keeps retrying as a background
// task so late joiners via `?room=XYZ` can eventually discover the room. Not
// on the critical path for existing members — they direct-connect to the new
// host's original peer ID.
const RECLAIM_DELAYS_MS = [0, 1000, 2000, 4000, 8000, 15000, 20000, 20000];
// After a reclaim-or-self-promote, wait this long for remaining clients to
// direct-connect to us before sweeping any player whose peer never re-
// appeared. Covers the full direct-connect retry window plus a buffer.
const GHOST_CLEANUP_DELAY_MS = 20000;
// Host-side heartbeat broadcast interval.
const PING_INTERVAL_MS = 2000;
// Client-side watchdog: host is declared dead if no data arrives within this
// window. ~4 consecutive missed PINGs.
const PING_TIMEOUT_MS = 8000;
// Option A — single quick well-known-ID probe before migrating. Covers short
// network blips so we don't kick off an unnecessary migration.
const WELL_KNOWN_PROBE_TIMEOUT_MS = 2000;
// How long the leaving host waits for clients to ACK HOST_LEAVING before
// destroying its peer. Upper bound — if every client acks immediately, we
// proceed as soon as they all do. Covers cross-network RTT + a margin so
// the SCTP queue drains before we tear the DataChannel down.
const HOST_LEAVING_ACK_TIMEOUT_MS = 5000;
// Lower-bound extra delay after the ACK wait completes. Gives the OS a
// moment to flush the DataChannel send buffer even after SCTP acked —
// belt-and-braces against tight races on flaky networks.
const HOST_LEAVING_SETTLE_MS = 200;
// Total budget for reconnecting during a migration. Inside this window we
// alternate direct-connect to the successor's original peer ID and connect
// via the well-known ID (in case the successor has already opened the
// secondary well-known peer in the background) — whichever responds first
// wins. Longer than the Option A probe because ICE can take a moment to
// settle and the successor may briefly reject connections while flipping
// `isHost = true`.
const MIGRATION_RECONNECT_BUDGET_MS = 20000;
// How long the host ignores JOIN attempts from a just-kicked playerId.
// Short by design: long enough to outlast the kicked client's automatic
// reconnect cycle (conn.close → probe → JOIN), but short enough that a
// user who genuinely wants to rejoin can do so manually a moment later.
// Kick is "stop the auto-reconnect loop", not a ban.
const KICK_REJECT_WINDOW_MS = 5000;
// Flush delay between sending KICKED and closing the kicked client's
// DataConnection. Small but non-zero so the message lands before SCTP
// drops the send queue.
const KICK_MESSAGE_FLUSH_MS = 200;

interface JoinRetryHandle {
  /** Cancels any pending peer.connect and stops retries. */
  cancel: () => void;
  /** Resolves when the room is joined; rejects on cancel or window exceeded. */
  promise: Promise<void>;
}

export type JoinRetryProgress =
  | { kind: 'connecting' }
  | { kind: 'peer-unavailable' }
  | { kind: 'timeout' };

interface JoinRetryOptions {
  /** Optional hard cap. Omit for "keep trying until cancel or success" — the
   * UI now runs the timeout prompt on a side-timer instead of gating the
   * retry loop, so the user can leave the give-up prompt on screen without
   * pausing the background retry. */
  maxDurationMs?: number;
  onProgress?: (progress: JoinRetryProgress, elapsedMs: number) => void;
}

function isPeerUnavailable(err: unknown): boolean {
  const e = err as { type?: string; message?: string } | undefined;
  return (
    e?.type === 'peer-unavailable' ||
    (typeof e?.message === 'string' && e.message.toLowerCase().includes('could not connect to peer'))
  );
}

class PeerManager {
  private peer: Peer | null = null;
  // Secondary peer used by a self-promoted host to hold the well-known ID
  // without disturbing the primary peer (which existing clients are already
  // connected to). Only populated after a migration when the reclaim loop
  // succeeds. `null` when the primary peer already owns the well-known ID
  // (original `createRoom` path) or when reclaim hasn't completed yet.
  private wellKnownPeer: Peer | null = null;
  // Host-side: playerIds that were recently kicked → absolute timestamp
  // after which we'll accept a fresh JOIN from them again. Defense in
  // depth for the case where our KICKED message was lost in transit and
  // the client's conn.close would otherwise trigger an immediate auto-
  // reconnect → the host would re-add them as a new player. The window
  // is deliberately short (KICK_REJECT_WINDOW_MS): the kicked user can
  // still manually re-join a few seconds later if they actually want to,
  // so kicking is "dismiss the auto-reconnect loop", not a permanent ban.
  private kickedUntil: Map<string, number> = new Map();
  private connections: Map<string, DataConnection> = new Map();
  private hostConnection: DataConnection | null = null;
  private isHost: boolean = false;
  // Host-side: broadcasts PING to keep clients' watchdogs reset.
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  // Client-side: fires if no data arrives from host within PING_TIMEOUT_MS.
  private heartbeatWatchdog: ReturnType<typeof setTimeout> | null = null;
  private ghostCleanupTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalLeave = false;
  // Guards against concurrent reconnect attempts (heartbeat-triggered vs
  // conn.close-triggered vs HOST_LEAVING handler).
  private reconnecting = false;
  // When HOST_LEAVING arrives we save its nextHostId here as the
  // authoritative successor for the upcoming migration. This covers the
  // cross-network race where `conn.on('close')` beats the HOST_LEAVING
  // data event: `onHostConnectionLost` flips `reconnecting=true`, so
  // `handleHostLeaving` would early-return without applying the intended
  // successor — and `handleHostDisconnect` would fall back to auto-
  // election (oldest-non-host), possibly picking someone OTHER than the
  // user's chosen successor. Any migration path consults this value
  // before auto-electing. Cleared on consume and on every room join.
  // `undefined` = "no HOST_LEAVING observed"; `null` = "room is closing
  // with no successor". Do not conflate the two.
  private authoritativeSuccessor: string | null | undefined = undefined;
  // Guards against infinite migration loops — if migration fails and we
  // re-enter, give up instead of looping forever.
  private migrationAttempted = false;

  init(specificPeerId?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.destroy();

      const opts = {
        debug: 2,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:global.stun.twilio.com:3478' },
          ],
        },
      };

      console.log('[peerManager] init: creating Peer, specificPeerId=', specificPeerId ?? '(auto)');
      this.peer = specificPeerId ? new Peer(specificPeerId, opts) : new Peer(opts);

      let initResolved = false;
      // Track whether THIS peer reached 'open' at least once. A brand-new
      // peer that errors before opening (e.g. `unavailable-id`) also
      // fires 'disconnected' — we must not try to reconnect it.
      let hasOpened = false;
      // Capture the peer ref so the listener can detect if it's stale
      // (another peer replaced it via a later init()).
      const ownedPeer = this.peer;

      this.peer.on('open', (id) => {
        console.log('[peerManager] peer open, id=', id);
        hasOpened = true;
        if (initResolved) {
          // Re-open after peer.reconnect() — restore the green dot.
          usePokerStore.getState().setConnectionStatus('connected');
        }
        initResolved = true;
        resolve(id);
      });

      this.peer.on('connection', (conn) => {
        console.log('[peerManager] incoming connection from', conn.peer, 'isHost=', this.isHost);
        this.handleIncomingConnection(conn);
      });

      this.peer.on('disconnected', () => {
        // Guards that must ALL be true before we try to re-register:
        //   1. Not a stale peer (a newer one has taken over already).
        //   2. The peer actually reached 'open' at some point.
        //   3. Not intentionally tearing down (leave / transferHost).
        //   4. Peer still exists and hasn't been destroyed.
        if (ownedPeer !== this.peer) return;
        if (!hasOpened) return;
        if (this.intentionalLeave) {
          console.warn('[peerManager] peer disconnected (intentional, skipping reconnect)');
          return;
        }
        if (!this.peer || this.peer.destroyed) return;

        console.warn('[peerManager] peer disconnected from broker, reconnecting');
        usePokerStore.getState().setConnectionStatus('reconnecting');
        try {
          this.peer.reconnect();
        } catch (err) {
          console.error('[peerManager] peer.reconnect() failed:', err);
        }
      });
      this.peer.on('close', () => {
        console.warn('[peerManager] peer closed');
        // `close` fires once the Peer is fully torn down (usually from our
        // own destroy()). Don't flip status here — the teardown path has
        // already set the appropriate final state.
      });

      this.peer.on('error', (err) => {
        console.error('[peerManager] peer error:', err.type, err.message);
        if (!initResolved) {
          initResolved = true;
          reject(err);
          return;
        }
        // Post-init peer errors are transient (e.g. stale signaling events
        // after a network blip). Surface as a toast so they auto-dismiss and
        // don't persist after reconnect succeeds.
        usePokerStore.getState().pushToast({
          message: err.message,
          variant: 'error',
        });
      });
    });
  }

  async createRoom() {
    this.intentionalLeave = false;
    this.migrationAttempted = false;
    this.authoritativeSuccessor = undefined;
    const { playerId, playerName } = usePokerStore.getState();
    const roomId = generateRoomId();
    const hostPeerId = `${PEER_PREFIX}${roomId}`;

    // Set role BEFORE init so incoming connections that race with peer.on('open')
    // are not rejected by handleIncomingConnection's !this.isHost guard.
    this.isHost = true;
    console.log('[peerManager] createRoom: isHost=true, peerId=', hostPeerId);

    try {
      if (!this.peer || this.peer.disconnected) {
        await this.init(hostPeerId);
      }
    } catch (err) {
      this.isHost = false;
      throw err;
    }

    const initialPlayer: Player = {
      id: playerId,
      name: playerName,
      card: null,
      joinedAt: Date.now(),
      peerId: hostPeerId,
    };

    usePokerStore.getState().updateRoomState({
      roomId,
      hostId: playerId,
      players: { [playerId]: initialPlayer },
      isRevealed: false,
    });

    usePokerStore.getState().setConnectionStatus('connected');
    this.startHeartbeatBroadcast();
    console.log('[peerManager] createRoom: ready, roomId=', roomId);
  }

  /**
   * Connect to a host at a specific peer ID. Shared by:
   *   - Fresh joins via well-known ID (Home.tsx path, `joinRoom`)
   *   - Heartbeat-triggered probes (short timeout)
   *   - Post-migration direct-connects to the new host's original peer ID
   *
   * Callers who need retry logic should wrap this (see `joinRoomWithRetry`).
   */
  async joinViaHost(hostPeerId: string, opts: { timeoutMs?: number } = {}): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 20000;

    this.isHost = false;
    this.stopHeartbeatBroadcast();

    if (!this.peer || this.peer.disconnected) await this.init();
    if (!this.peer) throw new Error(i18n.t('errors.peerInitFailed'));

    // Close any stale host connection so we don't keep two parallel sockets.
    if (this.hostConnection) {
      try {
        this.hostConnection.close();
      } catch {
        /* ignore */
      }
      this.hostConnection = null;
    }

    console.log('[peerManager] joinViaHost: my peerId=', this.peer.id, 'connecting to', hostPeerId);

    return new Promise((resolve, reject) => {
      let settled = false;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        this.peer?.off('error', onPeerError);
        fn();
      };

      const onPeerError = (err: { type?: string; message?: string }) => {
        console.error('[peerManager] joinViaHost peer error:', err.type, err.message);
        // Preserve error type so callers (e.g. joinRoomWithRetry) can branch
        // on `peer-unavailable` vs timeout.
        const e = new Error(err.message ?? i18n.t('errors.peerError'));
        (e as Error & { type?: string }).type = err.type;
        settle(() => reject(e));
      };

      this.peer!.on('error', onPeerError);

      const timeoutId: ReturnType<typeof setTimeout> = setTimeout(() => {
        const baseMsg = i18n.t('errors.connectionTimeout');
        const arcHint = isArcBrowser() ? i18n.t('errors.arcHint') : '';
        const e = new Error(baseMsg + arcHint);
        (e as Error & { type?: string }).type = 'timeout';
        settle(() => reject(e));
      }, timeoutMs);

      const conn = this.peer!.connect(hostPeerId, { serialization: 'json' });
      this.hostConnection = conn;
      console.log('[peerManager] joinViaHost: DataConnection created, waiting for open...');

      conn.on('error', (err) => {
        console.error('[peerManager] joinViaHost conn error:', err);
        settle(() => reject(err));
      });

      conn.on('close', () => {
        console.warn('[peerManager] joinViaHost conn closed (settled=', settled, ')');
        if (!settled) {
          settle(() => reject(new Error(i18n.t('errors.closedBeforeJoining'))));
          return;
        }
        // Connection was previously open; heartbeat watchdog may already be
        // handling this but belt-and-braces: fall through to the reconnect
        // path if it hasn't.
        this.stopHeartbeatWatchdog();
        this.onHostConnectionLost();
      });

      conn.on('iceStateChanged', (state) => {
        console.log('[peerManager] joinViaHost ICE state =', state);
      });

      conn.on('data', (raw) => {
        this.touchHeartbeat();
        const data = raw as Message;
        if (data?.type === 'PING') return;
        console.log('[peerManager] joinViaHost received data type=', data?.type);
        if (data?.type === 'STATE_UPDATE' && data.payload) {
          usePokerStore.getState().updateRoomState(data.payload);
          settle(() => resolve());
          // Belt-and-braces self-promote: if the broadcast indicates we
          // ARE the new host but we haven't flipped `isHost` yet, the
          // primary HOST_LEAVING signal was either in-flight or got
          // dropped cross-network. Jump to selfPromoteHost from here so
          // our UI (already showing the crown because of state.hostId)
          // matches our P2P role. Gated on `!isHost` so subsequent
          // STATE_UPDATEs never re-trigger. See transferHost's eager
          // `updateRoomState({hostId})` broadcast on the sending side.
          const poststate = usePokerStore.getState();
          if (
            !this.isHost &&
            poststate.roomId &&
            data.payload.hostId &&
            data.payload.hostId === poststate.playerId
          ) {
            console.log(
              '[peerManager] STATE_UPDATE says I am host but isHost=false — self-promoting'
            );
            void this.selfPromoteHost(poststate.roomId);
          }
        } else if (data?.type === 'HOST_LEAVING') {
          this.handleHostLeaving(data.payload.nextHostId);
        } else if (data?.type === 'KICKED') {
          // If the kick arrives BEFORE joinViaHost has resolved (edge
          // case — e.g. a rejected re-join during the reject window),
          // settle as an error so the caller stops retrying.
          if (!settled) {
            settle(() => reject(new Error(i18n.t('errors.kicked'))));
          }
          this.handleKicked();
        }
      });

      const setupConnection = () => {
        console.log('[peerManager] joinViaHost: conn.open fired, sending JOIN');
        usePokerStore.getState().setConnectionStatus('connected');
        usePokerStore.getState().setMigrationPhase('idle');

        const { playerId, playerName } = usePokerStore.getState();
        this.sendAction({
          type: 'JOIN',
          payload: { id: playerId, name: playerName, peerId: this.peer!.id },
        });
      };

      if (conn.open) setupConnection();
      else conn.on('open', setupConnection);
    });
  }

  async joinRoom(roomId: string): Promise<void> {
    this.intentionalLeave = false;
    this.migrationAttempted = false;
    this.reconnecting = false;
    this.authoritativeSuccessor = undefined;
    return this.joinViaHost(`${PEER_PREFIX}${roomId}`);
  }

  /**
   * Home.tsx join flow: keep retrying until we join, the caller cancels, or
   * the window elapses. Distinguishes `peer-unavailable` (ID not registered;
   * room may not exist or broker released during migration) from timeout
   * (broker still has the ID but the peer behind it is unreachable — more
   * strongly suggests migration in progress) so the UI can tell the user
   * what's happening. See JoinOverlay in Home.tsx.
   */
  joinRoomWithRetry(roomId: string, opts: JoinRetryOptions): JoinRetryHandle {
    let cancelled = false;

    const promise = (async () => {
      const start = Date.now();
      const hostPeerId = `${PEER_PREFIX}${roomId}`;
      let attempt = 0;
      while (!cancelled) {
        const elapsed = Date.now() - start;
        if (opts.maxDurationMs !== undefined && elapsed >= opts.maxDurationMs) {
          const e = new Error('join window exceeded');
          (e as Error & { type?: string }).type = 'window-exceeded';
          throw e;
        }
        attempt++;
        opts.onProgress?.({ kind: 'connecting' }, elapsed);
        try {
          await this.joinViaHost(hostPeerId, { timeoutMs: 5000 });
          return;
        } catch (err) {
          if (cancelled) {
            const e = new Error('cancelled');
            (e as Error & { type?: string }).type = 'cancelled';
            throw e;
          }
          const reason: JoinRetryProgress = isPeerUnavailable(err)
            ? { kind: 'peer-unavailable' }
            : { kind: 'timeout' };
          opts.onProgress?.(reason, Date.now() - start);
          // Brief pause before retry so we don't hammer the broker. Stretch
          // slightly on repeated failures.
          const delay = Math.min(1000 + attempt * 250, 3000);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
      const e = new Error('cancelled');
      (e as Error & { type?: string }).type = 'cancelled';
      throw e;
    })();

    return {
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        // Tear down any in-flight peer / DataConnection so the current
        // joinViaHost call rejects promptly.
        this.destroy();
        this.reconnecting = false;
      },
      promise,
    };
  }

  private handleIncomingConnection(conn: DataConnection) {
    if (!this.isHost) {
      console.warn('[peerManager] not host, rejecting incoming from', conn.peer);
      conn.close();
      return;
    }

    const setupIncoming = () => {
      console.log('[peerManager] incoming open, storing + broadcasting to', conn.peer);
      this.connections.set(conn.peer, conn);
      this.broadcastState();
    };

    conn.on('iceStateChanged', (state) => {
      console.log('[peerManager] incoming ICE', conn.peer, '=', state);
    });

    conn.on('data', (raw) => {
      const data = raw as Message;
      if (data?.type === 'PING') return;
      console.log('[peerManager] incoming data from', conn.peer, 'type=', data?.type);
      if (data?.type === 'ACTION' && data.payload) {
        this.processAction(data.payload, conn);
      }
    });

    conn.on('close', () => {
      console.warn('[peerManager] incoming closed', conn.peer);
      this.connections.delete(conn.peer);
      const state = usePokerStore.getState();
      // Find player by matching peerId stored on the Player object (the peer.id
      // of the connecting client, which is NOT derivable from conn.peer alone).
      const player = Object.values(state.players).find((p) => p.peerId === conn.peer);
      if (player) {
        usePokerStore.getState().pushToast({
          message: i18n.t('toast.playerOffline', { name: player.name }),
          variant: 'warning',
        });
        const newPlayers = { ...state.players };
        delete newPlayers[player.id];
        usePokerStore.getState().updateRoomState({ players: newPlayers });
      }
      this.broadcastState();
    });

    conn.on('error', (err) => {
      console.error('[peerManager] incoming error', conn.peer, err);
      this.connections.delete(conn.peer);
    });

    if (conn.open) setupIncoming();
    else conn.on('open', setupIncoming);
  }

  private processAction(action: Action, sourceConn?: DataConnection) {
    if (!this.isHost) return;

    const state = usePokerStore.getState();
    const newPlayers = { ...state.players };

    switch (action.type) {
      case 'JOIN': {
        // Reject JOINs from a recently-kicked playerId. Covers the race
        // where our KICKED message was lost and the client is mid-
        // auto-reconnect. The window self-expires so manual re-joins
        // work normally a moment later.
        const kickUntil = this.kickedUntil.get(action.payload.id);
        if (kickUntil !== undefined) {
          if (Date.now() < kickUntil) {
            console.log(
              '[peerManager] rejecting JOIN from recently kicked',
              action.payload.id
            );
            if (sourceConn && sourceConn.open) {
              try {
                sourceConn.send({ type: 'KICKED' } as Message);
              } catch {
                /* ignore */
              }
              setTimeout(() => {
                try {
                  sourceConn.close();
                } catch {
                  /* ignore */
                }
              }, KICK_MESSAGE_FLUSH_MS);
            }
            return;
          }
          this.kickedUntil.delete(action.payload.id);
        }
        const existing = newPlayers[action.payload.id];
        if (existing) {
          // Same playerId reconnecting (e.g. refreshed their tab and persisted
          // playerId survived). Update peerId but keep joinedAt so host-election
          // ordering stays stable.
          newPlayers[action.payload.id] = {
            ...existing,
            name: action.payload.name,
            peerId: action.payload.peerId,
          };
          usePokerStore.getState().pushToast({
            message: i18n.t('toast.playerReconnected', { name: action.payload.name }),
            variant: 'success',
          });
        } else {
          newPlayers[action.payload.id] = {
            id: action.payload.id,
            name: action.payload.name,
            card: null,
            joinedAt: Date.now(),
            peerId: action.payload.peerId,
          };
          usePokerStore.getState().pushToast({
            message: i18n.t('toast.playerJoined', { name: action.payload.name }),
            variant: 'info',
          });
        }
        // Also remap the connections map: if this player was previously under a
        // different peerId, drop the stale entry.
        if (sourceConn) {
          this.connections.set(sourceConn.peer, sourceConn);
        }
        usePokerStore.getState().updateRoomState({ players: newPlayers });
        break;
      }
      case 'SELECT_CARD':
        if (newPlayers[action.payload.id]) {
          newPlayers[action.payload.id] = {
            ...newPlayers[action.payload.id],
            card: action.payload.card,
          };
          usePokerStore.getState().updateRoomState({ players: newPlayers });
        }
        break;
      case 'REVEAL':
        usePokerStore.getState().updateRoomState({ isRevealed: true });
        break;
      case 'RESET':
        Object.keys(newPlayers).forEach((key) => {
          newPlayers[key] = { ...newPlayers[key], card: null };
        });
        usePokerStore.getState().updateRoomState({ players: newPlayers, isRevealed: false });
        break;
      case 'KICK': {
        const kickPeerId = newPlayers[action.payload.id]?.peerId;
        delete newPlayers[action.payload.id];
        usePokerStore.getState().updateRoomState({ players: newPlayers });
        // Remember the kicked playerId briefly so the client's automatic
        // reconnect (conn.close → probe → JOIN) is rejected instead of
        // silently re-adding them. Expires after KICK_REJECT_WINDOW_MS
        // so a genuine manual re-join still works moments later.
        this.kickedUntil.set(action.payload.id, Date.now() + KICK_REJECT_WINDOW_MS);
        if (kickPeerId) {
          const connToKick = this.connections.get(kickPeerId);
          // Drop from the connections map BEFORE the trailing
          // broadcastState at the end of processAction. Otherwise the
          // kicked client races the KICKED message with a fresh
          // STATE_UPDATE (which puts them right back into the Room UI
          // via updateRoomState after leaveRoom).
          this.connections.delete(kickPeerId);
          if (connToKick && connToKick.open) {
            // Tell the kicked client so they can tear down locally and
            // show a toast, instead of trying to reconnect. Defense in
            // depth: even if this message is lost, `kickedUntil` will
            // reject their JOIN for 5 s.
            try {
              connToKick.send({ type: 'KICKED' } as Message);
            } catch (err) {
              console.warn('[peerManager] KICKED send failed', err);
            }
            // Small flush before closing so the SCTP queue isn't dropped.
            setTimeout(() => {
              try {
                connToKick.close();
              } catch {
                /* ignore */
              }
            }, KICK_MESSAGE_FLUSH_MS);
          }
        }
        break;
      }
      case 'TRANSFER_HOST':
        this.transferHost(action.payload.id);
        return;
    }

    this.broadcastState();
  }

  sendAction(action: Action) {
    if (this.isHost) {
      this.processAction(action);
    } else if (this.hostConnection && this.hostConnection.open) {
      this.hostConnection.send({ type: 'ACTION', payload: action } as Message);
    }
  }

  private broadcastState() {
    if (!this.isHost) return;
    const { roomId, hostId, players, isRevealed } = usePokerStore.getState();
    const stateUpdate: Message = {
      type: 'STATE_UPDATE',
      payload: { roomId, hostId, players, isRevealed },
    };

    this.connections.forEach((conn) => {
      if (conn.open) conn.send(stateUpdate);
    });
  }

  // ─── Heartbeat ────────────────────────────────────────────────────────────
  // Host broadcasts PING; clients keep a single rolling watchdog that fires if
  // no data arrives within PING_TIMEOUT_MS. Any inbound message (STATE_UPDATE,
  // HOST_LEAVING, PING, …) resets it — so a busy host naturally suppresses
  // the ping overhead; a silent host is detected in a bounded window.

  private startHeartbeatBroadcast() {
    this.stopHeartbeatBroadcast();
    this.heartbeatInterval = setInterval(() => {
      if (!this.isHost) return;
      const msg: Message = { type: 'PING' };
      this.connections.forEach((conn) => {
        if (conn.open) {
          try {
            conn.send(msg);
          } catch (err) {
            console.warn('[peerManager] PING send failed', conn.peer, err);
          }
        }
      });
    }, PING_INTERVAL_MS);
  }

  private stopHeartbeatBroadcast() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private touchHeartbeat() {
    if (this.heartbeatWatchdog) clearTimeout(this.heartbeatWatchdog);
    this.heartbeatWatchdog = setTimeout(() => {
      this.heartbeatWatchdog = null;
      console.warn('[peerManager] host heartbeat lost');
      this.onHostConnectionLost();
    }, PING_TIMEOUT_MS);
  }

  private stopHeartbeatWatchdog() {
    if (this.heartbeatWatchdog) {
      clearTimeout(this.heartbeatWatchdog);
      this.heartbeatWatchdog = null;
    }
  }

  // ─── Reconnect / Migration ───────────────────────────────────────────────
  // Two triggers converge here:
  //   1. Heartbeat watchdog fired (no data for PING_TIMEOUT_MS).
  //   2. DataConnection `close` event (WebRTC-detected, typically much slower).
  // Option A: try one quick probe to the old host's well-known ID (covers
  // transient network blips); on failure, migrate.
  private async onHostConnectionLost() {
    if (this.intentionalLeave) return;
    if (this.isHost) return;
    if (this.reconnecting) return;
    this.reconnecting = true;

    const roomId = usePokerStore.getState().roomId;
    if (!roomId) {
      this.reconnecting = false;
      return;
    }

    this.stopHeartbeatWatchdog();
    usePokerStore.getState().setConnectionStatus('reconnecting');

    // Option A — single quick probe of the old host's well-known ID.
    try {
      console.log('[peerManager] onHostConnectionLost: probing well-known ID');
      await this.joinViaHost(`${PEER_PREFIX}${roomId}`, {
        timeoutMs: WELL_KNOWN_PROBE_TIMEOUT_MS,
      });
      console.log('[peerManager] well-known probe succeeded (transient blip)');
      this.reconnecting = false;
      return;
    } catch (err) {
      console.log('[peerManager] well-known probe failed, starting migration:', err);
    }

    await this.handleHostDisconnect();
    this.reconnecting = false;
  }

  // Graceful-leave counterpart: leaving host broadcast HOST_LEAVING with an
  // authoritative successor. Skips the Option A probe (we KNOW the old host is
  // gone) and jumps straight to direct-connect-to-successor.
  private async handleHostLeaving(nextHostId: string | null) {
    console.log('[peerManager] received HOST_LEAVING, nextHostId=', nextHostId);

    // ALWAYS record the authoritative successor and ACK the old host,
    // even if a reconnect is already running. `conn.on('close')` can
    // beat the HOST_LEAVING data event on cross-network links; in that
    // case we've already set reconnecting=true via onHostConnectionLost
    // and handleHostDisconnect is about to auto-elect. We need its
    // election to respect the user's chosen successor — `handleHostDisconnect`
    // consults `this.authoritativeSuccessor` before falling back to the
    // oldest-non-host rule. Bug: without this, a UI-chosen successor
    // that isn't the oldest non-host could lose the crown to the auto-
    // elected one, causing the designated player's UI to NOT get the
    // host role (symptom: crown + Reveal/Reset buttons didn't move).
    this.authoritativeSuccessor = nextHostId;
    if (this.hostConnection && this.hostConnection.open) {
      try {
        this.hostConnection.send({ type: 'HOST_LEAVING_ACK' } as Message);
      } catch (err) {
        console.warn('[peerManager] HOST_LEAVING_ACK send failed', err);
      }
    }

    if (this.reconnecting) {
      console.log(
        '[peerManager] handleHostLeaving: reconnect already in flight; saved nextHostId for handleHostDisconnect'
      );
      return;
    }
    this.reconnecting = true;
    this.stopHeartbeatWatchdog();

    try {
      const { playerId, roomId, players } = usePokerStore.getState();
      if (!roomId) return;

      usePokerStore.getState().setConnectionStatus('reconnecting');

      if (!nextHostId) {
        this.authoritativeSuccessor = undefined;
        usePokerStore.getState().pushToast({
          message: i18n.t('toast.roomEmpty'),
          variant: 'info',
        });
        usePokerStore.getState().leaveRoom();
        return;
      }

      if (nextHostId === playerId) {
        this.authoritativeSuccessor = undefined;
        await this.selfPromoteHost(roomId);
        return;
      }

      const successor = players[nextHostId];
      if (!successor) {
        console.warn('[peerManager] HOST_LEAVING: successor not in players map');
        this.authoritativeSuccessor = undefined;
        usePokerStore.getState().leaveRoom();
        return;
      }

      usePokerStore.getState().setMigrationPhase('waiting');
      usePokerStore.getState().pushToast({
        message: i18n.t('toast.hostLeftSwitching', { name: successor.name }),
        variant: 'info',
      });

      this.authoritativeSuccessor = undefined;
      await this.directConnectToSuccessor(successor.peerId, successor.name);
    } finally {
      this.reconnecting = false;
    }
  }

  // Received KICKED from the host. Tear down locally and return to Home
  // without any reconnect attempt. `intentionalLeave = true` stops the
  // broker-reconnect path inside peer.on('disconnected'); clearing
  // reconnecting / migrationAttempted ensures handleHostLeaving /
  // onHostConnectionLost cascades can't re-fire during teardown.
  private handleKicked() {
    console.warn('[peerManager] received KICKED from host, leaving room');
    this.intentionalLeave = true;
    this.reconnecting = false;
    this.migrationAttempted = false;
    this.stopHeartbeatWatchdog();
    usePokerStore.getState().pushToast({
      message: i18n.t('toast.youWereKicked'),
      variant: 'warning',
    });
    usePokerStore.getState().leaveRoom();
    this.destroy();
    this.isHost = false;
  }

  // Unplanned disconnect migration: elect the earliest-joined non-host player
  // as successor. Either self-promote (stay on our current peer ID and reclaim
  // the well-known ID in the background) or direct-connect to successor's
  // original peer ID.
  private async handleHostDisconnect() {
    usePokerStore.getState().setConnectionStatus('reconnecting');

    const state = usePokerStore.getState();
    const { players, playerId, roomId } = state;

    if (!roomId) return;

    if (this.migrationAttempted) {
      console.warn('[peerManager] migration already attempted, leaving room');
      usePokerStore.getState().pushToast({
        message: i18n.t('toast.reclaimFailed'),
        variant: 'error',
      });
      usePokerStore.getState().setMigrationPhase('idle');
      usePokerStore.getState().leaveRoom();
      return;
    }
    this.migrationAttempted = true;

    // If HOST_LEAVING already arrived (possibly after conn.close raced us
    // into this path), prefer its authoritative nextHostId over auto-
    // election. Handles the cross-network case where the user's chosen
    // successor isn't the oldest non-host.
    let nextHost = null;
    if (this.authoritativeSuccessor !== undefined) {
      const saved = this.authoritativeSuccessor;
      this.authoritativeSuccessor = undefined;
      if (saved === null) {
        console.log('[peerManager] authoritative HOST_LEAVING: no successor — leaving room');
        usePokerStore.getState().pushToast({
          message: i18n.t('toast.roomEmpty'),
          variant: 'info',
        });
        usePokerStore.getState().leaveRoom();
        return;
      }
      nextHost = players[saved] ?? null;
      if (nextHost) {
        console.log('[peerManager] using authoritative successor from HOST_LEAVING:', nextHost.name);
      }
    }

    if (!nextHost) {
      const activePlayers = Object.values(players).sort((a, b) => a.joinedAt - b.joinedAt);
      // Exclude the dropped host so we don't elect them again.
      const candidates = activePlayers.filter((p) => p.id !== state.hostId);
      nextHost = candidates[0] ?? null;
    }

    if (!nextHost) {
      console.log('[peerManager] no candidates, leaving room');
      usePokerStore.getState().pushToast({
        message: i18n.t('toast.roomEmpty'),
        variant: 'info',
      });
      usePokerStore.getState().leaveRoom();
      return;
    }

    if (nextHost.id === playerId) {
      console.log('[peerManager] self-promoting to host (stay on current peer ID)');
      await this.selfPromoteHost(roomId);
      return;
    }

    // Someone else is the new host. Direct-connect to their original peer ID
    // — no need to wait for well-known ID reclaim.
    console.log('[peerManager] direct-connecting to new host:', nextHost.name, nextHost.peerId);
    usePokerStore.getState().setMigrationPhase('waiting');
    usePokerStore.getState().pushToast({
      message: i18n.t('toast.hostLeftSwitching', { name: nextHost.name }),
      variant: 'info',
    });

    await this.directConnectToSuccessor(nextHost.peerId, nextHost.name);
  }

  private async directConnectToSuccessor(successorPeerId: string, successorName: string) {
    const roomId = usePokerStore.getState().roomId;
    const wellKnownPeerId = roomId ? `${PEER_PREFIX}${roomId}` : null;
    const start = Date.now();

    // Alternate direct-connect vs well-known so whichever channel opens
    // first wins: direct-connect works as soon as the successor flips
    // isHost=true; well-known works once their background reclaim lands.
    // The successor may briefly reject while still a client, so repeated
    // attempts are normal — don't give up after a handful.
    for (let attempt = 0; ; attempt++) {
      const elapsed = Date.now() - start;
      if (elapsed >= MIGRATION_RECONNECT_BUDGET_MS) break;

      const delay = attempt === 0 ? 0 : Math.min(500 + attempt * 250, 2000);
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      if (!usePokerStore.getState().roomId) return; // user left mid-migration

      const useWellKnown = attempt % 2 === 1 && wellKnownPeerId;
      const target = useWellKnown ? wellKnownPeerId : successorPeerId;
      const label = useWellKnown ? 'well-known' : 'direct';

      try {
        await this.joinViaHost(target!, { timeoutMs: 3000 });
        console.log(`[peerManager] migration reconnect succeeded via ${label}`);
        this.migrationAttempted = false;
        return;
      } catch (err) {
        console.warn(
          `[peerManager] migration attempt ${attempt + 1} (${label}) failed:`,
          err
        );
      }
    }

    console.warn(
      '[peerManager] could not reconnect to successor after budget, entering deadman recovery'
    );
    usePokerStore.getState().pushToast({
      message: i18n.t('toast.failedToConnectHost', { name: successorName }),
      variant: 'warning',
    });
    const currentRoomId = usePokerStore.getState().roomId;
    if (!currentRoomId) return;
    await this.recoverNoHost(currentRoomId);
  }

  /**
   * Deadman recovery — called when nobody ends up as host within the
   * migration budget (typically because HOST_LEAVING was lost across
   * the network before we could ACK it). Each remaining client computes
   * its rank by `joinedAt`; the ex-host / room creator is always rank 0
   * because they joined first, so they self-promote immediately and
   * everyone else staggers. This matches the expectation that the
   * original host is the one who "comes back" when a handoff fails,
   * and the stagger prevents every client from simultaneously claiming
   * host (which would split the room). Later ranks also try one last
   * well-known connect in case a lower rank self-promoted during their
   * wait — only if that fails do they also self-promote (accepting a
   * brief split-brain that the well-known-ID reclaim race will resolve).
   */
  private async recoverNoHost(roomId: string) {
    const state = usePokerStore.getState();
    const sorted = Object.values(state.players).sort((a, b) => a.joinedAt - b.joinedAt);
    const myRank = sorted.findIndex((p) => p.id === state.playerId);
    if (myRank === -1) {
      // Not in the players map anymore (e.g. already kicked). Bail cleanly.
      usePokerStore.getState().setMigrationPhase('idle');
      usePokerStore.getState().leaveRoom();
      return;
    }

    // Rank 0 goes immediately. Every extra rank waits 3 s to give lower
    // ranks a chance to self-promote and reclaim well-known first.
    const staggerDelay = myRank * 3000;
    console.log(
      `[peerManager] recoverNoHost: rank=${myRank}, staggerDelay=${staggerDelay}ms`
    );
    if (staggerDelay > 0) {
      await new Promise((r) => setTimeout(r, staggerDelay));
    }

    // Check whether we were rescued during the wait.
    const latest = usePokerStore.getState();
    if (!latest.roomId) return;
    if (this.isHost) return;
    if (this.hostConnection?.open) return;

    // Non-rank-0: one last attempt at the well-known ID. If an earlier
    // rank self-promoted during our wait, their background reclaim may
    // have opened the secondary peer by now.
    if (myRank > 0) {
      try {
        console.log('[peerManager] recoverNoHost: trying well-known once before self-promote');
        await this.joinViaHost(`${PEER_PREFIX}${roomId}`, { timeoutMs: 3000 });
        this.migrationAttempted = false;
        return;
      } catch (err) {
        console.warn('[peerManager] recoverNoHost: well-known unavailable:', err);
      }
    }

    console.log('[peerManager] recoverNoHost: self-promoting (rank', myRank, ')');
    this.migrationAttempted = false;
    // selfPromoteHost already pushes the `toast.youAreHost` toast.
    await this.selfPromoteHost(roomId);
  }

  /**
   * Promote self to host without changing our peer ID. Other clients can
   * direct-connect to us at the peer ID they already have in their players
   * map. The well-known ID (`scrum-poker-{roomId}`) is reclaimed as a
   * background task for the benefit of future late joiners arriving via
   * `?room=XYZ` — but existing members never wait on it.
   */
  private async selfPromoteHost(roomId: string) {
    const { playerId } = usePokerStore.getState();

    this.isHost = true;
    // We were a client: drop the dead host connection.
    if (this.hostConnection) {
      try {
        this.hostConnection.close();
      } catch {
        /* ignore */
      }
      this.hostConnection = null;
    }
    // Fresh host accepts incoming connections from scratch; previous peer
    // connections to the dead host are irrelevant.
    this.connections.clear();

    this.migrationAttempted = false;
    usePokerStore.getState().updateRoomState({ hostId: playerId });
    usePokerStore.getState().setConnectionStatus('connected');
    usePokerStore.getState().setMigrationPhase('idle');
    usePokerStore.getState().pushToast({
      message: i18n.t('toast.youAreHost'),
      variant: 'success',
    });
    this.startHeartbeatBroadcast();
    this.broadcastState();
    this.scheduleGhostCleanup();

    // Kick off background reclaim of the well-known ID. Doesn't block the UI
    // and doesn't affect existing members — they connect directly.
    this.reclaimWellKnownInBackground(roomId);
  }

  // Background task for a self-promoted host: open a SECONDARY peer at the
  // well-known ID so late joiners via `?room=XYZ` can reach us. The primary
  // peer (at our original random ID) stays untouched, so existing members
  // who direct-connected during migration are never interrupted. Retries
  // with backoff until the PeerJS broker releases the old host's ID.
  private async reclaimWellKnownInBackground(roomId: string) {
    const hostPeerId = `${PEER_PREFIX}${roomId}`;

    for (let i = 0; i < RECLAIM_DELAYS_MS.length; i++) {
      if (!this.isHost) return; // demoted or left — abort
      if (RECLAIM_DELAYS_MS[i] > 0) {
        await new Promise((r) => setTimeout(r, RECLAIM_DELAYS_MS[i]));
      }
      if (!this.isHost) return;

      // Already reclaimed by a previous attempt or createRoom path.
      if (this.wellKnownPeer && !this.wellKnownPeer.destroyed) return;
      if (this.peer && this.peer.id === hostPeerId && !this.peer.destroyed) return;

      try {
        console.log(
          `[peerManager] reclaim attempt ${i + 1}/${RECLAIM_DELAYS_MS.length} for`,
          hostPeerId
        );
        await this.openWellKnownPeer(hostPeerId);
        console.log('[peerManager] well-known ID reclaimed (secondary peer up)');
        return;
      } catch (err) {
        console.warn(
          `[peerManager] reclaim attempt ${i + 1}/${RECLAIM_DELAYS_MS.length} failed:`,
          err
        );
        // Leave `wellKnownPeer` null and loop. Primary peer is unaffected.
      }
    }

    console.warn('[peerManager] could not reclaim well-known ID after all retries');
  }

  // Stand up a secondary Peer at the given ID purely to accept incoming
  // connections (for late joiners). Routes through the same
  // `handleIncomingConnection` so there's no second-class connection.
  private openWellKnownPeer(specificPeerId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.wellKnownPeer) {
        this.wellKnownPeer.removeAllListeners();
        try {
          this.wellKnownPeer.destroy();
        } catch {
          /* ignore */
        }
        this.wellKnownPeer = null;
      }

      const opts = {
        debug: 2,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:global.stun.twilio.com:3478' },
          ],
        },
      };
      const peer = new Peer(specificPeerId, opts);
      this.wellKnownPeer = peer;

      let settled = false;

      peer.on('open', () => {
        if (settled) return;
        settled = true;
        resolve();
      });

      peer.on('connection', (conn) => {
        console.log('[peerManager] incoming on well-known peer from', conn.peer);
        this.handleIncomingConnection(conn);
      });

      peer.on('disconnected', () => {
        // Only attempt reconnect if we still own this peer and it opened.
        if (this.wellKnownPeer !== peer) return;
        if (peer.destroyed) return;
        if (!settled) return;
        console.warn('[peerManager] wellKnownPeer disconnected, reconnecting');
        try {
          peer.reconnect();
        } catch (err) {
          console.error('[peerManager] wellKnownPeer.reconnect() failed:', err);
        }
      });

      peer.on('error', (err) => {
        console.warn('[peerManager] wellKnownPeer error:', err.type, err.message);
        if (settled) return;
        settled = true;
        if (this.wellKnownPeer === peer) {
          try {
            peer.destroy();
          } catch {
            /* ignore */
          }
          this.wellKnownPeer = null;
        }
        reject(err);
      });
    });
  }

  // Arm a one-shot sweep GHOST_CLEANUP_DELAY_MS after a successful self-
  // promote. The per-connection `conn.on('close')` path removes players as
  // they drop; after self-promote our connections map starts empty while the
  // players map retains everyone from the previous host's broadcast —
  // including the crashed old host. Live clients direct-connect back to us
  // and end up in this.connections; anyone still absent when the timer fires
  // was genuinely gone.
  private scheduleGhostCleanup() {
    if (this.ghostCleanupTimer) clearTimeout(this.ghostCleanupTimer);
    this.ghostCleanupTimer = setTimeout(() => {
      this.ghostCleanupTimer = null;
      this.runGhostCleanup();
    }, GHOST_CLEANUP_DELAY_MS);
  }

  private runGhostCleanup() {
    if (!this.isHost) return;
    const state = usePokerStore.getState();
    const activePeerIds = new Set(this.connections.keys());
    const newPlayers = { ...state.players };
    const removed: string[] = [];
    for (const [pid, player] of Object.entries(newPlayers)) {
      if (pid === state.playerId) continue; // never remove self
      if (!activePeerIds.has(player.peerId)) {
        delete newPlayers[pid];
        removed.push(player.name);
      }
    }
    if (removed.length === 0) return;
    console.log('[peerManager] ghost cleanup removing:', removed);
    usePokerStore.getState().updateRoomState({ players: newPlayers });
    removed.forEach((name) => {
      usePokerStore.getState().pushToast({
        message: i18n.t('toast.playerOffline', { name }),
        variant: 'warning',
      });
    });
    this.broadcastState();
  }

  // Broadcast HOST_LEAVING to every open connection and wait for each
  // client to ACK before resolving. Without the ACK step, a too-short
  // pre-destroy delay was losing HOST_LEAVING across cross-network
  // DataChannels — the SCTP send queue gets dropped when the peer is
  // destroyed, and a 50 ms flush can't outrun RTTs of 100–500 ms.
  // Returns once every connection has ack'd OR after the timeout,
  // whichever is first. Callers should treat the timeout as "best
  // effort" — any client that didn't ACK will have to fall back to the
  // unplanned-disconnect path, which is why the deadman recovery in
  // `recoverNoHost` is also needed.
  private async broadcastHostLeavingAndWait(nextHostId: string | null): Promise<void> {
    const msg: Message = { type: 'HOST_LEAVING', payload: { nextHostId } };
    const pending: Array<Promise<void>> = [];

    this.connections.forEach((conn) => {
      if (!conn.open) return;
      // Per-connection ACK waiter. Attaches a transient data listener
      // that resolves on HOST_LEAVING_ACK; self-cleans on resolve or
      // timeout so we don't leave orphan listeners on the DataConnection.
      const waiter = new Promise<void>((resolve) => {
        let settled = false;
        const cleanup = () => {
          try {
            conn.off('data', onData);
          } catch {
            /* ignore */
          }
          try {
            conn.off('close', onClose);
          } catch {
            /* ignore */
          }
        };
        const onData = (raw: unknown) => {
          const data = raw as Message;
          if (data?.type === 'HOST_LEAVING_ACK') {
            if (settled) return;
            settled = true;
            cleanup();
            resolve();
          }
        };
        // The designated successor may self-promote via the eager
        // STATE_UPDATE broadcast (see transferHost) and close their
        // hostConnection BEFORE we send HOST_LEAVING. In that case
        // they're already acting as host, so there's no ACK coming —
        // treat close as an implicit acknowledgement to avoid waiting
        // the full ACK_TIMEOUT for the one client who already knows.
        const onClose = () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        };
        conn.on('data', onData);
        conn.on('close', onClose);
        setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          console.warn('[peerManager] HOST_LEAVING_ACK timeout for', conn.peer);
          resolve();
        }, HOST_LEAVING_ACK_TIMEOUT_MS);
      });
      pending.push(waiter);

      try {
        conn.send(msg);
      } catch (err) {
        console.warn('[peerManager] HOST_LEAVING send failed for', conn.peer, err);
      }
    });

    if (pending.length === 0) return;
    await Promise.all(pending);
    // Small settle so the underlying OS buffer can flush even after SCTP
    // acks the ACK message itself. Belt-and-braces against tight races.
    await new Promise((r) => setTimeout(r, HOST_LEAVING_SETTLE_MS));
  }

  // Manual host transfer. Reuses the HOST_LEAVING flow — new host's client
  // logic (selfPromoteHost) is identical to graceful leave. Difference: the
  // demoting host stays in the room as a client, direct-connecting to the
  // new host's original peer ID (no reliance on reclaim).
  private async transferHost(newHostId: string) {
    const state = usePokerStore.getState();
    const newHost = state.players[newHostId];
    const roomId = state.roomId;
    if (!newHost || !roomId) return;

    // Eagerly rotate `state.hostId` to the designated successor AND push
    // a STATE_UPDATE broadcast BEFORE the HOST_LEAVING handshake. Two
    // reasons:
    //   1. Our own UI immediately reflects the hand-off — the crown and
    //      the Reveal/Reset buttons move off us the moment we click the
    //      make-host confirm, without waiting for us to reconnect to the
    //      new host.
    //   2. All clients that are still connected to us receive the
    //      updated hostId through the existing broadcast channel, so
    //      even if the downstream HOST_LEAVING packet is lost before
    //      SCTP delivers it (cross-network worst case), their UI is
    //      already correct. The new host's own STATE_UPDATE data
    //      handler will also observe `hostId === my playerId` and
    //      self-promote — see the joinViaHost data handler.
    // NOTE: peerManager.isHost is still true at this point; we demote
    // only after the ACK wait below. This is deliberate — the P2P layer
    // must stay "hosting" until we're ready to tear down, even though
    // the UI layer has already rotated.
    usePokerStore.getState().updateRoomState({ hostId: newHostId });
    this.broadcastState();

    // Announce successor to every client and WAIT until each has ack'd
    // (or the per-connection timeout fires). This is the critical fix
    // for 4+ player cross-network transfers where the old 50 ms flush
    // couldn't outrun real-world RTT.
    await this.broadcastHostLeavingAndWait(newHostId);

    // Demote: stop hosting but KEEP our current peer alive so we can
    // immediately act as a client connecting to the new host. If our peer
    // happens to be the well-known one (normal case — we were the host),
    // release it so the new host's background reclaim can eventually take it.
    this.isHost = false;
    this.stopHeartbeatBroadcast();
    this.connections.forEach((conn) => {
      try {
        conn.close();
      } catch {
        /* ignore */
      }
    });
    this.connections.clear();

    // Release any well-known-ID peer we're holding (primary or secondary)
    // so the new host can reclaim it. The primary peer stays alive IF it's
    // a random-ID peer, so we can keep using it as the client that
    // direct-connects to the new host — no reinit round-trip needed.
    const hostPeerId = `${PEER_PREFIX}${roomId}`;
    if (this.wellKnownPeer) {
      this.wellKnownPeer.removeAllListeners();
      try {
        this.wellKnownPeer.destroy();
      } catch {
        /* ignore */
      }
      this.wellKnownPeer = null;
    }
    if (this.peer && this.peer.id === hostPeerId) {
      this.intentionalLeave = true;
      this.destroy();
      this.intentionalLeave = false;
    }

    usePokerStore.getState().setMigrationPhase('waiting');
    usePokerStore.getState().pushToast({
      message: i18n.t('toast.hostLeftSwitching', { name: newHost.name }),
      variant: 'info',
    });

    // Direct-connect to the new host's original peer ID. They've already
    // flipped isHost = true on their side (via HOST_LEAVING handler) and are
    // ready to accept us.
    await this.directConnectToSuccessor(newHost.peerId, newHost.name);
  }

  // Teardown used internally (e.g. before reinitializing a peer inside init()).
  // Must NOT reset isHost: createRoom sets isHost=true BEFORE awaiting init(),
  // and resetting it here would undo that race fix and cause the host to
  // reject every incoming connection. Role transitions are the caller's
  // responsibility (createRoom/joinRoom/selfPromoteHost set their own role).
  destroy() {
    if (this.peer) {
      // Drop our event subscriptions BEFORE tearing the peer down.
      // Otherwise peer.destroy() emits 'disconnected' / 'close' while we
      // still have handlers attached, and peer.reconnect() there would
      // keep the old peer ID alive on the broker — blocking any
      // successor from reclaiming it during migration.
      this.peer.removeAllListeners();
      this.peer.destroy();
      this.peer = null;
    }
    if (this.wellKnownPeer) {
      this.wellKnownPeer.removeAllListeners();
      this.wellKnownPeer.destroy();
      this.wellKnownPeer = null;
    }
    this.connections.clear();
    this.hostConnection = null;
    this.stopHeartbeatBroadcast();
    this.stopHeartbeatWatchdog();
  }

  // User-initiated leave. Cancels any pending reconnect and tears everything
  // down, including the role flag. Call this from the UI's "Leave Room"
  // button instead of destroy().
  leave() {
    this.intentionalLeave = true;
    this.reconnecting = false;
    this.migrationAttempted = false;
    this.authoritativeSuccessor = undefined;
    this.kickedUntil.clear();
    if (this.ghostCleanupTimer) {
      clearTimeout(this.ghostCleanupTimer);
      this.ghostCleanupTimer = null;
    }

    // Graceful host handoff: before destroying, tell every client who the
    // designated successor is. The leaving host is the authoritative
    // decider — clients do not recompute. Computed using the same
    // joinedAt-sorted rule as the unplanned-disconnect migration path.
    if (this.isHost && this.connections.size > 0) {
      const state = usePokerStore.getState();
      const candidates = Object.values(state.players)
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .filter((p) => p.id !== state.hostId);
      const nextHostId = candidates[0]?.id ?? null;

      // Fire the ACK-gated broadcast in the background — the UI has
      // already flipped to Home via leaveRoom(), so we don't need to
      // block on the teardown. The important thing is that destroy()
      // doesn't run until clients have acknowledged (or the per-
      // connection timeout fires).
      void this.broadcastHostLeavingAndWait(nextHostId).finally(() => {
        this.destroy();
        this.isHost = false;
      });
      return;
    }

    this.destroy();
    this.isHost = false;
  }
}

export const peerManager = new PeerManager();
