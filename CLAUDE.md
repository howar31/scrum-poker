# Project: Scrum Poker

## Architecture Pointer

See `SPEC.md` for detailed architecture, state management, and P2P implementation rules.

## Commands

- **Node**: 22 (pinned via `.nvmrc`; run `nvm use` in repo root — Vite requires Node ≥ 20.19 / 22.12)
- **Dev**: `npm run dev`
- **Build**: `npm run build`
- **Lint**: `npm run lint`
- **Regenerate PWA icons**: `npm run icons` (Puppeteer rasterises `public/icon.svg` → `apple-touch-icon.png` / `icon-192.png` / `icon-512.png`; output committed, production build doesn't need Puppeteer)
- **Regenerate README screenshots**: `npm run screenshots` (requires dev server at :5173 and `ffmpeg` on PATH; produces 5 showcase PNGs + animated `hero.gif` under `docs/screenshots/` via Puppeteer screenshot / `page.screencast` → ffmpeg palette pipeline; mobile images are 642×1389 to match the user-supplied `pwa.png` natural size so the README 3-column table lines up)
- **E2E driver**: `npm run e2e -- --help` (browser automation via `scripts/e2e.js`, thin CLI over `scripts/e2e/modes/*.js` with shared utilities in `scripts/e2e/helpers.js`). 24 modes, each with its own `npm run e2e:<mode>` shortcut. **Fastest way to run the full suite**: `VITE_E2E=1 npm run dev` + `npm run e2e:all` (spawns every assertion mode as a child process, aggregates pass/fail, exits 0 iff every mode passed). Individual modes: `host`/`swarm`/`observe` (diagnostic, no assertions), `check` (exit-code CI smoke), and 20 assertion modes that print a final `Result:` line (`transfer`, `crash`, `kick`, `vote`, `refresh`, `kick-window`, `late-joiner`, `deadman`, `state-persist` (alias `e2e:state`), `disarm`, `join-ux`, `settings`, `copy-toast`, `solo-leave`, `panel-ux`, `split-brain`, `crash-mid-transfer`, `election-race`, `partition`). Assertion modes that depend on the zustand store require `VITE_E2E=1` on the dev server (exposes `window.__POKER_STATE__` — production builds never ship it). Full per-mode semantics in `SPEC.md` → "End-to-End Harness".

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
- **When adding a new e2e mode**, update ALL of these together in the same commit so future agents can find it: (1) create `scripts/e2e/modes/<name>.js` exporting `run(browser, config)` and ending with `printResult({...})` (see any existing mode for the shape — reuse `setupRoom`, `snap`, `kickPlayer`, etc. from `scripts/e2e/helpers.js`); (2) register the module in `scripts/e2e.js` — add to `ALL_MODES` whitelist AND `MODE_TO_MODULE` map; (3) extend the `HELP_TEXT` block with the mode's npm shortcut, exit behavior, and pass criterion; (4) `package.json` — add an `e2e:<name>` script entry; (5) `scripts/e2e/modes/all.js` — add to the `MODES` list so `e2e:all` runs it; (6) `README.md` — add a row to the mode table in the "End-to-end browser automation" section; (7) `SPEC.md` → "End-to-End Harness" → add a bullet under "Modes" with explicit **Exits?** and **Asserts:** fields.

## P2P Rules

- `playerId` is persisted so reloads are recognised as reconnects (not duplicates). `epoch` is NOT persisted — fresh load learns the current epoch from the host's first STATE.
- **Single source of host truth is the PeerJS broker at `scrum-poker-{roomId}`.** A client becomes host iff `new Peer('scrum-poker-{roomId}')` succeeds. Anyone else trying the same ID concurrently gets `unavailable-id` and must become a follower. Split-brain is structurally impossible. Never flip `isHost = true` (or the FSM equivalent) without first owning the well-known ID.
- **FSM**: 5 states in `peerManager.ts` — `IDLE / HOSTING / FOLLOWING / ELECTING / FOLLOWING_WAIT`. Host transitions go through `becomeHost()` (opens well-known peer → flips fsm + bumps epoch → starts heartbeat → broadcasts STATE). Client transitions go through `joinAsClient()` (connects to well-known, sends JOIN, resolves on first STATE).
- **Heartbeat**: host broadcasts `STATE` (full snapshot) every 2 s (`HEARTBEAT_INTERVAL_MS`). No separate PING — STATE serves double duty. Clients reset a rolling 8 s watchdog (`HEARTBEAT_TIMEOUT_MS`) on ANY inbound data. Watchdog fire → `onHostConnectionLost` → `runMigration`.
- **`runMigration`**: single loop per client. Computes `iAmElector` and `rank`. Electors (designated successor, or rank-0 if no LEAVING) try `openPeer(wellKnown)` immediately. Non-electors sit in grace for `MIGRATION_GRACE_MS + rank * RANK_STAGGER_MS` ms, then unlock Phase B (may also try to elect; broker arbitration still guarantees one winner). Total budget `MIGRATION_BUDGET_MS = 60 s` (covers the PeerJS broker `alive_timeout` so dirty crashes still resolve); then `leaveRoom` + toast.
- **Messages (4 types)**: `STATE { payload: RoomState }`, `ACTION { epoch, payload }`, `LEAVING { epoch, nextHostId | null }`, `KICKED { epoch }`. Every message carries an `epoch`; receivers drop anything with `epoch < localEpoch` (exception: JOIN is honored regardless, to allow reconnection).
- **Graceful leave / transferHost**: broadcasts `LEAVING { nextHostId }`, waits `LEAVING_FLUSH_MS = 300 ms` for SCTP flush, destroys peer (releases well-known ID). No ACK protocol — anyone who misses LEAVING falls back to watchdog + rank-based recovery via `runMigration`, converging on the same outcome via broker arbitration. `transferHost` additionally re-enters `runMigration` as a non-elector to rejoin the new host as a client.
- **Kick**: host's `processAction('KICK')` removes victim from `state.players`, records playerId in `kickedUntil` for `KICK_REJECT_WINDOW_MS = 5 s`, removes victim's conn from `this.connections` **before** the trailing `broadcastState()` (otherwise kicked peer races STATE putting them back in Room UI), sends `KICKED`, waits `KICK_MESSAGE_FLUSH_MS = 200 ms`, closes conn. Client: `handleKicked` sets `intentionalLeave`, toasts, `leaveRoom`, destroys peer. The 5 s window defeats auto-reconnect without permanently banning the user.
- **Ghost cleanup**: `becomeHost` schedules a one-shot `scheduleGhostCleanup` (20 s, `GHOST_CLEANUP_DELAY_MS`). After the sweep, any player whose `peerId` isn't in `this.connections.keys()` is removed + toasted as offline. Handles the crashed-but-still-in-players-map old host.
- **Half-open incoming cleanup**: `handleIncomingConnection` drops any incoming DataConnection that hasn't reached `open` within `INCOMING_OPEN_TIMEOUT_MS = 20 s`. Necessary because Arc + Chrome pairs can leave ICE stuck in `checking` forever; without this the host accumulates dead RTCPeerConnection objects across every client retry. Doesn't fix the underlying connectivity gap — that still needs TURN.
- Connection state is three-valued: `connectionStatus: 'connected' | 'reconnecting' | 'disconnected'` in the store. Migration sets `reconnecting`; `becomeHost` / first STATE on `joinAsClient` flip back to `connected`.
- **Broker re-register**: `peer.on('disconnected')` (WebSocket to PeerJS broker dropped while Peer alive) flips status to `reconnecting` and calls `peer.reconnect()` — UNLESS `intentionalLeave` is set (leave / transferHost teardown). `destroyPeer()` calls `removeAllListeners()` before `destroy()` to avoid reconnect races on teardown.
- **New-joiner retry (`joinRoomWithRetry`)**: Home's Join flow. Returns `{ cancel, promise }`. Loops `joinAsClient(wellKnown)` with 5 s per-attempt timeout until success or cancel. `onProgress` reports `peer-unavailable` (ID not registered) vs `timeout` (broker has ID but peer unreachable — migration likely in progress). UI shows a non-blocking "still trying" banner after 30 s with Dismiss / Give up.
