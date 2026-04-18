# Project: Scrum Poker

## Architecture Pointer

See `SPEC.md` for detailed architecture, state management, and P2P implementation rules.

## Commands

- **Dev**: `npm run dev`
- **Build**: `npm run build`
- **Lint**: `npm run lint`
- **E2E driver**: `npm run e2e -- --help` (browser automation via `scripts/e2e.js`, thin CLI over `scripts/e2e/modes/*.js` with shared utilities in `scripts/e2e/helpers.js`). 20 modes, each with its own `npm run e2e:<mode>` shortcut. **Fastest way to run the full suite**: `VITE_E2E=1 npm run dev` + `npm run e2e:all` (spawns every assertion mode as a child process, aggregates pass/fail, exits 0 iff every mode passed). Individual modes: `host`/`swarm`/`observe` (diagnostic, no assertions), `check` (exit-code CI smoke), and 16 assertion modes that print a final `Result:` line (`transfer`, `crash`, `kick`, `vote`, `refresh`, `kick-window`, `late-joiner`, `deadman`, `state-persist` (alias `e2e:state`), `disarm`, `join-ux`, `settings`, `copy-toast`, `solo-leave`, `panel-ux`). Assertion modes that depend on the zustand store require `VITE_E2E=1` on the dev server (exposes `window.__POKER_STATE__` — production builds never ship it). Full per-mode semantics in `SPEC.md` → "End-to-End Harness".

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

- `playerId` is persisted so reloads are recognised as reconnects (not duplicates).
- `createRoom()` must set `isHost = true` before awaiting `init()` — fixes a race where fast joiners are rejected. Same applies to `selfPromoteHost()` during migration.
- **Heartbeat**: host broadcasts `{type:'PING'}` every 2 s over every DataConnection. Clients reset a single rolling 8 s watchdog on ANY inbound data (PING or otherwise). Watchdog fires → `onHostConnectionLost()`. Replaces the old "wait 15–30 s for WebRTC to notice silent peer" path.
- **Option A reconnect**: `onHostConnectionLost()` first does one quick 2 s probe to the well-known ID (covers transient network blips), then migrates on failure. No more 5-attempt `scheduleReconnect` loop.
- **Direct-connect migration**: on migration the successor either (a) self-promotes and keeps its original peer ID so existing clients can direct-connect, or (b) the other clients call `directConnectToSuccessor` which alternates direct-peer and well-known-ID attempts over a 20 s budget (so the fallback fires if the successor's background reclaim opens the secondary peer before the direct channel). End-to-end reunion ≈ 10 s regardless of PeerJS broker `alive_timeout`. `handleHostLeaving` holds `reconnecting` through its full run so conn.close-triggered migration can't race into an in-flight HOST_LEAVING-triggered one (caused dropped clients during 4+ way transfers).
- **Secondary well-known peer**: a self-promoted host opens a SECOND `Peer` at `scrum-poker-{roomId}` as a background task (`reclaimWellKnownInBackground`, backoff covers ~70 s) purely to serve late joiners via `?room=XYZ`. The primary peer is never torn down, so direct-connected members are not disrupted. `createRoom()` stays single-peer because the primary peer already owns the well-known ID.
- Graceful host leave / manual `transferHost`: leaving host broadcasts `HOST_LEAVING { nextHostId }` and **waits for HOST_LEAVING_ACK from every client (5 s per-connection timeout, or conn-close as implicit ACK) before `destroy()`**. `transferHost` additionally **rotates `state.hostId = newHostId` locally AND broadcasts that STATE_UPDATE BEFORE** the HOST_LEAVING handshake — so: (a) the leaving host's UI moves the crown off itself immediately, (b) still-connected clients see the new hostId through the existing broadcast channel (defense against HOST_LEAVING packet loss cross-network), (c) the designated successor observes `hostId === my playerId && !isHost` in the STATE_UPDATE data handler and self-promotes even if the subsequent HOST_LEAVING never arrives. Client-side `handleHostLeaving` still saves `authoritativeSuccessor` + sends ACK as its first action so conn.close-before-HOST_LEAVING races are also covered. Clients trust the authoritative `nextHostId` and direct-connect to its `peerId` — no well-known probe needed.
- **Deadman recovery (`recoverNoHost`)**: if `directConnectToSuccessor` exhausts its 20 s budget (e.g. an ACK-missed client couldn't find the designated successor and nobody became host), clients run `recoverNoHost` instead of `leaveRoom`. Each computes its `joinedAt` rank; rank 0 (the ex-host / room creator, always the oldest) self-promotes immediately. Higher ranks wait `rank * 3 s` and try a well-known connect before self-promoting. Preserves the room rather than evicting everyone, and matches the expectation that the original host comes back first when a handoff fails.
- **Kick semantics**: host sends `KICKED` to the victim before closing their DataConnection, AND remembers the playerId in `kickedUntil` for 5 s. Client receiving `KICKED` sets `intentionalLeave`, pushes toast, calls `leaveRoom` + `destroy` — no auto-reconnect. Without the 5 s window, a kicked client mid-reconnect (conn.close → probe → JOIN) would pop right back in. After 5 s, manual re-join works normally — kick is "stop the auto-reconnect loop", not a ban. Host also removes the victim's conn from `this.connections` **before** the trailing `broadcastState()` so the kicked peer doesn't race a STATE_UPDATE that puts them back in Room UI.
- After self-promote, `scheduleGhostCleanup` (20 s one-shot) sweeps any players whose `peerId` isn't in the new host's `connections` — catches the crashed old host.
- Connection state is three-valued: `connectionStatus: 'connected' | 'reconnecting' | 'disconnected'` in the store. Never bring back `isConnected: boolean` — the binary lost too much. `peer.on('disconnected')` flips status to `reconnecting` and calls `peer.reconnect()` — UNLESS `intentionalLeave` is set (leave / transferHost teardown), in which case it no-ops. `destroy()` calls `peer.removeAllListeners()` before `peer.destroy()` for the same reason: a reconnect during teardown would hold the old peer ID on the broker and block the successor's reclaim.
- UI-initiated leave calls `peerManager.leave()`; internal cleanup uses `peerManager.destroy()` — they differ in whether they cancel pending reconnects and broadcast `HOST_LEAVING`. `destroy()` also tears down `wellKnownPeer`.
- New-joiner retry (`joinRoomWithRetry`): Home's Join flow uses a cancellable retry handle that branches progress messaging on `peer-unavailable` (ID not registered — room doesn't exist OR just released) vs timeout (broker still holds ID — migration likely in progress). No internal time cap — the retry loop keeps running until cancel or success. Home.tsx surfaces a non-blocking "still haven't reached the room" banner after 30 s with Dismiss (hide banner, retry keeps running) / Give up (cancel). The background retry never pauses while the banner is on screen, so the user can walk away and come back.
