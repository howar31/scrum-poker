# Scrum Poker - Architecture & Feature Spec

## Overview

A purely frontend, serverless Peer-to-Peer (P2P) Scrum Poker application. It leverages WebRTC (encapsulated by PeerJS) for real-time state synchronization among room participants.

## Core Architecture

- **Topology**: Star Topology (Host-centric)
  - The creator of the room is the initial Host.
  - Peers connect only to the Host.
  - The Host receives actions (e.g., SELECT_CARD) and broadcasts the updated full state to all Peers.

## Features & Mechanisms

### 1. P2P Connection (PeerJS)

- **Signaling**: Uses PeerJS's public cloud broker by default.
- **Connections**: Data connections are strictly between the Host and individual Peers, using `serialization: 'json'` for transparent packet inspection in DevTools.
- **ICE Servers**: Explicit STUN servers (`stun.l.google.com:19302`, `global.stun.twilio.com:3478`). No TURN server is configured — peers behind symmetric NAT or with restrictive browser WebRTC policies (e.g., Arc Browser's mDNS anonymisation) may fail to connect.
- **Room Identification**: Room IDs are 7-character Crockford Base32 strings (`0-9A-Z` minus `I/L/O/U`) generated with `crypto.getRandomValues`. The Host's PeerJS id is `scrum-poker-{roomId}`, enabling any joiner to resolve the Host deterministically. See `src/utils/roomId.ts`.
- **Invite Links**: Joining a room via an invite link uses URL search parameters (`?room=XYZ`). Room IDs are normalised to uppercase with common character substitutions (`I/L → 1`, `O → 0`, `U → V`) to tolerate manual mistyping.
- **Race-free role assignment**: `createRoom()` sets `isHost = true` *before* awaiting PeerJS init to close the window where a racing incoming connection would be rejected by the `!isHost` guard in `handleIncomingConnection`.
- **Connection timeout**: `joinRoom()` rejects after 20s with a user-facing error. If Arc Browser is detected, the error message appends Arc-specific guidance (`arc://flags` → "Anonymize local IPs exposed to WebRTC" → Disabled).
- **Error surfacing**: Initial connection failures (create/join) are surfaced by the caller (`Home.tsx`) via `pushToast({ variant: 'error' })`. Post-init transient peer errors (stale signaling events after a network blip) are routed directly to toasts from `peerManager` so they auto-dismiss and don't persist after reconnect succeeds. There is no static error banner — the `error` state field in the store is retained for completeness but is not rendered.

### 2. State Management (Zustand)

- Persists user preferences (`playerId`, `playerName`, `theme`, `animationsEnabled`) to `localStorage` via `zustand/middleware` `persist`. Persisting `playerId` is critical: it allows a refreshing client to be recognised as the *same* player when they reconnect, instead of appearing as a duplicate under their original name.
- Manages transient room state (`roomId`, `hostId`, `players`, `isRevealed`).
- Tracks `connectionStatus: 'connected' | 'reconnecting' | 'disconnected'` for the header dot. `connected` = PeerJS signaling registered and P2P live. `reconnecting` = broker WebSocket dropped / migration in progress / heartbeat watchdog tripped / well-known probe in flight — existing DataConnections may still flow. `disconnected` = all recovery paths exhausted, user should refresh or create a new room.
- Manages in-memory toast queue (`toasts`, `pushToast`, `dismissToast`) consumed by `src/components/Toast.tsx`.
- `Player` object structure: `{ id, name, card, joinedAt, peerId }`.

### 3. Host Migration & Reconnection

Goal: **existing members reunited in ≈ 10 s** regardless of how long the PeerJS broker holds the old host's ID. Late joiners arriving via `?room=XYZ` during a migration use the cancellable retry UI and typically succeed within 30 s.

- **Application-layer heartbeat**: The host broadcasts `{type: 'PING'}` over every DataConnection every 2 s (`PING_INTERVAL_MS`). Clients reset a single rolling 8 s watchdog (`PING_TIMEOUT_MS`) on ANY inbound message — PING, `STATE_UPDATE`, or `HOST_LEAVING`. If the watchdog fires, the client calls `onHostConnectionLost()` without waiting for WebRTC's own ICE consent check (15–30 s). This is the primary liveness signal; DataConnection `close` / `error` events still route through the same path as a fallback.
- **Broker re-registration**: `peer.on('disconnected')` still fires when the WebSocket to PeerJS signaling drops (tab backgrounded, network blip) while the Peer object is alive locally. The handler flips `connectionStatus='reconnecting'` and calls PeerJS's built-in `peer.reconnect()` to re-register the same peer ID; a subsequent `peer.on('open')` flips status back to `connected`. The handler short-circuits when `intentionalLeave` is set, and `destroy()` calls `peer.removeAllListeners()` before `peer.destroy()` — both prevent a reconnect-race during migration teardown that would hold the old peer ID alive on the broker.
- **Option A reconnect**: `onHostConnectionLost()` first performs ONE quick 2 s probe (`WELL_KNOWN_PROBE_TIMEOUT_MS`) to the well-known ID, which cheaply rules out transient network blips. On probe failure it escalates to `handleHostDisconnect()`. The `reconnecting` flag prevents concurrent triggers (heartbeat + conn.close can race) from running the probe twice. `handleHostLeaving` also holds the flag for its full run so the old host's peer teardown — which fires `conn.on('close')` on every client — doesn't race a second migration into an in-flight one (symptom: random clients dropped out of the room during a 4-way transfer).
- **Graceful host leave / manual transfer (fast path)**: The leaving host broadcasts `HOST_LEAVING { nextHostId }` — the authoritative successor choice, computed once using the oldest-non-host-by-`joinedAt` rule — before tearing down. A 50 ms defer flushes the data-channel queue first. Receivers skip the Option A probe entirely (we *know* the old host is gone) and jump straight to direct-connect. `transferHost` is the same flow; the demoting host additionally releases the well-known ID peer so the successor's background reclaim can succeed, then rejoins as a client via `directConnectToSuccessor`.
- **Unplanned host disconnect**: After probe failure, `handleHostDisconnect()` picks the same successor (oldest non-host by `joinedAt`). A `migrationAttempted` flag prevents infinite loops — second entry in one session = give up and leave. If the successor is self → `selfPromoteHost()`, else → `directConnectToSuccessor(successor.peerId)`.
- **Direct-connect to successor (the ≈10 s path)**: Clients do NOT wait for the new host to reclaim the well-known ID. `directConnectToSuccessor` runs a retry loop budgeted at `MIGRATION_RECONNECT_BUDGET_MS = 20 s` that alternates between two targets every attempt: the successor's original random peer ID (reachable as soon as they flip `isHost = true`) and the well-known ID `scrum-poker-{roomId}` (reachable as soon as their background reclaim opens the secondary peer). Whichever channel opens first wins. Fallback to well-known matters because the successor can briefly reject direct connections while still a client (the `!isHost` guard in `handleIncomingConnection`); a single target would give up before they're ready.
- **`selfPromoteHost`**: Flips `isHost = true`, clears the dead host connection, broadcasts state, starts the heartbeat interval, and kicks off `reclaimWellKnownInBackground` WITHOUT awaiting. The primary peer keeps its original random ID forever; existing members direct-connect to it. `scheduleGhostCleanup` (20 s) runs here too, sweeping any player whose `peerId` isn't in `connections` by the time it fires.
- **Secondary well-known peer (background, late joiners only)**: `reclaimWellKnownInBackground` retries `openWellKnownPeer(hostPeerId)` on the backoff `RECLAIM_DELAYS_MS = [0, 1, 2, 4, 8, 15, 20, 20] s ≈ 70 s` (covers the full 60 s broker `alive_timeout`). Each successful `openWellKnownPeer` creates a *second* `Peer` instance at `scrum-poker-{roomId}` stored as `this.wellKnownPeer`; its `connection` events route through the same `handleIncomingConnection` as the primary. The primary peer is untouched, so existing DataConnections never break. On any retry failure the slot is cleared and the loop tries again. `destroy()` tears down both peers. `transferHost` releases `wellKnownPeer` before handing off so the new host can claim the ID immediately.
- **New joiner via `?room=XYZ` during migration**: `joinRoomWithRetry(roomId, { onProgress })` in `peerManager` returns a `{ cancel, promise }` handle. Internally loops `joinViaHost(well-known)` with a 5 s per-attempt timeout until success or cancel — no internal timeout, because the UI is responsible for presenting a way out. `onProgress` reports `{ kind: 'connecting' | 'peer-unavailable' | 'timeout' }` so the UI can tell the user *why* it's still waiting: `peer-unavailable` (ID not registered — room doesn't exist, or broker just released it mid-migration) vs `timeout` (broker still has the ID but the peer is unreachable — migration likely in progress). `Home.tsx`'s `JoinForm` shows a spinner + progress message throughout; after a side-timer of 30 s (`LONG_WAIT_PROMPT_MS`) a non-blocking amber banner appears ("Still haven't reached the room — retry continues in the background") with a Dismiss button (hides the banner, retry never paused) and a Give up button (cancels the handle → destroys any in-flight peer → returns to the form). This replaces the previous "Keep trying (30 s) / Give up" prompt so the user can walk away without actively extending the window.
- **Migration UI**: `src/components/MigrationOverlay.tsx` reads `migrationPhase` from the store (`'idle' | 'reclaiming' | 'waiting'`) and renders a semi-transparent overlay with a spinner and phase-specific copy while migration is in progress. Rendered at the `App` root so it covers everything.
- **Intentional leave**: `peerManager.leave()` (invoked from the UI's Leave Room button) cancels any pending reconnect, tears everything down (primary + secondary peers), and flips `isHost = false`. Internal `destroy()` (called during peer re-initialisation) does *not* touch the intentional-leave flag, so reconnect flows survive peer re-creation.
- **Unload guard**: while `roomId` is set, `App.tsx` installs a `beforeunload` listener that calls `preventDefault()` + sets `returnValue`, so refresh / tab-close / window-close triggers the browser's native "Leave site?" prompt on desktop / Android. iOS Safari ignores `beforeunload`, so `src/index.css` also sets `overscroll-behavior-y: contain` on `html, body` to block the pull-to-refresh gesture (the most common accidental refresh on mobile). Address-bar refresh and swipe-back on iOS remain unblockable, but `playerId` persistence + URL `?room=XYZ` means a refreshed client can click Join again to return.

### 4. Reconnection Identity

- Because `playerId` is persisted, a client that refreshes or briefly disconnects rejoins under the same identity. The Host's `processAction` JOIN handler detects this: if the incoming `playerId` already exists in `players`, it updates `peerId` and `name` but preserves `joinedAt` (keeping host-election ordering stable), and emits a `{name} 已重新連上` toast. If the player is new, a `{name} 已加入` toast is shown.
- When a client connection closes on the Host side, the Host looks up the player by matching `peerId`. The player is removed and a `{name} 已離線` toast is broadcast.
- **Ghost cleanup after self-promote**: The per-connection close handler covers normal disconnects, but after `selfPromoteHost` the new host's `connections` map starts empty while the `players` map still carries everyone from the previous host's last broadcast — including the crashed old host. `selfPromoteHost` schedules a one-shot `scheduleGhostCleanup` (20 s) on success: live clients land back via direct-connect within that window, and anyone whose `peerId` still isn't in `connections.keys()` when the timer fires gets removed + toasted as offline. `transferHost` benefits from the same sweep — the demoting host rejoins as a client well before the 20 s mark. With heartbeat in place, DataConnection close events fire within seconds for genuinely gone peers too, so ghosts self-heal outside the sweep window.

### 5. Arc Browser Support

- Arc identifies itself as Chrome in `navigator.userAgent` but exposes Arc-specific CSS variables on `:root` (e.g., `--arc-palette-title`). `src/utils/browserDetect.ts` detects Arc by reading this variable.
- Arc's default WebRTC privacy settings (mDNS anonymisation of local IPs) prevent successful ICE negotiation without a TURN server. The Home page displays a prominent amber warning when Arc is detected, instructing the user to change the `arc://flags` setting or switch browsers.

### 6. Room Layout (Table + Hand + Stats)

- **App header** (`src/App.tsx`) — single horizontal bar that doubles as the room header when `roomId` is set. Left side: Scrum Poker logo, Room ID button (click = copy Room ID), link icon button (click = copy invite URL), and a three-state connection indicator — a colored dot (🟢 connected / 🟡 reconnecting with pulse / 🔴 disconnected with pulse) plus a short status label (`md:inline`) that renders only on desktop where width allows; the whole control still has a hover `title` with the detail copy, and clicking it pushes a toast with the same info so mobile users can tap to find out why it's yellow. Right side: a **Players** pill (room mode only) showing the current player count and opening the `PlayersPanel` drawer, then a `MoreVertical` trigger that opens a dropdown menu containing Language / Animations / Theme rows, plus a **Leave room** entry (room mode only) separated by a divider. Leave uses a two-step confirmation: the first click arms the item (red fill + "Click again to confirm" hint) and a 3 s timer auto-disarms it; the second click actually leaves. Opening/closing the menu or clicking outside also disarms. The dropdown closes on outside click or `Escape`. Collapsing every secondary action into one menu keeps the header compact on mobile where the right-side buttons used to overlap the Room ID.
- **Table** (`src/components/Table.tsx`) — green-felt surface with all players' played cards arranged in a responsive `flex-wrap` row. Each card is rotated ±6° based on a deterministic hash of `player.id`, so the same player's card always leans the same direction but different players lean differently, producing an organic "cards tossed on a table" feel without risking upside-down cards. The Table no longer carries moderator controls — transfer/kick live in `PlayersPanel`.
- **Players panel** (`src/components/PlayersPanel.tsx`) — the Players pill lives in the `App.tsx` header (so the Table and Statistics columns stay vertically aligned); it opens an on-demand drawer: right-side slide-in on desktop (`md:w-96`), bottom sheet on mobile (`max-h-[75vh]`, rounded top). Open/close state is hoisted to the Zustand store as `playersPanelOpen` so the header pill (trigger) and the `Room` subtree (consumer) share one source of truth. The panel lists every player with host crown, "You" badge, and vote status (empty circle = unvoted, green check = voted pre-reveal, mono value = post-reveal). Host-only **Make host** / **Kick** buttons next to each other player use a two-step confirmation: first click arms the button (blue/red fill + "再點一次確認" hint) and auto-disarms after 3 s; second click executes. Clicking a different player/action disarms the previous one. Backdrop click, `Escape`, or the X closes the drawer. Hover-only moderator controls on the Table are gone — the drawer is the only surface for these actions.
- **Statistics** (`src/components/Statistics.tsx`) — right-side panel driven by `src/utils/stats.ts`:
  - Pre-reveal: voting progress (`X / Y voted`) with animated bar.
  - Post-reveal: Average / Min / Max metric cards, Consensus badge (only when every numeric voter picked the same value), and a Distribution bar chart across all chosen cards. `?` and `☕` votes are excluded from Average/Min/Max but counted in Distribution.
- **Hand rail** — bottom-anchored horizontal card strip with the 11 selectable cards. Hovering lifts the card; clicking commits a `SELECT_CARD` action; clicking the same card again unselects.
- **Host actions** (Reveal / Reset) sit in a centered action bar under the table, visible only to the Host.

### 7. Card Visual Effects (`src/components/Card.tsx`)

- **Pointer tilt**: `useMotionValue` tracks pointer X/Y over the card; `useSpring`-smoothed `rotateX` / `rotateY` produce a ±14° 3D tilt that spring-returns to rest on mouse leave.
- **Crystalline glass card back**: translucent blue gradient base (lighter top-left, cooler bottom-right) layered with a top crescent highlight, a diagonal bright streak, a thin secondary streak (faceted feel), a bottom inner glow, and a low-opacity pointer-tracked pin-point specular. Inset rim highlights (bright top/left, dark bottom/right) and a subtle outer edge complete the glass-edge illusion. The revealed front face picks up the same rim/sheen treatment so both sides read as glass, not as paper.
- **Physical flip**: 0.9 s keyframe animation that lifts the card (y↑ + larger shadow) during the first quarter, rotates it around Y during the middle half, and places it back down during the last quarter — mimicking "pick up, flip, set down".
- **Staggered reveal**: `revealIndex * 0.12s` delay so cards flip one after another at reveal time.
- **Green pulse on reveal**: every card (not just others') gets a brief green `boxShadow` pulse post-flip, replacing the confusing isMe-asymmetric yellow ring.
- **Coffee card smoke**: 5 staggered particles rising with slight lateral drift for a continuous smoke trail.
- **`animationsEnabled` toggle**: disables all of the above; Card falls back to a static DOM shape, preserving layout but skipping effects.

### 8. Home Entry Flow

`src/components/Home.tsx` reads `?room=` on first render and renders **one primary CTA at a time**, eliminating the mis-click risk of side-by-side Create/Join buttons:

- With `?room=<id>`: "You're invited" — Join form only, Room ID prefilled. A subtle link offers "Create a new one instead" (clears the URL param and reloads).
- Without `?room=`: "Start a session" — Create form only. A collapsed disclosure below opens a Join form for the rare "someone dictated a Room ID to me" case.
- Both branches share `NameInput` and subcomponents `CreateForm` / `JoinForm`.

### 9. Other UI

- **Toasts**: right-side slide-in / fade-out with `AnimatePresence`, auto-dismiss after 3.5 s. Rendered at the `App` root so they appear in both Home and Room views. Positioned below the header (`top-20`) so stacked toasts never overlap the logo or the menu trigger. All user-facing errors (connection failures, peer errors) go through this channel — there is no inline error banner.
- **Accessibility / Performance**: `animationsEnabled` toggle respected by every animated component.
- **Theming**: Dark mode support via Tailwind's `dark:` classes and toggled on `<html>` element.
- **i18n**: `react-i18next` powers the UI language. Initialised in `src/i18n/index.ts` with `i18next-browser-languagedetector` — order is `localStorage` → `navigator`, cached in `localStorage` under key `scrum-poker-lang`. Supported languages: `en`, `zh-TW`; fallback is `en`. Locale files live in `src/i18n/locales/`. React components read strings via `useTranslation()` (`t('namespace.key')`); non-React code (`peerManager.ts`) imports the `i18n` instance and calls `i18n.t(...)` directly. A language toggle in the header flips between `en` and `zh-TW`.

### 10. Room Lifecycle

- Rooms are ephemeral. They exist entirely in memory. When the last participant leaves, the room simply ceases to exist.

## End-to-End Harness

`scripts/e2e.js` is a Puppeteer-based CLI for driving the app through real browsers — smoke tests, multi-client load simulation, and debug observation. It replaces the old `test-host.js` / `test-live.js` / `test-live-e2e.js` / `test-10-clients.js` scripts.

- **`host`** — one browser creates a room via the Create CTA, prints the Room ID, keeps the page open. Supports `--duration` for a finite-lifetime smoke test.
- **`swarm`** — N isolated browser contexts join an existing `--room` (each context has its own localStorage so zustand's persisted `playerId` doesn't collide). Each client randomly votes with probability `--vote-probability`. Stays alive until SIGINT.
- **`e2e`** — host creates a room, N clients join, after a settle delay the script reads the host's DOM and asserts the `TesterNN` names appear. Exits with 0 on pass, 1 on fail — suitable for CI.
- **`observe`** — single client joins `--room` and forwards browser console + page errors. Used for debugging PeerJS / migration issues.

Entry points: `npm run e2e`, `e2e:host`, `e2e:swarm`, `e2e:check`, `e2e:observe` — pass flags after `--` (`npm run e2e:swarm -- --room XXX --count 5`). There's also a `transfer` mode (`node scripts/e2e.js --mode transfer --count 2`) that spins up one host + N verbose clients, drives a two-click host transfer from the host to Tester01, then observes for 20 s — catches broker-reconnect races, reclaim timing, and `player-make-host` UI flow all at once. Room entry is detected via `data-slot="hand-card"` on hand-rail buttons (language- and text-transform-agnostic). Swarm mode also accepts `--verbose N` to forward the full browser console for the first N clients — useful when debugging host migration, since every `peerManager` log from those bots is piped to the terminal prefixed with their name.

### data-slot convention

Every user-actionable control in the app carries a `data-slot="<kebab-id>"` attribute; the e2e script uses these exclusively to locate targets, so puppeteer stays stable across i18n changes, CSS `text-transform`, and icon-only buttons.

- App header: `copy-room-id`, `copy-invite-link`, `connection-status` (+ `data-status`), `players-pill`, `menu-trigger`, `menu-language`, `menu-animations`, `menu-theme`, `menu-leave` (+ `data-confirming`)
- Home: `home-name` (input), `home-room-id` (input), `home-create`, `home-join`, `home-not-this-room`, `home-join-fallback-toggle`, `home-join-progress` (+ `data-progress`, `data-long-wait`), `home-join-cancel`, `home-join-long-wait`, `home-join-keep-trying` (banner dismiss)
- Room: `host-reset`, `host-reveal`, `hand-card` (+ `data-card-value`)
- Players panel: `players-panel` (root), `players-panel-close`, `player-row` (+ `data-player-id`), `player-make-host` / `player-kick` (+ `data-player-id`, `data-confirming`)
- Toast: `toast-dismiss` (+ `data-toast-id`)

When adding a new button or input that exercises app state, give it a `data-slot`. The naming is `<component>-<action>`; add supplementary `data-*` attributes only when the action needs a parameter (e.g. player id, card value) or reflects arming state.

## File Structure

- `src/components/`: React UI components.
  - `Home.tsx` — URL-driven Create vs Join entry
  - `Room.tsx` — Table + Statistics layout, bottom hand rail (room-level chrome lives in `App.tsx` header)
  - `Table.tsx` — felt table with tilted player cards
  - `Statistics.tsx` — voting progress + post-reveal aggregates
  - `Card.tsx` — display card with tilt, foil, physical flip, smoke
  - `ArcBrowserWarning.tsx` — amber banner shown to Arc users
  - `Toast.tsx` — top-right toast container, driven by the store
  - `MigrationOverlay.tsx` — blocking overlay shown while the room is reclaiming / awaiting a new host
  - `PlayersPanel.tsx` — on-demand right-drawer / bottom-sheet with player list + host controls (transfer / kick) using two-step confirmation
- `src/i18n/` — `react-i18next` setup and locale files (`locales/en.json`, `locales/zh-TW.json`).
- `src/store/usePokerStore.ts` — Zustand state, persistence, and toast queue.
- `src/utils/`
  - `peerManager.ts` — PeerJS wrapper: `createRoom`, `joinRoom`, `joinViaHost`, `joinRoomWithRetry`, `onHostConnectionLost`, `handleHostDisconnect`, `handleHostLeaving`, `selfPromoteHost`, `directConnectToSuccessor`, `reclaimWellKnownInBackground`, `openWellKnownPeer`, `transferHost`, `leave`. Heartbeat helpers: `startHeartbeatBroadcast` / `touchHeartbeat` / watchdog.
  - `roomId.ts` — Crockford Base32 generation and input normalisation.
  - `browserDetect.ts` — Arc detection via CSS variable.
  - `stats.ts` — pure `computeStats(players)` returning averages, min/max, consensus, distribution.

## Known Limitations

- **No TURN server**: Peers behind symmetric NAT, corporate firewalls blocking UDP, or browsers with aggressive WebRTC privacy policies (Arc) may be unable to connect. Adding a TURN server would solve this at the cost of hosting infrastructure.
- **Brief network blips trigger migration**: a 8 s+ network pause on a client's side (not the host's) looks identical to a dead host from its perspective. The Option A probe adds a 2 s forgiveness window, but longer blips will still start a migration and can briefly show the "switching host" overlay before natural recovery.
