import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type CardValue = '0' | '0.5' | '1' | '2' | '3' | '5' | '8' | '13' | '21' | '?' | '☕' | null;

export interface Player {
  id: string;
  name: string;
  card: CardValue;
  joinedAt: number;
}

export interface RoomState {
  roomId: string | null;
  hostId: string | null;
  players: Record<string, Player>;
  isRevealed: boolean;
}

interface PokerState extends RoomState {
  playerId: string;
  playerName: string;
  animationsEnabled: boolean;
  theme: 'light' | 'dark';
  isConnected: boolean;
  error: string | null;
  
  // Actions
  setPlayerId: (id: string) => void;
  setPlayerName: (name: string) => void;
  setAnimationsEnabled: (enabled: boolean) => void;
  toggleTheme: () => void;
  setConnected: (connected: boolean) => void;
  setError: (error: string | null) => void;
  
  // Room Actions
  updateRoomState: (state: Partial<RoomState>) => void;
  leaveRoom: () => void;
}

const generateId = () => Math.random().toString(36).substring(2, 9);

export const usePokerStore = create<PokerState>()(
  persist(
    (set) => ({
      roomId: null,
      hostId: null,
      players: {},
      isRevealed: false,
      
      playerId: generateId(),
      playerName: '',
      animationsEnabled: true,
      theme: 'dark',
      isConnected: false,
      error: null,

      setPlayerId: (id) => set({ playerId: id }),
      setPlayerName: (name) => set({ playerName: name }),
      setAnimationsEnabled: (enabled) => set({ animationsEnabled: enabled }),
      toggleTheme: () => set((state) => ({ theme: state.theme === 'light' ? 'dark' : 'light' })),
      setConnected: (connected) => set({ isConnected: connected, error: null }),
      setError: (error) => set({ error }),
      
      updateRoomState: (newState) => set((state) => ({ ...state, ...newState })),
      leaveRoom: () => set({ roomId: null, hostId: null, players: {}, isRevealed: false, isConnected: false }),
    }),
    {
      name: 'scrum-poker-storage',
      partialize: (state) => ({ 
        playerName: state.playerName, 
        playerId: state.playerId,
        animationsEnabled: state.animationsEnabled,
        theme: state.theme 
      }),
    }
  )
);