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

// How long the host waits for an incoming DataConnection's ICE to reach
// `open`. If not by then, the RTCPeerConnection resources are released.
// Necessary because Arc + Chrome pairs can leave ICE stuck in `checking`
// indefinitely (Arc's mDNS anonymisation + no TURN fallback); without a
// bounded cleanup, every failed retry piles another half-open RTCPeerConnection
// onto the host. Set generously: 20 s covers normal broker latency +
// multiple ICE candidate retries on a sluggish network.
const INCOMING_OPEN_TIMEOUT_MS = 20000;

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
 * Translate a PeerJS error into a user-facing i18n message and a flag
 * whether to surface it as a toast. PeerJS's raw messages are English-
 * only AND mention "server" (its signaling broker), which breaks both
 * our i18n contract and the Serverless brand promise. Everything that
 * might reach the UI routes through here; the raw `err.message` goes
 * to `console.error` only (for developer debugging).
 */
function humanizePeerError(err: { type?: string; message?: string }): {
  toast: boolean;
  message: string;
} {
  switch (err.type) {
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
      return { toast: true, message: i18n.t('errors.signalingLost') };
    case 'ssl-unavailable':
      return { toast: true, message: i18n.t('errors.sslUnavailable') };
    case 'browser-incompatible':
      return { toast: true, message: i18n.t('errors.browserIncompatible') };
    case 'webrtc':
      return { toast: true, message: i18n.t('errors.webrtc') };
    // Expected internal errors handled by the migration / retry loops;
    // no need to alarm the user with a toast.
    case 'unavailable-id':
    case 'peer-unavailable':
    case 'disconnected':
      return { toast: false, message: i18n.t('errors.peerError') };
    default:
      return { toast: true, message: i18n.t('errors.peerError') };
  }
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

  // Cache for short-lived Cloudflare TURN credentials minted by an external
  // Worker. Refreshed when ttl - 60 s elapses.
  private cfTokenCache: {
    iceServers: RTCIceServer[];
    expiresAt: number;
  } | null = null;

  // Last seen ICE state per DataConnection (keyed by conn.peer). Used by the
  // relay-pulse cosmetic indicator and (in B3) by the flap-recovery tracker.
  private iceLastState: Map<string, RTCIceConnectionState> = new Map();

  // Single timeout handle for the 'reconnecting-relay' UI pulse; replaced on
  // every fresh relay detection.
  private relayPulseTimer: ReturnType<typeof setTimeout> | null = null;

  // Debounce handle for restartIceAllConns; coalesces clustered triggers
  // (e.g. 'online' event fires the same instant an 'iceconnectionstate=failed'
  // hits).
  private restartIceDebounce: ReturnType<typeof setTimeout> | null = null;

  // Per-connection 'disconnected'-to-restart grace timers.
  private iceDisconnectTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  // Per-connection 'failed' counter inside the rolling flap window. 2nd
  // 'failed' inside FLAP_FAIL_WINDOW_MS triggers conn.close() so the
  // watchdog / migration path takes over.
  private iceFailCount: Map<string, number> = new Map();
  private iceFailWindowTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  // Bound references so we can detach the same handlers we attached.
  private networkListenersAttached = false;
  private onlineHandler = (): void => this.handleOnline();
  private offlineHandler = (): void => this.handleOffline();
  private visibilityHandler = (): void => this.handleVisibility();
  private pageshowHandler = (e: PageTransitionEvent): void => this.handlePageshow(e);

  // VITE_DEBUG_WEBRTC stats poller. Started on room entry, stopped on
  // destroyAll. Dumps selected candidate pair + bytes-sent/received every
  // 10 s. Tree-shaken in production builds (env check at construction).
  private debugStatsInterval: ReturnType<typeof setInterval> | null = null;

  // ─── Peer lifecycle ────────────────────────────────────────────────────────

  /**
   * Build the iceServers list for new RTCPeerConnections. STUN is always
   * present. TURN entries are appended only when the matching env vars are
   * configured, so the default OSS bundle ships zero credentials and falls
   * back to STUN-only behaviour.
   *
   * Two TURN providers are supported in parallel; ICE will pick whichever
   * relay candidate succeeds first:
   *   - Open Relay (Metered.ca): static credentials are intentionally public,
   *     safe to embed via env vars at build time.
   *   - Cloudflare TURN: short-lived credentials minted by an external Worker.
   *     The Worker URL is the only thing in the client bundle; the Cloudflare
   *     API key never leaves the Worker.
   *
   * Cloudflare fetch failures degrade silently to STUN + whatever else loaded —
   * connection attempts must never block on a TURN provider being reachable.
   */
  private async buildIceServers(): Promise<RTCIceServer[]> {
    const servers: RTCIceServer[] = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },
    ];

    const openrelayUrls = import.meta.env.VITE_TURN_OPENRELAY_URLS;
    const openrelayUser = import.meta.env.VITE_TURN_OPENRELAY_USERNAME;
    const openrelayCred = import.meta.env.VITE_TURN_OPENRELAY_CREDENTIAL;
    if (openrelayUrls && openrelayUser && openrelayCred) {
      const urls = String(openrelayUrls)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (urls.length > 0) {
        servers.push({
          urls,
          username: String(openrelayUser),
          credential: String(openrelayCred),
        });
      }
    }

    const cfTokenUrl = import.meta.env.VITE_TURN_CF_TOKEN_URL;
    if (cfTokenUrl) {
      const cfServers = await this.fetchCloudflareIceServers(String(cfTokenUrl));
      if (cfServers) servers.push(...cfServers);
    }

    return servers;
  }

  /**
   * GET the Worker endpoint and return a normalised iceServers array. The
   * Worker is expected to call Cloudflare's `generate-ice-servers` and
   * forward the response shape `{ iceServers, ttl? }`. We cache until
   * ttl - 60 s. Hard 2 s fetch timeout — TURN should be a soft enhancement,
   * never a connection blocker.
   */
  private async fetchCloudflareIceServers(tokenUrl: string): Promise<RTCIceServer[] | null> {
    const now = Date.now();
    if (this.cfTokenCache && this.cfTokenCache.expiresAt > now) {
      return this.cfTokenCache.iceServers;
    }
    const controller = new AbortController();
    const fetchTimer = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(tokenUrl, { method: 'GET', signal: controller.signal });
      if (!res.ok) {
        console.warn('[peerManager] Cloudflare TURN token fetch failed:', res.status);
        return null;
      }
      const data = (await res.json()) as {
        iceServers?: RTCIceServer | RTCIceServer[];
        ttl?: number;
      };
      const raw = data.iceServers;
      if (!raw) {
        console.warn('[peerManager] Cloudflare TURN token response missing iceServers');
        return null;
      }
      const list = Array.isArray(raw) ? raw : [raw];
      const ttlSec = typeof data.ttl === 'number' && data.ttl > 0 ? data.ttl : 14400;
      this.cfTokenCache = {
        iceServers: list,
        expiresAt: now + Math.max(60, ttlSec - 60) * 1000,
      };
      return list;
    } catch (err) {
      console.warn('[peerManager] Cloudflare TURN token fetch error:', err);
      return null;
    } finally {
      clearTimeout(fetchTimer);
    }
  }

  private async peerOpts() {
    return {
      debug: 2,
      config: {
        iceServers: await this.buildIceServers(),
      },
    };
  }

  /**
   * Open a Peer with the given ID (or random if omitted). Installs broker
   * reconnect + error-as-toast post-open. Rejects on error-before-open or
   * open-timeout.
   */
  private async openPeer(specificId?: string, timeoutMs = 10000): Promise<Peer> {
    console.log('[peerManager] openPeer, specificId=', specificId ?? '(auto)');
    const opts = await this.peerOpts();
    return new Promise((resolve, reject) => {
      const peer = specificId ? new Peer(specificId, opts) : new Peer(opts);

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
        const humanized = humanizePeerError(err);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          try {
            peer.destroy();
          } catch {
            /* ignore */
          }
          // Preserve err.type so callers (runMigration, joinRoomWithRetry)
          // can still branch via isUnavailableId / isPeerUnavailable on
          // the rejected error. The message is already translated so if
          // it bubbles up to Home.tsx's toast, users never see the raw
          // PeerJS English.
          const e = new Error(humanized.message);
          (e as Error & { type?: string }).type = err.type;
          reject(e);
          return;
        }
        // Post-open error. Some types are expected internal signals
        // handled elsewhere (e.g. unavailable-id during ELECTING race) —
        // suppress the toast for those.
        if (humanized.toast) {
          usePokerStore.getState().pushToast({
            message: humanized.message,
            variant: 'error',
          });
        }
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
        usePokerStore.getState().setConnectionStatus('reconnecting-broker');
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
    this.iceLastState.clear();
    this.iceFailCount.clear();
    this.iceFailWindowTimers.forEach((t) => clearTimeout(t));
    this.iceFailWindowTimers.clear();
    this.iceDisconnectTimers.forEach((t) => clearTimeout(t));
    this.iceDisconnectTimers.clear();
    if (this.relayPulseTimer) {
      clearTimeout(this.relayPulseTimer);
      this.relayPulseTimer = null;
    }
    if (this.restartIceDebounce) {
      clearTimeout(this.restartIceDebounce);
      this.restartIceDebounce = null;
    }
    this.detachNetworkListeners();
    this.stopDebugStatsPoller();
    this.destroyPeer();
  }

  // ─── ICE diagnostics ───────────────────────────────────────────────────────

  /**
   * Central handler for `iceStateChanged` events on DataConnections. Tracks
   * last-seen state per conn, drives the relay pulse on fresh 'connected'
   * transitions, and reacts to 'failed' / 'disconnected' by triggering a
   * single-conn ICE restart (with a flap window before falling through to
   * the existing watchdog / migration path).
   */
  private onIceStateChange(conn: DataConnection, state: RTCIceConnectionState): void {
    const prev = this.iceLastState.get(conn.peer);
    this.iceLastState.set(conn.peer, state);

    if (this.intentionalLeave) return;

    const becameConnected =
      (state === 'connected' || state === 'completed') &&
      prev !== 'connected' &&
      prev !== 'completed';
    if (becameConnected) {
      // If we were in a reconnecting-* state during the gap, flip back to
      // 'connected' now. maybePulseRelayStatus may override to
      // 'reconnecting-relay' briefly if the selected pair is a TURN relay;
      // that pulse self-clears back to 'connected' after 3 s.
      const store = usePokerStore.getState();
      if (
        store.connectionStatus === 'reconnecting' ||
        store.connectionStatus === 'reconnecting-broker' ||
        store.connectionStatus === 'reconnecting-ice'
      ) {
        store.setConnectionStatus('connected');
      }
      void this.maybePulseRelayStatus(conn);
      // Successful connect clears any pending grace timer / flap counter.
      this.clearIceDisconnectTimer(conn.peer);
      this.iceFailCount.delete(conn.peer);
      const flapTimer = this.iceFailWindowTimers.get(conn.peer);
      if (flapTimer) {
        clearTimeout(flapTimer);
        this.iceFailWindowTimers.delete(conn.peer);
      }
      return;
    }

    if (state === 'failed') {
      this.handleIceFailed(conn);
      return;
    }

    if (state === 'disconnected') {
      this.handleIceDisconnected(conn);
      return;
    }

    if (state === 'closed') {
      this.clearIceDisconnectTimer(conn.peer);
    }
  }

  // ─── ICE restart / network resilience (B1, B2, B3) ────────────────────────

  /** Debounce window for restart triggers (1.5 s — well under HEARTBEAT_TIMEOUT_MS/4). */
  private static readonly RESTART_ICE_DEBOUNCE_MS = 1500;
  /** A second 'failed' within this window → close conn & let migration take over. */
  private static readonly ICE_FAIL_WINDOW_MS = 5000;
  /** Grace before reacting to a 'disconnected' state (often self-recovers). */
  private static readonly ICE_DISCONNECT_GRACE_MS = 4000;
  /** If ICE never visibly transitions after restartIce(), revert status this long after. */
  private static readonly RESTART_ICE_FALLBACK_MS = 2500;

  /**
   * Call `restartIce()` on every live DataConnection (host-side inbound
   * conns + client-side outbound conn). Debounced so clustered triggers
   * (e.g. `online` event arriving the same instant ICE flaps) don't queue
   * redundant restarts. No-op while `intentionalLeave` is set (teardown).
   *
   * Note: PeerJS's wrapper doesn't auto-trigger renegotiation on
   * `restartIce()`. If ICE is healthy at the time we ask, no state
   * transition fires and `onIceStateChange` won't flip the UI back to
   * 'connected' for us. We schedule a short fallback that reverts the
   * status if nothing visible happens.
   */
  private restartIceAllConns(): void {
    if (this.intentionalLeave) return;
    if (this.restartIceDebounce) return; // coalesce inside the debounce window
    this.restartIceDebounce = setTimeout(() => {
      this.restartIceDebounce = null;
      if (this.intentionalLeave) return;
      const targets: DataConnection[] = [];
      if (this.hostConnection) targets.push(this.hostConnection);
      this.connections.forEach((c) => targets.push(c));
      if (targets.length === 0) return;
      console.log('[peerManager] restartIce on', targets.length, 'conn(s)');
      const store = usePokerStore.getState();
      if (
        store.connectionStatus === 'connected' ||
        store.connectionStatus === 'reconnecting-relay'
      ) {
        store.setConnectionStatus('reconnecting-ice');
      }
      for (const conn of targets) {
        try {
          conn.peerConnection?.restartIce?.();
        } catch (err) {
          console.warn('[peerManager] restartIce failed for', conn.peer, err);
        }
      }
      // Fallback: if ICE never visibly transitions (PeerJS doesn't auto-
      // renegotiate), revert to 'connected' so the UI doesn't get stuck.
      // Real ICE failure would have fired 'failed' / 'disconnected' before
      // this fires, so we only act when ICE looks fine right now.
      setTimeout(() => {
        if (this.intentionalLeave) return;
        if (usePokerStore.getState().connectionStatus !== 'reconnecting-ice') return;
        const stillHealthy = targets.every((c) => {
          const s = c.peerConnection?.iceConnectionState;
          return s === 'connected' || s === 'completed';
        });
        if (stillHealthy) {
          usePokerStore.getState().setConnectionStatus('connected');
        }
      }, PeerManager.RESTART_ICE_FALLBACK_MS);
    }, PeerManager.RESTART_ICE_DEBOUNCE_MS);
  }

  /** B3 — 'failed' state. Restart once; on the 2nd 'failed' inside the window, close. */
  private handleIceFailed(conn: DataConnection): void {
    const count = (this.iceFailCount.get(conn.peer) ?? 0) + 1;
    this.iceFailCount.set(conn.peer, count);
    const existingWindow = this.iceFailWindowTimers.get(conn.peer);
    if (existingWindow) clearTimeout(existingWindow);
    this.iceFailWindowTimers.set(
      conn.peer,
      setTimeout(() => {
        this.iceFailCount.delete(conn.peer);
        this.iceFailWindowTimers.delete(conn.peer);
      }, PeerManager.ICE_FAIL_WINDOW_MS)
    );

    if (count >= 2) {
      console.warn('[peerManager] ICE failed twice within window — closing conn', conn.peer);
      try {
        conn.close();
      } catch (err) {
        console.warn('[peerManager] conn.close after repeated ICE fail errored', err);
      }
      return;
    }
    this.restartIceAllConns();
  }

  /** B3 — 'disconnected' state. Wait a grace window; restart only if still down. */
  private handleIceDisconnected(conn: DataConnection): void {
    if (this.iceDisconnectTimers.has(conn.peer)) return; // already armed
    const timer = setTimeout(() => {
      this.iceDisconnectTimers.delete(conn.peer);
      if (this.intentionalLeave) return;
      const cur = this.iceLastState.get(conn.peer);
      if (cur === 'connected' || cur === 'completed' || cur === 'closed') return;
      console.warn('[peerManager] ICE still disconnected after grace — restarting', conn.peer);
      this.restartIceAllConns();
    }, PeerManager.ICE_DISCONNECT_GRACE_MS);
    this.iceDisconnectTimers.set(conn.peer, timer);
  }

  private clearIceDisconnectTimer(peerId: string): void {
    const t = this.iceDisconnectTimers.get(peerId);
    if (t) {
      clearTimeout(t);
      this.iceDisconnectTimers.delete(peerId);
    }
  }

  /**
   * Wire window-level network lifecycle events to ICE-restart triggers. The
   * existing `peer.on('disconnected')` path handles PeerJS broker WS drops;
   * THIS layer handles RTCPeerConnection-level health (the WiFi/4G handoff,
   * laptop sleep/wake, BFCache restore).
   *
   * Called from createRoom / joinAsClient on entry; detached from leaveRoom
   * / destroyAll on exit. Idempotent — repeated attach is a no-op.
   */
  private attachNetworkListeners(): void {
    if (typeof window === 'undefined') return;
    if (this.networkListenersAttached) return;
    window.addEventListener('online', this.onlineHandler);
    window.addEventListener('offline', this.offlineHandler);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }
    window.addEventListener('pageshow', this.pageshowHandler);
    this.networkListenersAttached = true;
  }

  private detachNetworkListeners(): void {
    if (typeof window === 'undefined') return;
    if (!this.networkListenersAttached) return;
    window.removeEventListener('online', this.onlineHandler);
    window.removeEventListener('offline', this.offlineHandler);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
    }
    window.removeEventListener('pageshow', this.pageshowHandler);
    this.networkListenersAttached = false;
  }

  private handleOnline(): void {
    if (this.intentionalLeave) return;
    console.log('[peerManager] window online — restarting ICE + broker if needed');
    this.restartIceAllConns();
    const peer = this.peer;
    if (peer && peer.disconnected && !peer.destroyed) {
      try {
        peer.reconnect();
      } catch (err) {
        console.warn('[peerManager] online: peer.reconnect failed', err);
      }
    }
  }

  private handleOffline(): void {
    if (this.intentionalLeave) return;
    console.warn('[peerManager] window offline — flagging reconnecting-ice');
    const store = usePokerStore.getState();
    if (store.connectionStatus === 'connected') {
      store.setConnectionStatus('reconnecting-ice');
    }
    // Intentionally NOT tearing anything down — the OS may simply reroute
    // and ICE survives. If it doesn't, the watchdog or 'online' handler
    // converges via restartIceAllConns().
  }

  private handleVisibility(): void {
    if (typeof document === 'undefined') return;
    if (document.visibilityState !== 'visible') return;
    if (this.intentionalLeave) return;
    console.log('[peerManager] visibility=visible — restarting ICE');
    this.restartIceAllConns();
  }

  private handlePageshow(e: PageTransitionEvent): void {
    if (!e.persisted) return; // only the BFCache-restore branch matters
    if (this.intentionalLeave) return;
    console.log('[peerManager] pageshow (BFCache restore) — restarting ICE');
    this.restartIceAllConns();
  }

  // ─── Debug stats poller (VITE_DEBUG_WEBRTC=1) ─────────────────────────────

  private startDebugStatsPoller(): void {
    if (!import.meta.env.VITE_DEBUG_WEBRTC) return;
    if (this.debugStatsInterval) return;
    this.debugStatsInterval = setInterval(() => {
      void this.dumpDebugStats();
    }, 10000);
  }

  private stopDebugStatsPoller(): void {
    if (this.debugStatsInterval) {
      clearInterval(this.debugStatsInterval);
      this.debugStatsInterval = null;
    }
  }

  private async dumpDebugStats(): Promise<void> {
    const targets: Array<{ label: string; conn: DataConnection }> = [];
    if (this.hostConnection) {
      targets.push({ label: `→host(${this.hostConnection.peer})`, conn: this.hostConnection });
    }
    this.connections.forEach((conn, peerId) => {
      targets.push({ label: `←client(${peerId})`, conn });
    });
    for (const { label, conn } of targets) {
      const pc = conn.peerConnection;
      if (!pc) continue;
      try {
        const stats = await pc.getStats();
        let selectedPairId: string | undefined;
        stats.forEach((report) => {
          if (report.type === 'transport' && typeof report.selectedCandidatePairId === 'string') {
            selectedPairId = report.selectedCandidatePairId;
          }
        });
        const pair = selectedPairId ? stats.get(selectedPairId) : undefined;
        const localId = pair?.localCandidateId;
        const remoteId = pair?.remoteCandidateId;
        const local = localId ? stats.get(localId) : undefined;
        const remote = remoteId ? stats.get(remoteId) : undefined;
        console.debug(
          `[peerManager:debugStats] ${label}`,
          JSON.stringify({
            iceState: pc.iceConnectionState,
            localType: local?.candidateType,
            localProtocol: local?.protocol,
            remoteType: remote?.candidateType,
            bytesSent: pair?.bytesSent,
            bytesReceived: pair?.bytesReceived,
            currentRoundTripTime: pair?.currentRoundTripTime,
          })
        );
      } catch (err) {
        console.debug('[peerManager:debugStats] getStats failed for', label, err);
      }
    }
  }

  /**
   * On a fresh ICE 'connected' transition, ask the RTCPeerConnection which
   * candidate pair was selected. If the local side picked a TURN relay
   * candidate, flip the UI to a 3 s 'reconnecting-relay' pulse so the user
   * knows the room reached them via TURN. Pure cosmetic — the channel is
   * already live by the time we run.
   */
  private async maybePulseRelayStatus(conn: DataConnection): Promise<void> {
    const pc = conn.peerConnection;
    if (!pc) return;
    try {
      const stats = await pc.getStats();
      let selectedPairId: string | undefined;
      stats.forEach((report) => {
        if (report.type === 'transport' && typeof report.selectedCandidatePairId === 'string') {
          selectedPairId = report.selectedCandidatePairId;
        }
      });
      let localCandidateId: string | undefined;
      if (selectedPairId) {
        const pair = stats.get(selectedPairId);
        if (pair && typeof pair.localCandidateId === 'string') {
          localCandidateId = pair.localCandidateId;
        }
      } else {
        stats.forEach((report) => {
          if (
            report.type === 'candidate-pair' &&
            report.nominated === true &&
            (report.state === 'succeeded' || report.selected === true) &&
            typeof report.localCandidateId === 'string'
          ) {
            localCandidateId = report.localCandidateId;
          }
        });
      }
      if (!localCandidateId) return;
      const local = stats.get(localCandidateId);
      if (!local || local.candidateType !== 'relay') return;

      const store = usePokerStore.getState();
      store.setConnectionStatus('reconnecting-relay');
      if (this.relayPulseTimer) clearTimeout(this.relayPulseTimer);
      this.relayPulseTimer = setTimeout(() => {
        this.relayPulseTimer = null;
        if (usePokerStore.getState().connectionStatus === 'reconnecting-relay') {
          usePokerStore.getState().setConnectionStatus('connected');
        }
      }, 3000);
    } catch (err) {
      console.debug('[peerManager] getStats failed during relay-pulse', err);
    }
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
    // Attach network lifecycle listeners on every room entry. Idempotent.
    this.attachNetworkListeners();
    this.startDebugStatsPoller();
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
        const humanized = humanizePeerError(err);
        const e = new Error(humanized.message);
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
        this.iceLastState.delete(conn.peer);
        this.iceFailCount.delete(conn.peer);
        const flapTimer = this.iceFailWindowTimers.get(conn.peer);
        if (flapTimer) {
          clearTimeout(flapTimer);
          this.iceFailWindowTimers.delete(conn.peer);
        }
        this.clearIceDisconnectTimer(conn.peer);
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
        this.onIceStateChange(conn, state);
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

    // Bounded wait for ICE to reach `open`. If the peer pair can't complete
    // ICE (Arc + Chrome with no TURN is the common case), close the conn
    // so we don't accumulate half-open RTCPeerConnection objects across
    // the client's retries.
    const openTimeout = setTimeout(() => {
      if (!conn.open) {
        console.warn(
          '[peerManager] incoming ICE never opened, dropping',
          conn.peer
        );
        try {
          conn.close();
        } catch {
          /* ignore */
        }
      }
    }, INCOMING_OPEN_TIMEOUT_MS);

    const setupIncoming = () => {
      clearTimeout(openTimeout);
      console.log('[peerManager] incoming open, storing + broadcasting to', conn.peer);
      this.connections.set(conn.peer, conn);
      this.broadcastState();
    };

    conn.on('iceStateChanged', (state) => {
      console.log('[peerManager] incoming ICE', conn.peer, '=', state);
      this.onIceStateChange(conn, state);
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
      clearTimeout(openTimeout);
      console.warn('[peerManager] incoming closed', conn.peer);
      this.connections.delete(conn.peer);
      this.iceLastState.delete(conn.peer);
      this.iceFailCount.delete(conn.peer);
      const flapTimer = this.iceFailWindowTimers.get(conn.peer);
      if (flapTimer) {
        clearTimeout(flapTimer);
        this.iceFailWindowTimers.delete(conn.peer);
      }
      this.clearIceDisconnectTimer(conn.peer);
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
      clearTimeout(openTimeout);
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
    usePokerStore.getState().setConnectionStatus('reconnecting-ice');

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

  // ─── Test-only hooks ───────────────────────────────────────────────────────

  /**
   * E2E entry point — manually trigger an ICE restart on every live
   * DataConnection. Mirrors the production `online`/`visibilitychange`
   * code path; only exposed via `window.__POKER_PEER__` under VITE_E2E.
   */
  public triggerIceRestartForTest(): void {
    this.restartIceAllConns();
  }
}

export const peerManager = new PeerManager();
