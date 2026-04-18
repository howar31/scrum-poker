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
  // Host → clients. Full-state snapshot; also serves as the heartbeat (sent
  // every HEARTBEAT_INTERVAL_MS or whenever state changes). The payload's
  // `epoch` is authoritative — clients reject messages with an older epoch.
  | { type: 'STATE'; payload: RoomState }
  // Client → host. The envelope carries the client's last-seen epoch; the
  // host drops actions that don't match the current epoch (except JOIN,
  // which is always welcome because it may be a reconnection).
  | { type: 'ACTION'; epoch: number; payload: Action }
  // Host → clients. Graceful-leave / transfer signal. Clients save the
  // successor ID and wait for their hostConnection to close; then the
  // recovery flow decides whether to try to become host (broker-arbitrated)
  // or wait passively for someone else to.
  | { type: 'LEAVING'; epoch: number; nextHostId: string | null }
  // Host → one client. Pre-close notification so the client tears down
  // locally without the auto-reconnect loop popping them right back in.
  | { type: 'KICKED'; epoch: number };

type FsmState = 'IDLE' | 'HOSTING' | 'FOLLOWING' | 'ELECTING' | 'FOLLOWING_WAIT';

const PEER_PREFIX = 'scrum-poker-';

// Host broadcasts a STATE snapshot every HEARTBEAT_INTERVAL_MS. Clients reset
// a rolling watchdog on any inbound data, so a busy host naturally suppresses
// the tick rate and a silent host is detected in a bounded window.
const HEARTBEAT_INTERVAL_MS = 2000;
const HEARTBEAT_TIMEOUT_MS = 8000;

// Total window spent in ELECTING or FOLLOWING_WAIT before giving up and
// leaving the room. Graceful leave typically settles in ~5-10 s (broker
// releases the ID quickly once the SCTP FIN lands); dirty crash can take up
// to the PeerJS broker `alive_timeout` (~60 s) to release the well-known ID.
// 60 s covers the full worst case. Shorter would give up too eagerly on
// dirty-crash conditions and force users to manually rejoin even though
// the room would have converged.
const MIGRATION_BUDGET_MS = 60000;
// Per-iteration timeouts for the migration loop.
const OPEN_PEER_TIMEOUT_MS = 3000;
const CONNECT_TIMEOUT_MS = 2500;
const MIGRATION_RETRY_INTERVAL_MS = 1000;
// Non-electors wait this long before trying to become host themselves.
// Covers the time for the designated successor (or rank 0) to:
//   (a) receive LEAVING / conn-close
//   (b) run their ELECTING loop
//   (c) successfully open the well-known ID on the broker
// If the grace expires without a winner, Phase B kicks in and EVERYONE
// races for the ID — broker arbitration still guarantees a single host.
const MIGRATION_GRACE_MS = 10000;
// In Phase B, stagger by rank so the oldest-joined surviving player
// attempts ELECTING first. Broker arbitration makes this optional for
// correctness (only one can win), but preferring rank 0 matches the
// user's expectation that the original host / earliest joiner is the
// natural fallback.
const RANK_STAGGER_MS = 2000;

// After sending LEAVING we wait briefly before destroying the peer so the
// SCTP send queue can flush across any still-open DataChannels.
const LEAVING_FLUSH_MS = 300;

// Kick reject window — brief so manual rejoin later still works, but long
// enough to outlast the kicked client's auto-reconnect cycle.
const KICK_REJECT_WINDOW_MS = 5000;
const KICK_MESSAGE_FLUSH_MS = 200;

// After becomeHost the connections map is empty while the players map retains
// everyone from the previous STATE broadcast. Live clients direct-connect
// back during FOLLOWING_WAIT; anyone still absent when this timer fires is
// swept as a ghost.
const GHOST_CLEANUP_DELAY_MS = 20000;

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
  /** Optional hard cap. Omit for "keep trying until cancel or success". */
  maxDurationMs?: number;
  onProgress?: (progress: JoinRetryProgress, elapsedMs: number) => void;
}

function isPeerUnavailable(err: unknown): boolean {
  const e = err as { type?: string; message?: string } | undefined;
  return (
    e?.type === 'peer-unavailable' ||
    (typeof e?.message === 'string' &&
      e.message.toLowerCase().includes('could not connect to peer'))
  );
}

function isUnavailableId(err: unknown): boolean {
  const e = err as { type?: string; message?: string } | undefined;
  return (
    e?.type === 'unavailable-id' ||
    (typeof e?.message === 'string' &&
      (e.message.toLowerCase().includes('id is taken') ||
        e.message.toLowerCase().includes('unavailable')))
  );
}

