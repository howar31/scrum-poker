import Peer, { type DataConnection } from 'peerjs';
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
  | { type: 'ACTION'; payload: Action };

const PEER_PREFIX = 'scrum-poker-';
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000]; // exp backoff, 5 attempts total

class PeerManager {
  private peer: Peer | null = null;
  private connections: Map<string, DataConnection> = new Map();
  private hostConnection: DataConnection | null = null;
  private isHost: boolean = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalLeave = false;

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
        usePokerStore.getState().setError(err.message);
        if (!initResolved) {
          initResolved = true;
          reject(err);
        }
      });
    });
  }

  async createRoom() {
    this.intentionalLeave = false;
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
    // Set role BEFORE init (symmetric with createRoom) so any racing state is safe.
    this.isHost = false;

    if (!this.peer || this.peer.disconnected) await this.init();
    if (!this.peer) throw new Error('Failed to initialize PeerJS');

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
        usePokerStore.getState().setError(err.message ?? 'Peer error');
        settle(() => reject(err));
      };

      this.peer!.on('error', onPeerError);

      const timeoutId: ReturnType<typeof setTimeout> = setTimeout(() => {
        const baseMsg = 'Connection to host timed out (20s). Check the Room ID, confirm the host is online, or verify your network.';
        const arcHint = isArcBrowser()
          ? ' (Arc detected: open arc://flags, set "Anonymize local IPs exposed to WebRTC" to Disabled, restart Arc.)'
          : '';
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
          settle(() => reject(new Error('Connection closed by host before joining.')));
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
        }
      });

      const setupConnection = () => {
        console.log('[peerManager] joinRoom: conn.open fired, sending JOIN');
        usePokerStore.getState().setConnected(true);

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
          message: `${player.name} 已離線`,
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
            message: `${action.payload.name} 已重新連上`,
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
            message: `${action.payload.name} 已加入`,
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
        message: '連線無法恢復，正在尋找新的 Host...',
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
      message: `連線中斷，正在重試 (${attemptNumber}/${RECONNECT_DELAYS_MS.length})...`,
      variant: 'info',
    });

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectAttempt++;
      const roomId = usePokerStore.getState().roomId;
      if (!roomId || this.intentionalLeave) return;

      try {
        await this.joinRoom(roomId);
        this.reconnectAttempt = 0;
        usePokerStore.getState().pushToast({
          message: '已重新連上',
          variant: 'success',
        });
      } catch (err) {
        console.warn('[peerManager] reconnect attempt failed:', err);
        this.scheduleReconnect();
      }
    }, delay);
  }

  private handleHostDisconnect() {
    usePokerStore.getState().setConnected(false);

    const state = usePokerStore.getState();
    const { players, playerId } = state;

    const activePlayers = Object.values(players).sort((a, b) => a.joinedAt - b.joinedAt);
    // Exclude the dropped host so we don't elect them again.
    const candidates = activePlayers.filter((p) => p.id !== state.hostId);
    const nextHost = candidates[0];

    if (!nextHost) {
      console.log('[peerManager] no candidates, leaving room');
      usePokerStore.getState().pushToast({
        message: '房間已空，已離開',
        variant: 'info',
      });
      usePokerStore.getState().leaveRoom();
      return;
    }

    if (nextHost.id === playerId) {
      console.log('[peerManager] self-promoting to host');
      this.isHost = true;
      this.hostConnection = null;
      this.connections.clear();
      usePokerStore.getState().updateRoomState({ hostId: playerId });
      usePokerStore.getState().setConnected(true);
      usePokerStore.getState().pushToast({
        message: '你已成為新的 Host',
        variant: 'success',
      });
      this.broadcastState();
      return;
    }

    console.log('[peerManager] connecting to new host:', nextHost.name, nextHost.peerId);
    usePokerStore.getState().pushToast({
      message: `Host 已離線，切換到 ${nextHost.name}`,
      variant: 'info',
    });
    this.joinHost(nextHost.peerId).catch((err) => {
      console.error('[peerManager] failed to connect to new host:', err);
      usePokerStore.getState().pushToast({
        message: `無法連線到新 Host (${nextHost.name})`,
        variant: 'error',
      });
    });
  }

  private transferHost(newHostId: string) {
    const state = usePokerStore.getState();
    const newHost = state.players[newHostId];
    if (!newHost) return;

    usePokerStore.getState().updateRoomState({ hostId: newHostId });
    this.broadcastState();

    this.isHost = false;

    setTimeout(() => {
      this.connections.forEach((conn) => conn.close());
      this.connections.clear();
      this.joinHost(newHost.peerId);
    }, 500);
  }

  async joinHost(hostPeerId: string) {
    if (!this.peer || this.peer.disconnected) await this.init();
    if (!this.peer) return;

    this.isHost = false;

    const conn = this.peer.connect(hostPeerId, { serialization: 'json' });
    this.hostConnection = conn;

    const setupConnection = () => {
      console.log('[peerManager] joinHost: connected to new host', hostPeerId);
      usePokerStore.getState().setConnected(true);
      this.reconnectAttempt = 0;

      const { playerId, playerName } = usePokerStore.getState();
      this.sendAction({
        type: 'JOIN',
        payload: { id: playerId, name: playerName, peerId: this.peer!.id },
      });
    };

    conn.on('iceStateChanged', (state) => {
      console.log('[peerManager] joinHost ICE state =', state);
    });

    conn.on('data', (raw) => {
      const data = raw as Message;
      if (data?.type === 'STATE_UPDATE' && data.payload) {
        usePokerStore.getState().updateRoomState(data.payload);
      }
    });

    conn.on('close', () => {
      console.warn('[peerManager] joinHost connection closed');
      this.onHostConnectionLost();
    });

    conn.on('error', (err) => {
      console.error('[peerManager] joinHost conn error:', err);
    });

    if (conn.open) setupConnection();
    else conn.on('open', setupConnection);
  }

  // Teardown used internally (e.g. before reinitializing a peer inside init()).
  // Must NOT reset isHost: createRoom sets isHost=true BEFORE awaiting init(),
  // and resetting it here would undo that race fix and cause the host to
  // reject every incoming connection. Role transitions are the caller's
  // responsibility (createRoom/joinRoom/joinHost set their own role).
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
    this.reconnectAttempt = 0;
    this.destroy();
    this.isHost = false;
  }
}

export const peerManager = new PeerManager();
