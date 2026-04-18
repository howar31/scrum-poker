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
  // Host → clients: I'm leaving gracefully; {{nextHostId}} is the designated
  // successor. Lets clients skip the 31 s scheduleReconnect grace period
  // and trigger the new-host reclaim immediately. Computed by the leaving
  // host so every client trusts the same authoritative choice.
  | { type: 'HOST_LEAVING'; payload: { nextHostId: string | null } };

const PEER_PREFIX = 'scrum-poker-';
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000]; // exp backoff, 5 attempts total
// Reclaim backoff for new host taking over the well-known peer ID. First
// attempt is immediate; remaining attempts wait for the PeerJS signaling
// server to release the old host's ID (heartbeat grace period).
const RECLAIM_DELAYS_MS = [0, 1000, 2000, 4000, 8000];
// After a reclaim, wait this long for remaining clients to finish their
// scheduleReconnect retries and land on the new host before sweeping any
// players who never showed up. Covers RECONNECT_DELAYS_MS (~31 s total)
// plus a small buffer.
const GHOST_CLEANUP_DELAY_MS = 20000;

class PeerManager {
  private peer: Peer | null = null;
  private connections: Map<string, DataConnection> = new Map();
  private hostConnection: DataConnection | null = null;
  private isHost: boolean = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private ghostCleanupTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalLeave = false;
  // Guards against infinite migration loops — if a client's scheduleReconnect
  // hits handleHostDisconnect twice in a row without a successful join, give
  // up instead of looping forever.
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

      this.peer.on('open', (id) => {
        console.log('[peerManager] peer open, id=', id);
        initResolved = true;
        resolve(id);
      });

      this.peer.on('connection', (conn) => {
        console.log('[peerManager] incoming connection from', conn.peer, 'isHost=', this.isHost);
        this.handleIncomingConnection(conn);
      });

      this.peer.on('disconnected', () => console.warn('[peerManager] peer disconnected'));
      this.peer.on('close', () => console.warn('[peerManager] peer closed'));

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

