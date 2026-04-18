# Project: Scrum Poker

## Architecture Pointer

See `SPEC.md` for detailed architecture, state management, and P2P implementation rules.

## Commands

- **Dev**: `npm run dev`
- **Build**: `npm run build`
- **Lint**: `npm run lint`
- **E2E driver**: `npm run e2e -- --help` (browser automation via `scripts/e2e.js`). Shortcuts: `e2e:host`, `e2e:swarm`, `e2e:check`, `e2e:observe`. The swarm and observe modes need `--room`; swarm/e2e accept `--count`.

## Conventions

- **Language**: TypeScript (React)
- **Styling**: TailwindCSS
- **State Management**: Zustand (with `persist` middleware on `localStorage`)
- **P2P**: PeerJS (Room ID is `scrum-poker-{roomId}`, where `roomId` is 7-char Crockford Base32)
- **i18n**: `react-i18next`. All user-facing strings live in `src/i18n/locales/{en,zh-TW}.json` — never hardcode strings in JSX. In components use `useTranslation()`; outside React (e.g. `peerManager.ts`) import the `i18n` instance directly.
- **Code Style**: Comments must be in English.
- Use `lucide-react` for icons.
- Prefer `clsx` and `tailwind-merge` for conditional classes.
- Use `framer-motion` `AnimatePresence` for list enter/exit animations; respect `animationsEnabled` store flag.
- Pointer-driven animations use `useMotionValue` + `useSpring` / `useTransform` / `useMotionTemplate` instead of re-rendering on mouse moves.
- User-facing notifications go through the store's `pushToast` action, not `alert()` or inline error blocks.
- Home page must expose exactly one primary CTA at a time (Create OR Join, chosen by `?room=` URL param).
- Destructive / hard-to-undo actions (Leave, host transfer, kick) use a two-step arm-and-confirm pattern with a 3 s auto-disarm. Never a one-click action.
- Moderator controls (transfer host, kick) live in `PlayersPanel` only — never on Table hover.
- Every actionable control carries `data-slot="<component>-<action>"` for stable e2e automation. Add one when you add a new button / input. Full index: `SPEC.md` → "data-slot convention".

## P2P Rules

- `playerId` is persisted so reloads are recognised as reconnects (not duplicates).
- `createRoom()` must set `isHost = true` before awaiting `init()` — fixes a race where fast joiners are rejected. Same applies to `reclaimHostIdentity()` during migration.
- Unplanned host disconnect: `scheduleReconnect` (5 attempts, ~31 s) then `handleHostDisconnect` computes the successor.
- Graceful host leave: the leaving host broadcasts `HOST_LEAVING { nextHostId }` before `destroy()`; the leaving host is the **authoritative** decider, clients never recompute. Skips the 31 s grace period.
- New host (unplanned disconnect, graceful leave, or manual `transferHost`) calls `reclaimHostIdentity(roomId)` to take over `scrum-poker-{roomId}` so late joiners and remaining clients can find them at the well-known peer ID. `migrationPhase` drives the UI overlay (`idle` / `reclaiming` / `waiting`).
- After a reclaim, `scheduleGhostCleanup` (20 s one-shot) sweeps any players whose `peerId` isn't in the new host's `connections` — catches the crashed old host and any other peers who didn't rejoin.
- Connection state is three-valued: `connectionStatus: 'connected' | 'reconnecting' | 'disconnected'` in the store. Never bring back `isConnected: boolean` — the binary lost too much. `peer.on('disconnected')` must always flip status to `reconnecting` and call `peer.reconnect()`; a subsequent `peer.on('open')` flips it back to `connected`.
- UI-initiated leave calls `peerManager.leave()`; internal cleanup uses `peerManager.destroy()` — they differ in whether they cancel pending reconnects and broadcast `HOST_LEAVING`.
