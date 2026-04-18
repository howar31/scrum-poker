import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './i18n'
import App from './App.tsx'
import { usePokerStore } from './store/usePokerStore'

// Test-only hook: expose the store getter on `window` when the Vite dev
// server is started with `VITE_E2E=1 npm run dev`. The e2e suite uses
// this to assert store state directly (votes, hostId, migrationPhase)
// instead of relying on fragile DOM scraping. Gated so production
// builds never ship it.
if (import.meta.env.VITE_E2E) {
  (window as unknown as { __POKER_STATE__: typeof usePokerStore.getState }).__POKER_STATE__ =
    usePokerStore.getState
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
