# Project: Scrum Poker

## Architecture Pointer

See `SPEC.md` for detailed architecture, state management, and P2P implementation rules.

## Commands

- **Dev**: `npm run dev`
- **Build**: `npm run build`
- **Lint**: `npm run lint`

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

## P2P Rules

- `playerId` is persisted so reloads are recognised as reconnects (not duplicates).
- `createRoom()` must set `isHost = true` before awaiting `init()` — fixes a race where fast joiners are rejected.
- Client disconnection triggers `scheduleReconnect` (exp backoff, 5 attempts) before falling back to host migration.
- UI-initiated leave calls `peerManager.leave()`; internal cleanup uses `peerManager.destroy()` — they differ in whether they cancel pending reconnects.