/**
 * PeerManager
 * -----------
 * A 5-state finite state machine over PeerJS. Exactly one mechanism decides
 * who hosts a room: whoever successfully opens the well-known peer ID
 * `scrum-poker-{roomId}` on the PeerJS broker. The broker permits exactly
 * one owner per ID and returns `unavailable-id` to everyone else, so split-
 * brain is structurally impossible.
 *
 * States:
 *   IDLE               — not in a room
 *   HOSTING            — own the well-known peer; heartbeat runs
 *   FOLLOWING          — connected to the host via well-known peer
 *   ELECTING           — watchdog fired and I'm rank 0; trying to open well-known
 *   FOLLOWING_WAIT     — watchdog fired and I'm rank ≥ 1; polling for the winner
 *
 * Host identity invariant (H2): the peer owning `scrum-poker-{roomId}` is
 * the host. No secondary peers, no random-ID hosts. Epoch counter (H1)
 * monotonically increases on each host change so stale messages can be
 * dropped deterministically.
 */
class PeerManager {
  private fsm: FsmState = 'IDLE';
  private peer: Peer | null = null;
  // Client-side: our DataConnection to the host.
  private hostConnection: DataConnection | null = null;
  // Host-side: peerId → incoming DataConnection.
  private connections: Map<string, DataConnection> = new Map();

  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatWatchdog: ReturnType<typeof setTimeout> | null = null;
  private ghostCleanupTimer: ReturnType<typeof setTimeout> | null = null;

  // Set when LEAVING{ nextHostId } arrives; consumed on host-connection loss.
  //   undefined = no LEAVING received → auto-elect rank 0
  //   null      = LEAVING received with no successor → room is closing
  //   string    = LEAVING designated this playerId as successor
  private designatedSuccessor: string | null | undefined = undefined;

  // Set true by leave() / kick-received to suppress the broker-reconnect path
  // inside peer.on('disconnected') and the migration handlers.
  private intentionalLeave = false;

  // Host-side: playerIds that were recently kicked → expiry timestamp.
  // Short-lived rejection window so the client's auto-reconnect can't pop
  // them right back in; manual re-join after the window works normally.
  private kickedUntil: Map<string, number> = new Map();

  // Set while a migration is running to prevent concurrent re-entry from
  // watchdog + conn.close triggering two paths at once.
  private migrating = false;

  // ─── Peer lifecycle ────────────────────────────────────────────────────────

