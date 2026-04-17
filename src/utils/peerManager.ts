import Peer, { type DataConnection } from 'peerjs';
import { usePokerStore, type CardValue, type Player, type RoomState } from '../store/usePokerStore';

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

const PEER_PREFIX = 'scrum-poker-'; // To avoid collisions

class PeerManager {
  private peer: Peer | null = null;
  private connections: Map<string, DataConnection> = new Map();
  private hostConnection: DataConnection | null = null;
  private isHost: boolean = false;

  init(specificPeerId?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.destroy();
      
      this.peer = specificPeerId 
        ? new Peer(specificPeerId, { debug: 1, config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }] } }) 
        : new Peer({ debug: 1, config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }] } });

      this.peer.on('open', (id) => {
        console.log('My peer ID is: ' + id);
        resolve(id);
      });

      this.peer.on('connection', (conn) => {
        this.handleIncomingConnection(conn);
      });

      this.peer.on('error', (err) => {
        console.error('PeerJS error:', err);
        usePokerStore.getState().setError(err.message);
        reject(err);
      });
    });
  }

  async createRoom() {
    const { playerId, playerName } = usePokerStore.getState();
    const roomId = Math.random().toString(36).substring(2, 9);
    const hostPeerId = `${PEER_PREFIX}${roomId}`;
    
    if (!this.peer || this.peer.disconnected) {
      await this.init(hostPeerId);
    }
    
    this.isHost = true;
    
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
  }

  async joinRoom(roomId: string): Promise<void> {
    if (!this.peer || this.peer.disconnected) await this.init();
    if (!this.peer) throw new Error("Failed to initialize PeerJS");

    this.isHost = false;
    const hostPeerId = `${PEER_PREFIX}${roomId}`;
    
    return new Promise((resolve, reject) => {
      const conn = this.peer!.connect(hostPeerId, { reliable: true });
      this.hostConnection = conn;

      const timeout = setTimeout(() => {
        reject(new Error("Connection to host timed out. Please check the Room ID or your network."));
      }, 10000);

      const setupConnection = () => {
        console.log('Connected to host');
        usePokerStore.getState().setConnected(true);
        
        const { playerId, playerName } = usePokerStore.getState();
        this.sendAction({ type: 'JOIN', payload: { id: playerId, name: playerName, peerId: this.peer!.id } });
      };

      if (conn.open) {
        setupConnection();
      } else {
        conn.on('open', setupConnection);
      }

      conn.on('data', (data: any) => {
        if (data.type === 'STATE_UPDATE') {
          clearTimeout(timeout);
          usePokerStore.getState().updateRoomState(data.payload);
          resolve();
        }
      });

      conn.on('close', () => {
        console.log('Connection to host closed');
        this.handleHostDisconnect();
      });
      
      conn.on('error', (err) => {
        clearTimeout(timeout);
        console.error('Connection error:', err);
        reject(err);
        this.handleHostDisconnect();
      });
    });
  }

  private handleIncomingConnection(conn: DataConnection) {
    if (!this.isHost) {
      conn.close();
      return;
    }

    const setupIncoming = () => {
      this.connections.set(conn.peer, conn);
      this.broadcastState(); // send initial state
    };

    if (conn.open) {
      setupIncoming();
    } else {
      conn.on('open', setupIncoming);
    }

    conn.on('data', (data: any) => {
      if (data.type === 'ACTION') {
        this.processAction(data.payload);
      }
    });

    conn.on('close', () => {
      this.connections.delete(conn.peer);
      const peerId = conn.peer.replace(PEER_PREFIX, '');
      const state = usePokerStore.getState();
      const newPlayers = { ...state.players };
      delete newPlayers[peerId];
      usePokerStore.getState().updateRoomState({ players: newPlayers });
      this.broadcastState();
    });
    
    conn.on('error', (err) => {
      console.error('Incoming connection error:', err);
      this.connections.delete(conn.peer);
    });
  }

  private processAction(action: Action) {
    if (!this.isHost) return;
    
    const state = usePokerStore.getState();
    const newPlayers = { ...state.players };

    switch (action.type) {
      case 'JOIN':
        newPlayers[action.payload.id] = {
          id: action.payload.id,
          name: action.payload.name,
          card: null,
          joinedAt: Date.now(),
          peerId: action.payload.peerId,
        };
        usePokerStore.getState().updateRoomState({ players: newPlayers });
        break;
      case 'SELECT_CARD':
        if (newPlayers[action.payload.id]) {
          newPlayers[action.payload.id].card = action.payload.card;
          usePokerStore.getState().updateRoomState({ players: newPlayers });
        }
        break;
      case 'REVEAL':
        usePokerStore.getState().updateRoomState({ isRevealed: true });
        break;
      case 'RESET':
        Object.keys(newPlayers).forEach(key => {
          newPlayers[key].card = null;
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
        return; // transferHost handles state update and broadcasting
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
      payload: { roomId, hostId, players, isRevealed }
    };
    
    this.connections.forEach(conn => {
      if (conn.open) {
        conn.send(stateUpdate);
      }
    });
  }

  private handleHostDisconnect() {
    usePokerStore.getState().setConnected(false);
    
    // Begin host migration
    const state = usePokerStore.getState();
    const { players, playerId } = state;
    
    const activePlayers = Object.values(players).sort((a, b) => a.joinedAt - b.joinedAt);
    
    // Find the oldest player who is not the dropped host
    const nextHost = activePlayers.find(p => p.id !== state.hostId);
    
    if (nextHost && nextHost.id === playerId) {
      console.log('I am the new host!');
      // Promote self to host
      this.isHost = true;
      this.hostConnection = null;
      
      // We must re-create PeerJS with the room ID so others can connect to us?
      // Actually, others will connect to our peer ID directly as the new host.
      // But wait, what is the roomId? Usually roomId == initial host's peerId.
      // To keep it simple, we just update the hostId in state, and others will connect to the new hostId.
      const newHostId = playerId;
      
      // Update state
      usePokerStore.getState().updateRoomState({ hostId: newHostId });
      this.broadcastState(); // Broadcast to anyone who might have already reconnected to me (unlikely yet)
      
    } else if (nextHost) {
      console.log(`Connecting to new host: ${nextHost.id}`);
      // Connect to new host
      this.joinRoom(nextHost.id); // Wait, roomId stays the same, we just connect to new host peerId.
      // Need a joinHost method that takes hostId
    } else {
      console.log('No other players. Room closed.');
      usePokerStore.getState().leaveRoom();
    }
  }

  private transferHost(newHostId: string) {
    const state = usePokerStore.getState();
    const newHost = state.players[newHostId];
    if (!newHost) return;

    // 1. Tell everyone the new host
    usePokerStore.getState().updateRoomState({ hostId: newHostId });
    this.broadcastState();
    
    // 2. Demote self
    this.isHost = false;
    
    // 3. Connect to new host
    setTimeout(() => {
      this.connections.forEach(conn => conn.close());
      this.connections.clear();
      this.joinHost(newHost.peerId);
    }, 500); // Give time for broadcast
  }

  async joinHost(hostPeerId: string) {
    if (!this.peer || this.peer.disconnected) await this.init();
    if (!this.peer) return;

    this.isHost = false;
    
    const conn = this.peer.connect(hostPeerId, { reliable: true });
    this.hostConnection = conn;

    const setupConnection = () => {
      console.log('Connected to NEW host');
      usePokerStore.getState().setConnected(true);
      
      const { playerId, playerName } = usePokerStore.getState();
      this.sendAction({ type: 'JOIN', payload: { id: playerId, name: playerName, peerId: this.peer!.id } });
    };

    if (conn.open) {
      setupConnection();
    } else {
      conn.on('open', setupConnection);
    }

    conn.on('data', (data: any) => {
      if (data.type === 'STATE_UPDATE') {
        usePokerStore.getState().updateRoomState(data.payload);
      }
    });

    conn.on('close', () => {
      console.log('Connection to host closed');
      this.handleHostDisconnect();
    });
  }

  destroy() {
    if (this.peer) {
      this.peer.destroy();
      this.peer = null;
    }
    this.connections.clear();
    this.hostConnection = null;
    this.isHost = false;
  }
}

export const peerManager = new PeerManager();
