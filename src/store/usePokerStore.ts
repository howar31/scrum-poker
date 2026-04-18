import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export type CardValue = '0' | '0.5' | '1' | '2' | '3' | '5' | '8' | '13' | '21' | '?' | '☕' | null;

export interface Player {
  id: string;
  name: string;
  card: CardValue;
  joinedAt: number;
  peerId: string;
}

export interface RoomState {
  roomId: string | null;
  hostId: string | null;
  players: Record<string, Player>;
  isRevealed: boolean;
}

export type ToastVariant = 'info' | 'warning' | 'error' | 'success';

export interface Toast {
  id: string;
  message: string;
  variant: ToastVariant;
}

export type MigrationPhase = 'idle' | 'reclaiming' | 'waiting';

interface PokerState extends RoomState {
  playerId: string;
  playerName: string;
  animationsEnabled: boolean;
  theme: 'light' | 'dark';
  isConnected: boolean;
  error: string | null;
  toasts: Toast[];
  migrationPhase: MigrationPhase;

  // Actions
  setPlayerId: (id: string) => void;
  setPlayerName: (name: string) => void;
  setAnimationsEnabled: (enabled: boolean) => void;
  toggleTheme: () => void;
  setConnected: (connected: boolean) => void;
  setError: (error: string | null) => void;
  pushToast: (toast: Omit<Toast, 'id'>) => void;
  dismissToast: (id: string) => void;
  setMigrationPhase: (phase: MigrationPhase) => void;

  // Room Actions
  updateRoomState: (state: Partial<RoomState>) => void;
  leaveRoom: () => void;
}

export const generateId = () => Math.random().toString(36).substring(2, 9);

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
      toasts: [],
      migrationPhase: 'idle',

      setPlayerId: (id) => set({ playerId: id }),
      setPlayerName: (name) => set({ playerName: name }),
      setAnimationsEnabled: (enabled) => set({ animationsEnabled: enabled }),
      toggleTheme: () => set((state) => ({ theme: state.theme === 'light' ? 'dark' : 'light' })),
      setConnected: (connected) => set({ isConnected: connected, error: null }),
      setError: (error) => set({ error }),
      pushToast: (toast) =>
        set((state) => ({
          toasts: [...state.toasts, { ...toast, id: generateId() }],
        })),
      dismissToast: (id) =>
        set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
      setMigrationPhase: (phase) => set({ migrationPhase: phase }),

      updateRoomState: (newState) => set((state) => ({ ...state, ...newState })),
      leaveRoom: () =>
        set({
          roomId: null,
          hostId: null,
          players: {},
          isRevealed: false,
          isConnected: false,
          migrationPhase: 'idle',
        }),
    }),
    {
      name: 'scrum-poker-storage',
      // playerName/theme/animations: long-lived (localStorage via default storage).
      // playerId is kept in this same store via partialize; persisting it keeps
      // the same identity across page reloads so reconnects are recognised as
      // the same player (instead of a duplicate with the same name).
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        playerId: state.playerId,
        playerName: state.playerName,
        animationsEnabled: state.animationsEnabled,
        theme: state.theme,
      }),
    }
  )
);