  private peerOpts() {
    return {
      debug: 2,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:global.stun.twilio.com:3478' },
        ],
      },
    };
  }

  /**
   * Open a Peer with the given ID (or random if omitted). Installs broker
   * reconnect + error-as-toast post-open. Rejects on error-before-open or
   * open-timeout.
   */
  private openPeer(specificId?: string, timeoutMs = 10000): Promise<Peer> {
    return new Promise((resolve, reject) => {
      console.log('[peerManager] openPeer, specificId=', specificId ?? '(auto)');
      const peer = specificId
        ? new Peer(specificId, this.peerOpts())
        : new Peer(this.peerOpts());

      let hasOpened = false;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          peer.destroy();
        } catch {
          /* ignore */
        }
        reject(new Error(i18n.t('errors.peerInitFailed')));
      }, timeoutMs);

      peer.on('open', (id) => {
        console.log('[peerManager] peer open, id=', id);
        hasOpened = true;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(peer);
        } else {
          // Re-open after peer.reconnect(); restore the green dot.
          usePokerStore.getState().setConnectionStatus('connected');
        }
      });

      peer.on('error', (err) => {
        console.error('[peerManager] peer error:', err.type, err.message);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          try {
            peer.destroy();
          } catch {
            /* ignore */
          }
          reject(err);
          return;
        }
        // Post-open errors surface as toasts (usually stale signaling events
        // after a blip). Don't persist — they auto-dismiss.
        usePokerStore.getState().pushToast({ message: err.message, variant: 'error' });
      });

      peer.on('disconnected', () => {
        if (peer.destroyed) return;
        if (!hasOpened) return;
        if (this.intentionalLeave) {
          console.warn('[peerManager] peer disconnected (intentional, skipping reconnect)');
          return;
        }
        if (this.peer !== peer) return;
        console.warn('[peerManager] peer disconnected from broker, reconnecting');
        usePokerStore.getState().setConnectionStatus('reconnecting');
        try {
          peer.reconnect();
        } catch (err) {
          console.error('[peerManager] peer.reconnect() failed:', err);
        }
      });

      peer.on('connection', (conn) => {
        console.log('[peerManager] incoming connection from', conn.peer);
        this.handleIncomingConnection(conn);
      });

      peer.on('close', () => {
        console.warn('[peerManager] peer closed');
      });
    });
  }

  private destroyPeer() {
    if (this.peer) {
      // Drop handlers BEFORE destroy so peer.destroy()'s 'disconnected'
      // emission doesn't spuriously call peer.reconnect() during teardown —
      // that would hold the peer ID on the broker and block migration.
      this.peer.removeAllListeners();
      try {
        this.peer.destroy();
      } catch {
        /* ignore */
      }
      this.peer = null;
    }
  }

  private destroyAll() {
    this.stopHeartbeat();
    this.stopWatchdog();
    this.stopGhostCleanup();
    if (this.hostConnection) {
      try {
        this.hostConnection.close();
      } catch {
        /* ignore */
      }
      this.hostConnection = null;
    }
    this.connections.forEach((c) => {
      try {
        c.close();
      } catch {
        /* ignore */
      }
    });
    this.connections.clear();
    this.destroyPeer();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  async createRoom() {
    this.resetRoomFlags();
    const { playerId, playerName } = usePokerStore.getState();
    const roomId = generateRoomId();
    const hostPeerId = `${PEER_PREFIX}${roomId}`;

    try {
      this.peer = await this.openPeer(hostPeerId);
    } catch (err) {
      console.error('[peerManager] createRoom: peer init failed', err);
      this.fsm = 'IDLE';
      throw err;
    }

    this.fsm = 'HOSTING';
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
      epoch: 1,
    });
    usePokerStore.getState().setConnectionStatus('connected');
    this.startHeartbeat();
    console.log('[peerManager] createRoom: ready, roomId=', roomId);
  }

  async joinRoom(roomId: string): Promise<void> {
    this.resetRoomFlags();
    return this.joinAsClient(`${PEER_PREFIX}${roomId}`, { timeoutMs: 20000 });
  }

  /**
   * Home.tsx join flow. Keep retrying until we join, the caller cancels, or
   * an optional maxDurationMs window elapses. Distinguishes `peer-unavailable`
   * (room may not exist or broker released during migration) from timeout
   * (broker has the ID but it's unreachable — migration likely in progress)
   * so the UI can message accordingly.
   */
  joinRoomWithRetry(roomId: string, opts: JoinRetryOptions): JoinRetryHandle {
    let cancelled = false;
    const hostPeerId = `${PEER_PREFIX}${roomId}`;

    const promise = (async () => {
      this.resetRoomFlags();
      const start = Date.now();
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
          await this.joinAsClient(hostPeerId, { timeoutMs: 5000 });
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
        this.destroyAll();
      },
      promise,
    };
  }

  leave() {
    this.intentionalLeave = true;
    this.kickedUntil.clear();
    this.stopGhostCleanup();

    if (this.fsm === 'HOSTING') {
      // Compute oldest non-host as graceful successor.
      const state = usePokerStore.getState();
      const candidates = Object.values(state.players)
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .filter((p) => p.id !== state.hostId);
      const nextHostId = candidates[0]?.id ?? null;
      this.broadcastLeaving(nextHostId);
      // Flush then destroy. Clients that miss the LEAVING fall back to the
      // watchdog + rank-0 recovery path, which converges on the same outcome.
      setTimeout(() => {
        this.destroyAll();
      }, LEAVING_FLUSH_MS);
    } else {
      this.destroyAll();
    }

    this.fsm = 'IDLE';
    this.migrating = false;
  }

  sendAction(action: Action) {
    if (this.fsm === 'HOSTING') {
      this.processAction(action);
    } else if (this.fsm === 'FOLLOWING' && this.hostConnection?.open) {
      const epoch = usePokerStore.getState().epoch;
      try {
        this.hostConnection.send({ type: 'ACTION', epoch, payload: action } as Message);
      } catch (err) {
        console.warn('[peerManager] ACTION send failed', err);
      }
    }
  }

  // ─── Reset helpers ─────────────────────────────────────────────────────────

  private resetRoomFlags() {
    this.intentionalLeave = false;
    this.designatedSuccessor = undefined;
    this.kickedUntil.clear();
    this.migrating = false;
  }

  // ─── Join as client ────────────────────────────────────────────────────────

  /**
   * Open a DataConnection to the host's well-known peer and send JOIN.
   * Resolves on the first STATE received. On success `fsm` moves to
   * FOLLOWING. On failure the caller decides what to do next.
   */
  private async joinAsClient(
    hostPeerId: string,
    opts: { timeoutMs: number }
  ): Promise<void> {
    // Ensure we have a local peer at a random ID.
    if (!this.peer || this.peer.destroyed) {
      this.peer = await this.openPeer();
    }
    const peer = this.peer;

    // Close any lingering hostConnection.
    if (this.hostConnection) {
      try {
        this.hostConnection.close();
      } catch {
        /* ignore */
      }
      this.hostConnection = null;
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        peer.off('error', onPeerError);
        fn();
      };

      const onPeerError = (err: { type?: string; message?: string }) => {
        console.error('[peerManager] joinAsClient peer error:', err.type, err.message);
        const e = new Error(err.message ?? i18n.t('errors.peerError'));
        (e as Error & { type?: string }).type = err.type;
        settle(() => reject(e));
      };
      peer.on('error', onPeerError);

      const timer = setTimeout(() => {
        const baseMsg = i18n.t('errors.connectionTimeout');
        const arcHint = isArcBrowser() ? i18n.t('errors.arcHint') : '';
        const e = new Error(baseMsg + arcHint);
        (e as Error & { type?: string }).type = 'timeout';
        settle(() => reject(e));
      }, opts.timeoutMs);

      const conn = peer.connect(hostPeerId, { serialization: 'json' });
      this.hostConnection = conn;
      console.log(
        '[peerManager] joinAsClient: my peerId=',
        peer.id,
        'connecting to',
        hostPeerId
      );

      conn.on('error', (err) => {
        console.error('[peerManager] joinAsClient conn error:', err);
        settle(() => reject(err));
      });

      conn.on('close', () => {
        console.warn('[peerManager] joinAsClient conn closed (settled=', settled, ')');
        if (!settled) {
          settle(() => reject(new Error(i18n.t('errors.closedBeforeJoining'))));
          return;
        }
        // Previously open; fall into migration flow.
        this.stopWatchdog();
        this.onHostConnectionLost();
      });

      conn.on('iceStateChanged', (state) => {
        console.log('[peerManager] joinAsClient ICE state =', state);
      });

      conn.on('data', (raw) => {
        this.touchWatchdog();
        const msg = raw as Message;
        if (!msg || typeof msg !== 'object') return;
        this.handleClientMessage(msg, () => {
          // Called on every STATE. Only do the "first STATE of this join"
          // work once — subsequent STATEs must NOT clear designatedSuccessor
          // (a LEAVING might have arrived between two heartbeats and we need
          // to honor it when the hostConnection drops).
          if (settled) return;
          this.fsm = 'FOLLOWING';
          this.designatedSuccessor = undefined;
          this.migrating = false;
          usePokerStore.getState().setMigrationPhase('idle');
          settle(() => resolve());
        });
      });

      const setupConnection = () => {
        console.log('[peerManager] joinAsClient: conn.open, sending JOIN');
        usePokerStore.getState().setConnectionStatus('connected');
        const { playerId, playerName, epoch } = usePokerStore.getState();
        try {
          conn.send({
            type: 'ACTION',
            epoch,
            payload: {
              type: 'JOIN',
              payload: { id: playerId, name: playerName, peerId: peer.id },
            },
          } as Message);
        } catch (err) {
          console.warn('[peerManager] JOIN send failed', err);
        }
      };
      if (conn.open) setupConnection();
      else conn.on('open', setupConnection);
    });
  }

  /**
   * Process an inbound message on the client's hostConnection. Fires
   * `onStateReceived` on the first STATE we accept so joinAsClient can
   * settle its promise.
   */
  private handleClientMessage(msg: Message, onStateReceived: () => void) {
    const localEpoch = usePokerStore.getState().epoch;
    switch (msg.type) {
      case 'STATE': {
        const payload = msg.payload;
        if (!payload || typeof payload.epoch !== 'number') return;
        if (payload.epoch < localEpoch) {
          console.warn(
            '[peerManager] dropping stale STATE, epoch=',
            payload.epoch,
            'local=',
            localEpoch
          );
          return;
        }
        usePokerStore.getState().updateRoomState(payload);
        onStateReceived();
        break;
      }
      case 'LEAVING': {
        if (msg.epoch < localEpoch) return;
        console.log('[peerManager] received LEAVING, nextHostId=', msg.nextHostId);
        this.designatedSuccessor = msg.nextHostId;
        break;
      }
      case 'KICKED': {
        // Drop stale KICKED from a prior host epoch. Without this guard
        // a buffered message from the previous host could fire AFTER we
        // migrated to a newer epoch (e.g. the old host kicked us then
        // crashed, client queued the 'data' event, watchdog fired, we
        // became host via ELECTING — the buffered KICKED then arrives
        // on the closed old hostConnection's listener and wrongly tears
        // down our now-hosting peer, evicting the whole room).
        if (msg.epoch < localEpoch) {
          console.warn(
            '[peerManager] dropping stale KICKED, epoch=',
            msg.epoch,
            'local=',
            localEpoch
          );
          return;
        }
        console.warn('[peerManager] received KICKED');
        this.handleKicked();
        break;
      }
      default:
        break;
    }
  }

  // ─── Host side ─────────────────────────────────────────────────────────────

  private handleIncomingConnection(conn: DataConnection) {
    if (this.fsm !== 'HOSTING') {
      console.warn('[peerManager] not hosting, rejecting incoming from', conn.peer);
      try {
        conn.close();
      } catch {
        /* ignore */
      }
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
      if (!data) return;
      if (data.type === 'ACTION') {
        const localEpoch = usePokerStore.getState().epoch;
        // Drop stale actions EXCEPT JOIN — a reconnecting client may have
        // an older epoch until they receive our next STATE.
        if (data.epoch < localEpoch && data.payload.type !== 'JOIN') {
          console.warn(
            '[peerManager] dropping stale ACTION',
            data.payload.type,
            'epoch=',
            data.epoch
          );
          return;
        }
        this.processAction(data.payload, conn);
      }
    });

    conn.on('close', () => {
      console.warn('[peerManager] incoming closed', conn.peer);
      this.connections.delete(conn.peer);
      const state = usePokerStore.getState();
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
    if (this.fsm !== 'HOSTING') return;

    const state = usePokerStore.getState();
    const newPlayers = { ...state.players };

    switch (action.type) {
      case 'JOIN': {
        const kickUntil = this.kickedUntil.get(action.payload.id);
        if (kickUntil !== undefined) {
          if (Date.now() < kickUntil) {
            console.log(
              '[peerManager] rejecting JOIN from recently kicked',
              action.payload.id
            );
            if (sourceConn && sourceConn.open) {
              try {
                sourceConn.send({
                  type: 'KICKED',
                  epoch: state.epoch,
                } as Message);
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
        usePokerStore
          .getState()
          .updateRoomState({ players: newPlayers, isRevealed: false });
        break;
      case 'KICK': {
        const kickPeerId = newPlayers[action.payload.id]?.peerId;
        delete newPlayers[action.payload.id];
        usePokerStore.getState().updateRoomState({ players: newPlayers });
        this.kickedUntil.set(action.payload.id, Date.now() + KICK_REJECT_WINDOW_MS);
        if (kickPeerId) {
          const connToKick = this.connections.get(kickPeerId);
          // Remove from map BEFORE the trailing broadcastState so the kicked
          // client can't race a STATE that puts them back into the Room UI.
          this.connections.delete(kickPeerId);
          if (connToKick && connToKick.open) {
            try {
              connToKick.send({
                type: 'KICKED',
                epoch: state.epoch,
              } as Message);
            } catch (err) {
              console.warn('[peerManager] KICKED send failed', err);
            }
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
        // Fire-and-forget: transfer is async but the action message shouldn't
        // block the broadcast cycle.
        void this.transferHost(action.payload.id);
        return;
    }

    this.broadcastState();
  }

  private broadcastState() {
    if (this.fsm !== 'HOSTING') return;
    const { roomId, hostId, players, isRevealed, epoch } = usePokerStore.getState();
    const msg: Message = {
      type: 'STATE',
      payload: { roomId, hostId, players, isRevealed, epoch },
    };
    this.connections.forEach((conn) => {
      if (conn.open) {
        try {
          conn.send(msg);
        } catch (err) {
          console.warn('[peerManager] STATE send failed', conn.peer, err);
        }
      }
    });
  }

  private broadcastLeaving(nextHostId: string | null) {
    if (this.fsm !== 'HOSTING') return;
    const epoch = usePokerStore.getState().epoch;
    const msg: Message = { type: 'LEAVING', epoch, nextHostId };
    this.connections.forEach((conn) => {
      if (conn.open) {
        try {
          conn.send(msg);
        } catch (err) {
          console.warn('[peerManager] LEAVING send failed', conn.peer, err);
        }
      }
    });
  }

  // ─── Heartbeat ────────────────────────────────────────────────────────────

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.fsm !== 'HOSTING') return;
      this.broadcastState();
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private touchWatchdog() {
    if (this.heartbeatWatchdog) clearTimeout(this.heartbeatWatchdog);
    this.heartbeatWatchdog = setTimeout(() => {
      this.heartbeatWatchdog = null;
      console.warn('[peerManager] host heartbeat lost');
      this.onHostConnectionLost();
    }, HEARTBEAT_TIMEOUT_MS);
  }

  private stopWatchdog() {
    if (this.heartbeatWatchdog) {
      clearTimeout(this.heartbeatWatchdog);
      this.heartbeatWatchdog = null;
    }
  }

  // ─── Migration ────────────────────────────────────────────────────────────

  /**
   * Called when the host connection drops (watchdog timeout or DataConnection
   * close). Hands off to runMigration — a single loop that both tries to
   * become host AND tries to connect to the winner, driven by broker
   * arbitration at the well-known ID.
   */
  private onHostConnectionLost() {
    if (this.intentionalLeave) return;
    if (this.fsm === 'HOSTING') return;
    if (this.fsm === 'IDLE') return;
    if (this.migrating) return;
    this.migrating = true;

    const state = usePokerStore.getState();
    const roomId = state.roomId;
    if (!roomId) {
      this.migrating = false;
      return;
    }

    this.stopWatchdog();
    usePokerStore.getState().setConnectionStatus('reconnecting');

    if (this.designatedSuccessor === null) {
      // LEAVING{null} explicitly said the room is closing with no successor.
      console.log('[peerManager] LEAVING(null) — room closing, leaving');
      usePokerStore.getState().pushToast({
        message: i18n.t('toast.roomEmpty'),
        variant: 'info',
      });
      this.destroyAll();
      this.fsm = 'IDLE';
      this.migrating = false;
      usePokerStore.getState().setMigrationPhase('idle');
      usePokerStore.getState().leaveRoom();
      return;
    }

    void this.runMigration(roomId);
  }

  /**
   * Single migration loop. Each iteration tries to (1) become host by
   * opening the well-known peer, then (2) connect to whoever owns it as
   * a client. Broker arbitration guarantees exactly one success at step 1
   * across all concurrent callers, so split-brain is structurally
   * impossible.
   *
   * Electors (designated successor, or rank 0 when no LEAVING was
   * received) attempt step 1 immediately. Non-electors sit on step 2 only
   * for MIGRATION_GRACE_MS — long enough for the elector to succeed under
   * normal conditions. If the grace expires without convergence (e.g. the
   * designated successor crashed mid-flip), non-electors unlock step 1 as
   * well and everyone races. Whoever wins the broker race becomes host;
   * everyone else is a client of theirs.
   */
  private async runMigration(roomId: string) {
    const wellKnownId = `${PEER_PREFIX}${roomId}`;
    const start = Date.now();
    const { iAmElector, rank } = this.decideElectorInfo();
    const mayElectAfter = iAmElector
      ? start
      : start + MIGRATION_GRACE_MS + rank * RANK_STAGGER_MS;

    console.log(
      '[peerManager] runMigration start, iAmElector=',
      iAmElector,
      'rank=',
      rank,
      'designated=',
      this.designatedSuccessor
    );

    // Initial UI state.
    this.fsm = iAmElector ? 'ELECTING' : 'FOLLOWING_WAIT';
    usePokerStore
      .getState()
      .setMigrationPhase(iAmElector ? 'reclaiming' : 'waiting');

    while (Date.now() - start < MIGRATION_BUDGET_MS) {
      if (this.intentionalLeave) return;
      if (this.fsm !== 'ELECTING' && this.fsm !== 'FOLLOWING_WAIT') return;

      const canElect = Date.now() >= mayElectAfter;

      // Step 1: try to become host (only if we're past our grace period).
      if (canElect) {
        if (this.fsm !== 'ELECTING') {
          this.fsm = 'ELECTING';
          usePokerStore.getState().setMigrationPhase('reclaiming');
        }
        // Destroy current peer (if any) so the broker frees any random
        // ID we were holding.
        if (this.peer && !this.peer.destroyed) {
          this.destroyPeer();
        }
        try {
          console.log('[peerManager] runMigration: trying to open well-known');
          const peer = await this.openPeer(wellKnownId, OPEN_PEER_TIMEOUT_MS);
          if (this.intentionalLeave) {
            peer.removeAllListeners();
            try {
              peer.destroy();
            } catch {
              /* ignore */
            }
            return;
          }
          this.peer = peer;
          this.becomeHost(roomId);
          this.migrating = false;
          return;
        } catch (err) {
          if (!isUnavailableId(err)) {
            console.warn('[peerManager] runMigration openPeer failed', err);
          } else {
            console.log('[peerManager] runMigration: unavailable-id — connecting');
          }
          // Fall through to step 2 (connect as client).
        }
      }

      // Step 2: try to connect as a client. We need a local random peer
      // for this; open one if we don't already have it.
      if (this.fsm !== 'FOLLOWING_WAIT') {
        this.fsm = 'FOLLOWING_WAIT';
        usePokerStore.getState().setMigrationPhase('waiting');
      }
      if (!this.peer || this.peer.destroyed) {
        try {
          this.peer = await this.openPeer();
        } catch (err) {
          console.warn('[peerManager] runMigration openPeer (random) failed', err);
          await new Promise((r) => setTimeout(r, MIGRATION_RETRY_INTERVAL_MS));
          continue;
        }
      }
      try {
        console.log('[peerManager] runMigration: trying to connect');
        await this.joinAsClient(wellKnownId, { timeoutMs: CONNECT_TIMEOUT_MS });
        // joinAsClient flips fsm to FOLLOWING on first STATE; done.
        return;
      } catch (err) {
        console.warn('[peerManager] runMigration connect failed', err);
      }

      await new Promise((r) => setTimeout(r, MIGRATION_RETRY_INTERVAL_MS));
    }

    if (this.fsm !== 'ELECTING' && this.fsm !== 'FOLLOWING_WAIT') return;
    console.warn('[peerManager] runMigration: budget exhausted, giving up');
    this.giveUpAndLeave();
  }

  /**
   * Decide whether I should try ELECTING immediately (iAmElector=true)
   * and my rank for Phase B stagger.
   *
   * - If LEAVING{nextHostId=string} was received → the designated is
   *   elector; everyone else is a non-elector. Include the leaving host
   *   in the rank list (they may be alive and rejoining as a client).
   * - If no LEAVING received (unplanned host crash) → exclude state.hostId
   *   from the rank list (they crashed); rank 0 of the remaining players
   *   is the elector.
   */
  private decideElectorInfo(): { iAmElector: boolean; rank: number } {
    const { playerId, hostId, players } = usePokerStore.getState();
    const designated = this.designatedSuccessor;

    let candidates = Object.values(players).sort((a, b) => a.joinedAt - b.joinedAt);
    if (typeof designated !== 'string') {
      candidates = candidates.filter((p) => p.id !== hostId);
    }
    const idx = candidates.findIndex((p) => p.id === playerId);
    const rank = Math.max(0, idx);
    if (typeof designated === 'string') {
      return { iAmElector: designated === playerId, rank };
    }
    return { iAmElector: idx === 0, rank };
  }

  private giveUpAndLeave() {
    this.destroyAll();
    this.fsm = 'IDLE';
    this.migrating = false;
    usePokerStore.getState().pushToast({
      message: i18n.t('toast.reclaimFailed'),
      variant: 'error',
    });
    usePokerStore.getState().setMigrationPhase('idle');
    usePokerStore.getState().leaveRoom();
  }

  /**
   * Flip from ELECTING to HOSTING. Prerequisite: this.peer is open at the
   * well-known ID (broker arbitration already succeeded).
   */
  private becomeHost(roomId: string) {
    this.fsm = 'HOSTING';
    this.hostConnection = null;
    this.connections.clear();

    const state = usePokerStore.getState();
    const { playerId } = state;
    const nextEpoch = state.epoch + 1;

    const hostPeerId = `${PEER_PREFIX}${roomId}`;
    const me = state.players[playerId] ?? {
      id: playerId,
      name: state.playerName,
      card: null,
      joinedAt: Date.now(),
      peerId: hostPeerId,
    };
    const updatedMe: Player = { ...me, peerId: hostPeerId };
    const players = { ...state.players, [playerId]: updatedMe };

    usePokerStore.getState().updateRoomState({
      hostId: playerId,
      players,
      epoch: nextEpoch,
    });
    usePokerStore.getState().setConnectionStatus('connected');
    usePokerStore.getState().setMigrationPhase('idle');
    usePokerStore.getState().pushToast({
      message: i18n.t('toast.youAreHost'),
      variant: 'success',
    });

    this.designatedSuccessor = undefined;
    this.startHeartbeat();
    this.broadcastState();
    this.scheduleGhostCleanup();

    console.log('[peerManager] becomeHost complete, epoch=', nextEpoch);
  }

  /**
   * Host-initiated transfer. Broadcast LEAVING to everyone, flush, destroy
   * our peer (releasing the well-known ID), then re-join as a client. The
   * successor's ELECTING path will open the well-known ID and start hosting;
   * every other client (including us) rejoins via the polling loop.
   */
  private async transferHost(newHostId: string) {
    if (this.fsm !== 'HOSTING') return;
    const state = usePokerStore.getState();
    const newHost = state.players[newHostId];
    const roomId = state.roomId;
    if (!newHost || !roomId) return;

    console.log('[peerManager] transferHost: handing off to', newHost.name);

    this.broadcastLeaving(newHostId);

    // No eager STATE_UPDATE with the new hostId here — the old code did that
    // as a hack to notify clients whose LEAVING packet might be lost, but it
    // corrupted rank calculation on clients that HAD received LEAVING (state.hostId
    // would skip past the designated successor, breaking ELECTING). Under the
    // broker-arbitration model the LEAVING loss is no longer dangerous: any
    // client that thinks it's rank-0 will try to open the well-known ID and
    // the broker arbitrates. The successful opener becomes host regardless
    // of who received LEAVING.

    await new Promise((r) => setTimeout(r, LEAVING_FLUSH_MS));

    // Tear down our hosting peer. This releases the well-known ID so the
    // successor can claim it. We flip `fsm` to IDLE BEFORE closing the
    // DataConnections: PeerJS's DataConnection.close() emits 'close'
    // synchronously (eventemitter3), so every incoming close-handler
    // would otherwise run `broadcastState()` while we're still HOSTING,
    // leaking intermediate STATEs that show other clients as offline.
    // Whichever peer wins the subsequent broker race would then start
    // hosting from a pruned snapshot; healthy clients would briefly
    // vanish until they land back via runMigration's joinAsClient.
    this.intentionalLeave = true;
    this.fsm = 'IDLE';
    this.stopHeartbeat();
    this.stopGhostCleanup();
    this.connections.forEach((c) => {
      try {
        c.close();
      } catch {
        /* ignore */
      }
    });
    this.connections.clear();
    this.destroyPeer();
    this.intentionalLeave = false;

    usePokerStore.getState().pushToast({
      message: i18n.t('toast.hostLeftSwitching', { name: newHost.name }),
      variant: 'info',
    });

    // Run the shared migration loop. We pre-seed `designatedSuccessor`
    // and flip to FOLLOWING_WAIT so runMigration's elector check treats
    // us as a non-elector — we gave the host role away, we don't want to
    // race back into it unless the grace expires (designated died).
    this.designatedSuccessor = newHostId;
    this.fsm = 'FOLLOWING_WAIT';
    this.migrating = true;
    usePokerStore.getState().setMigrationPhase('waiting');
    await this.runMigration(roomId);
  }

  // ─── Kick handling ─────────────────────────────────────────────────────────

  private handleKicked() {
    this.intentionalLeave = true;
    this.migrating = false;
    this.stopWatchdog();
    usePokerStore.getState().pushToast({
      message: i18n.t('toast.youWereKicked'),
      variant: 'warning',
    });
    this.destroyAll();
    this.fsm = 'IDLE';
    usePokerStore.getState().leaveRoom();
  }

  // ─── Ghost cleanup ─────────────────────────────────────────────────────────

  private scheduleGhostCleanup() {
    this.stopGhostCleanup();
    this.ghostCleanupTimer = setTimeout(() => {
      this.ghostCleanupTimer = null;
      this.runGhostCleanup();
    }, GHOST_CLEANUP_DELAY_MS);
  }

  private stopGhostCleanup() {
    if (this.ghostCleanupTimer) {
      clearTimeout(this.ghostCleanupTimer);
      this.ghostCleanupTimer = null;
    }
  }

  private runGhostCleanup() {
    if (this.fsm !== 'HOSTING') return;
    const state = usePokerStore.getState();
    const activePeerIds = new Set(this.connections.keys());
    const newPlayers = { ...state.players };
    const removed: string[] = [];
    for (const [pid, player] of Object.entries(newPlayers)) {
      if (pid === state.playerId) continue;
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
}

export const peerManager = new PeerManager();