    usePokerStore.getState().setConnected(true);
    console.log('[peerManager] createRoom: ready, roomId=', roomId);
  }

  async joinRoom(roomId: string): Promise<void> {
    this.intentionalLeave = false;
    this.migrationAttempted = false;
    // Set role BEFORE init (symmetric with createRoom) so any racing state is safe.
    this.isHost = false;

    if (!this.peer || this.peer.disconnected) await this.init();
    if (!this.peer) throw new Error(i18n.t('errors.peerInitFailed'));

    const hostPeerId = `${PEER_PREFIX}${roomId}`;
    console.log('[peerManager] joinRoom: my peerId=', this.peer.id, 'connecting to', hostPeerId);

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
        console.error('[peerManager] joinRoom peer error:', err.type, err.message);
        settle(() => reject(new Error(err.message ?? i18n.t('errors.peerError'))));
      };

      this.peer!.on('error', onPeerError);

      const timeoutId: ReturnType<typeof setTimeout> = setTimeout(() => {
        const baseMsg = i18n.t('errors.connectionTimeout');
        const arcHint = isArcBrowser() ? i18n.t('errors.arcHint') : '';
        settle(() => reject(new Error(baseMsg + arcHint)));
      }, 20000);

      const conn = this.peer!.connect(hostPeerId, { serialization: 'json' });
      this.hostConnection = conn;
      console.log('[peerManager] joinRoom: DataConnection created, waiting for open...');

      conn.on('error', (err) => {
        console.error('[peerManager] joinRoom conn error:', err);
        settle(() => reject(err));
      });

      conn.on('close', () => {
        console.warn('[peerManager] joinRoom conn closed (settled=', settled, ')');
        if (!settled) {
          settle(() => reject(new Error(i18n.t('errors.closedBeforeJoining'))));
          return;
        }
        // Connection was previously open; trigger reconnect → migration fallback.
        this.onHostConnectionLost();
      });

      conn.on('iceStateChanged', (state) => {
        console.log('[peerManager] joinRoom ICE state =', state);
      });

      conn.on('data', (raw) => {
        const data = raw as Message;
        console.log('[peerManager] joinRoom received data type=', data?.type);
        if (data?.type === 'STATE_UPDATE' && data.payload) {
          usePokerStore.getState().updateRoomState(data.payload);
          settle(() => resolve());
        } else if (data?.type === 'HOST_LEAVING') {
          this.handleHostLeaving(data.payload.nextHostId);
        }
      });

      const setupConnection = () => {
        console.log('[peerManager] joinRoom: conn.open fired, sending JOIN');
        usePokerStore.getState().setConnected(true);
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
        if (kickPeerId) {
          const connToKick = this.connections.get(kickPeerId);
          if (connToKick) connToKick.close();
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

  // Client-side: hostConnection was previously open but is now closed. Try to
  // reconnect to the same host with exponential backoff; fall back to host
  // migration if all attempts fail.
  private onHostConnectionLost() {
    if (this.intentionalLeave) return;
    if (this.isHost) return; // host itself doesn't reconnect to anyone
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.reconnectAttempt >= RECONNECT_DELAYS_MS.length) {
      usePokerStore.getState().pushToast({
        message: i18n.t('toast.findingNewHost'),
        variant: 'warning',
      });
      this.reconnectAttempt = 0;
      this.handleHostDisconnect();
      return;
    }

    const delay = RECONNECT_DELAYS_MS[this.reconnectAttempt];
    const attemptNumber = this.reconnectAttempt + 1;
    usePokerStore.getState().setConnected(false);
    usePokerStore.getState().pushToast({
      message: i18n.t('toast.connectionLost', {
        attempt: attemptNumber,
        max: RECONNECT_DELAYS_MS.length,
      }),
      variant: 'info',
    });

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectAttempt++;
      const roomId = usePokerStore.getState().roomId;
      if (!roomId || this.intentionalLeave) return;

      try {
        await this.joinRoom(roomId);
        this.reconnectAttempt = 0;
        this.migrationAttempted = false;
        usePokerStore.getState().setMigrationPhase('idle');
        usePokerStore.getState().pushToast({
          message: i18n.t('toast.reconnected'),
          variant: 'success',
        });
      } catch (err) {
        console.warn('[peerManager] reconnect attempt failed:', err);
        this.scheduleReconnect();
      }
    }, delay);
  }

  // Graceful-leave counterpart to `handleHostDisconnect`. Triggered when
  // the current host broadcasts HOST_LEAVING with an authoritative
  // successor id. Skips the 31 s scheduleReconnect grace period and jumps
  // straight into the reclaim / waiting state.
  private async handleHostLeaving(nextHostId: string | null) {
    console.log('[peerManager] received HOST_LEAVING, nextHostId=', nextHostId);

    // Cancel any scheduled reconnect — we have fresh, authoritative info.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;

    const { playerId, roomId, players } = usePokerStore.getState();
    if (!roomId) return;

    usePokerStore.getState().setConnected(false);

    // No successor — room is closing down with the host.
    if (!nextHostId) {
      usePokerStore.getState().pushToast({
        message: i18n.t('toast.roomEmpty'),
        variant: 'info',
      });
      usePokerStore.getState().leaveRoom();
      return;
    }

    if (nextHostId === playerId) {
      // I'm the designated new host — reclaim now. No 31 s wait.
      await this.reclaimHostIdentity(roomId);
      return;
    }

    // Someone else is taking over. Wait for them to claim the well-known ID,
    // then our scheduleReconnect naturally lands us on them.
    usePokerStore.getState().setMigrationPhase('waiting');
    const successor = players[nextHostId];
    usePokerStore.getState().pushToast({
      message: i18n.t('toast.hostLeftSwitching', {
        name: successor?.name ?? nextHostId,
      }),
      variant: 'info',
    });
    this.scheduleReconnect();
  }

  private async handleHostDisconnect() {
    usePokerStore.getState().setConnected(false);

    const state = usePokerStore.getState();
    const { players, playerId, roomId } = state;

    if (!roomId) return;

    // Second time through? Means migration already ran but the new host (or
    // our rejoin) never stabilised. Bail out instead of looping forever.
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

    const activePlayers = Object.values(players).sort((a, b) => a.joinedAt - b.joinedAt);
    // Exclude the dropped host so we don't elect them again.
    const candidates = activePlayers.filter((p) => p.id !== state.hostId);
    const nextHost = candidates[0];

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
      console.log('[peerManager] self-promoting to host, reclaiming well-known ID');
      await this.reclaimHostIdentity(roomId);
      return;
    }

    // Someone else is the new host. Let them claim the well-known peer ID
    // (scrum-poker-{roomId}), then our scheduleReconnect naturally finds
    // them there. Show a "waiting" overlay so the user knows we're not idle.
    console.log('[peerManager] waiting for new host to claim well-known ID:', nextHost.name);
    usePokerStore.getState().setMigrationPhase('waiting');
    usePokerStore.getState().pushToast({
      message: i18n.t('toast.hostLeftSwitching', { name: nextHost.name }),
      variant: 'info',
    });
    this.reconnectAttempt = 0;
    this.scheduleReconnect();
  }

  // New host takes over `scrum-poker-{roomId}` so (a) remaining clients'
  // reconnect loops automatically land on us and (b) anyone arriving via
  // `?room=XYZ` can still discover the room. PeerJS signaling may hold the
  // old host's ID for a few seconds (heartbeat grace period), so retry with
  // backoff before giving up.
  private async reclaimHostIdentity(roomId: string) {
    usePokerStore.getState().setMigrationPhase('reclaiming');
    const hostPeerId = `${PEER_PREFIX}${roomId}`;
    // Set isHost before init so any incoming connection that races open()
    // passes the `!isHost` guard in handleIncomingConnection.
    this.isHost = true;

    for (let i = 0; i < RECLAIM_DELAYS_MS.length; i++) {
      if (RECLAIM_DELAYS_MS[i] > 0) {
        await new Promise((r) => setTimeout(r, RECLAIM_DELAYS_MS[i]));
      }
      try {
        await this.init(hostPeerId);
        // Success — we now own the well-known peer ID.
        const { playerId } = usePokerStore.getState();
        this.hostConnection = null;
        this.connections.clear();
        this.reconnectAttempt = 0;
        this.migrationAttempted = false;
        usePokerStore.getState().updateRoomState({ hostId: playerId });
        usePokerStore.getState().setConnected(true);
        usePokerStore.getState().setMigrationPhase('idle');
        usePokerStore.getState().pushToast({
          message: i18n.t('toast.youAreHost'),
          variant: 'success',
        });
        this.broadcastState();
        // The players map carries over from the previous host broadcast, but
        // our connections map is empty. Schedule a sweep to drop anyone who
        // never reconnects (e.g. the crashed old host). Live clients land
        // back on us via their scheduleReconnect within this window.
        this.scheduleGhostCleanup();
        return;
      } catch (err) {
        console.warn(
          `[peerManager] reclaim attempt ${i + 1}/${RECLAIM_DELAYS_MS.length} failed:`,
          err
        );
      }
    }

    // All attempts failed — couldn't take over. Back out.
    console.error('[peerManager] failed to reclaim host identity after retries');
    this.isHost = false;
    usePokerStore.getState().pushToast({
      message: i18n.t('toast.reclaimFailed'),
      variant: 'error',
    });
    usePokerStore.getState().setMigrationPhase('idle');
    usePokerStore.getState().leaveRoom();
  }

  // Arm a one-shot sweep GHOST_CLEANUP_DELAY_MS after a successful reclaim.
  // The per-connection `conn.on('close')` path removes players as they drop,
  // but after reclaim the connections map starts empty while the players
  // map retains everyone from the previous host's broadcast — including the
  // crashed old host. Live clients reconnect via scheduleReconnect and end
  // up in this.connections; anyone still absent when the timer fires was
  // genuinely gone. Self-promoted transfers work too: the demoting host
  // rejoins as a client well within the window.
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

  // Manual host transfer (Host clicks "Make host" on another player).
  // Reuses the HOST_LEAVING flow so the new host claims `scrum-poker-{roomId}`
  // and other clients pick them up via their normal reconnect loop. The
  // difference from a leave is that the old host, after releasing the peer,
  // rejoins as a client instead of exiting the room.
  private async transferHost(newHostId: string) {
    const state = usePokerStore.getState();
    const newHost = state.players[newHostId];
    const roomId = state.roomId;
    if (!newHost || !roomId) return;

    // Announce the successor to every client BEFORE destroying. Same message
    // as graceful leave — receiver logic (reclaim / wait) is identical.
    const msg: Message = {
      type: 'HOST_LEAVING',
      payload: { nextHostId: newHostId },
    };
    this.connections.forEach((conn) => {
      if (conn.open) conn.send(msg);
    });

    // Let the data channel flush before we tear the peer down.
    await new Promise((r) => setTimeout(r, 50));
    this.destroy();
    this.isHost = false;

    // Show the waiting overlay while the new host claims the well-known ID,
    // then rejoin as a client ourselves.
    usePokerStore.getState().setMigrationPhase('waiting');
    usePokerStore.getState().pushToast({
      message: i18n.t('toast.hostLeftSwitching', { name: newHost.name }),
      variant: 'info',
    });

    // Retry joinRoom with the same backoff used for reclaim — the new host
    // needs a moment to take over `scrum-poker-{roomId}` before we can
    // connect to it.
    for (let i = 0; i < RECLAIM_DELAYS_MS.length; i++) {
      if (RECLAIM_DELAYS_MS[i] > 0) {
        await new Promise((r) => setTimeout(r, RECLAIM_DELAYS_MS[i]));
      }
      try {
        await this.joinRoom(roomId);
        return; // back in as client
      } catch (err) {
        console.warn(
          `[peerManager] rejoin-after-transfer attempt ${i + 1}/${RECLAIM_DELAYS_MS.length} failed:`,
          err
        );
      }
    }

    // Couldn't rejoin — surface and bail out.
    console.error('[peerManager] failed to rejoin after transferring host');
    usePokerStore.getState().pushToast({
      message: i18n.t('toast.reclaimFailed'),
      variant: 'error',
    });
    usePokerStore.getState().setMigrationPhase('idle');
    usePokerStore.getState().leaveRoom();
  }

  // Teardown used internally (e.g. before reinitializing a peer inside init()).
  // Must NOT reset isHost: createRoom sets isHost=true BEFORE awaiting init(),
  // and resetting it here would undo that race fix and cause the host to
  // reject every incoming connection. Role transitions are the caller's
  // responsibility (createRoom/joinRoom/reclaimHostIdentity set their own role).
  destroy() {
    if (this.peer) {
      this.peer.destroy();
      this.peer = null;
    }
    this.connections.clear();
    this.hostConnection = null;
  }

  // User-initiated leave. Cancels any pending reconnect and tears everything
  // down, including the role flag. Call this from the UI's "Leave Room"
  // button instead of destroy().
  leave() {
    this.intentionalLeave = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ghostCleanupTimer) {
      clearTimeout(this.ghostCleanupTimer);
      this.ghostCleanupTimer = null;
    }
    this.reconnectAttempt = 0;

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

      const msg: Message = {
        type: 'HOST_LEAVING',
        payload: { nextHostId },
      };
      this.connections.forEach((conn) => {
        if (conn.open) conn.send(msg);
      });

      // Small defer so the data-channel send queue flushes before destroy
      // tears the peer down. 50 ms is imperceptible to the user.
      setTimeout(() => {
        this.destroy();
        this.isHost = false;
      }, 50);
      return;
    }

    this.destroy();
    this.isHost = false;
  }
}

export const peerManager = new PeerManager();
