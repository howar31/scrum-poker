import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './i18n'
import App from './App.tsx'
import { usePokerStore } from './store/usePokerStore'
import { peerManager } from './utils/peerManager'

// Test-only hooks: expose the store getter and a PeerManager remote-control
// surface on `window` when the Vite dev server is started with
// `VITE_E2E=1 npm run dev`. The e2e suite uses these to assert store state
// directly (votes, hostId, migrationPhase) and to drive ICE restarts on
// demand without waiting for real network events. Gated so production
// builds never ship them.
if (import.meta.env.VITE_E2E) {
  const w = window as unknown as {
    __POKER_STATE__: typeof usePokerStore.getState
    __POKER_PEER__: { restartIce: () => void }
  }
  w.__POKER_STATE__ = usePokerStore.getState
  w.__POKER_PEER__ = {
    restartIce: () => peerManager.triggerIceRestartForTest(),
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
