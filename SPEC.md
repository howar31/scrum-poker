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
- **Room Identification**: Room IDs are 7-character Crockford Base32 strings (`0-9A-Z` minus `I/L/O/U`) generated with `crypto.getRandomValues`. The Host's PeerJS id is ALWAYS `scrum-poker-{roomId}` — there is no random-ID host and no secondary peer. This is the single source of truth for "who is host", arbitrated by the PeerJS broker's one-peer-per-ID constraint. See `src/utils/roomId.ts`.
- **Invite Links**: Joining a room via an invite link uses URL search parameters (`?room=XYZ`). Room IDs are normalised to uppercase with common character substitutions (`I/L → 1`, `O → 0`, `U → V`) to tolerate manual mistyping.
- **Connection timeout**: `joinRoom()` rejects after 20s with a user-facing error. If Arc Browser is detected, the error message appends Arc-specific guidance (`arc://flags` → "Anonymize local IPs exposed to WebRTC" → Disabled).
- **Error surfacing**: Initial connection failures (create/join) are surfaced by the caller (`Home.tsx`) via `pushToast({ variant: 'error' })`. Post-init transient peer errors (stale signaling events after a network blip) are routed directly to toasts from `peerManager` so they auto-dismiss and don't persist after reconnect succeeds. There is no static error banner — the `error` state field in the store is retained for completeness but is not rendered.

### 2. State Management (Zustand)

- Persists user preferences (`playerId`, `playerName`, `theme`, `animationsEnabled`) to `localStorage` via `zustand/middleware` `persist`. Persisting `playerId` is critical: it allows a refreshing client to be recognised as the *same* player when they reconnect, instead of appearing as a duplicate under their original name.
- Manages transient room state (`roomId`, `hostId`, `players`, `isRevealed`).
- Tracks `connectionStatus: 'connected' | 'reconnecting' | 'disconnected'` for the header dot. `connected` = PeerJS signaling registered and P2P live. `reconnecting` = broker WebSocket dropped / migration in progress / heartbeat watchdog tripped / well-known probe in flight — existing DataConnections may still flow. `disconnected` = all recovery paths exhausted, user should refresh or create a new room.
- Manages in-memory toast queue (`toasts`, `pushToast`, `dismissToast`) consumed by `src/components/Toast.tsx`.
- `Player` object structure: `{ id, name, card, joinedAt, peerId }`.

### 3. Host Migration & Reconnection

**Design principle: the PeerJS broker is the single arbiter of host identity.** The broker's one-peer-per-ID guarantee is the only cluster-wide consensus primitive available in a serverless P2P design. Every migration path collapses to one operation: `new Peer('scrum-poker-{roomId}')` on the broker. The broker grants the ID to exactly one caller and returns `unavailable-id` to everyone else. Split-brain is structurally impossible, not a safeguard to maintain.

#### Invariants

- **H1 — one host per epoch**: each room carries a monotonically increasing `epoch: number` in the store, bumped on every become-host transition. Messages are stamped with the issuer's current epoch; any message with `epoch < localEpoch` is dropped. Stale broadcasts from a previous host can never overwrite fresher state.
- **H2 — well-known ID is the host**: the peer currently owning `scrum-poker-{roomId}` at the broker IS the host. There is NO secondary peer, NO random-ID "host with reclaim in background" state. A client cannot flip `isHost = true` without first succeeding at `new Peer('scrum-poker-{roomId}')`.

#### Finite State Machine

```
IDLE ──create──▶ HOSTING         (opens well-known peer; epoch=1)
IDLE ──join───▶ FOLLOWING        (connects to well-known peer as random-ID peer)

FOLLOWING ──conn.close / watchdog fire──▶ runMigration
  │
  ├──▶ ELECTING (iAmElector: designated=me OR rank 0 when no LEAVING)
  │     ├──openPeer(wellKnown) succeeds──▶ HOSTING (epoch++)
  │     ├──unavailable-id─────────────────▶ connect as client
  │     └──budget exhausted──────────────▶ IDLE (+"room lost" toast)
  │
  └──▶ FOLLOWING_WAIT (non-elector; waits MIGRATION_GRACE_MS+rank*RANK_STAGGER_MS)
        ├──joinAsClient(wellKnown) succeeds──▶ FOLLOWING
        ├──grace expires────────────────────▶ unlock Phase B (may elect)
        └──budget exhausted────────────────▶ IDLE (+"room lost" toast)

HOSTING ──leave──▶ IDLE          (broadcasts LEAVING; destroys peer)
HOSTING ──transferHost──▶ FOLLOWING_WAIT ──re-joins──▶ FOLLOWING
```

Five states cover every lifecycle path. No `reconnecting`/`migrationAttempted`/`authoritativeSuccessor`/`intentionalLeave` flags orchestrating control flow — the FSM + one `migrating` re-entry guard is the complete model.

#### The migration loop (`runMigration`)

A single loop per client, driven by broker arbitration:

1. Compute `iAmElector` and `rank`.
    - If `LEAVING { nextHostId }` was received earlier, the designated is the sole elector; everyone else is a non-elector.
    - If no LEAVING (unplanned host crash), exclude the presumed-dead `state.hostId` from the ranked candidates; rank-0 of what remains is the elector.
2. Non-electors sit on `mayElectAfter = start + MIGRATION_GRACE_MS + rank * RANK_STAGGER_MS`. Within grace, they only try to join the winner as a client (`joinAsClient(wellKnown)`). If the designated / rank-0 takes the ID, everyone finishes during grace.
3. **If grace expires without a winner** (e.g. the designated successor crashed mid-flip), non-electors unlock Phase B and also attempt `openPeer(wellKnown)`. Broker arbitration still guarantees a single host — the earliest-ranked surviving client usually wins by stagger, but anyone with a valid network can be the fallback. This is the mechanism that replaces the old `recoverNoHost` cascade without its split-brain cost.
4. Whichever call succeeds first decides the state transition: `openPeer` success → `becomeHost`; `joinAsClient` success → `FOLLOWING`. Everyone else sees `unavailable-id` / `peer-unavailable` and keeps retrying.
5. Total budget `MIGRATION_BUDGET_MS = 60 s`. On exhaustion: destroy everything, toast, `leaveRoom`. Graceful leave settles in ~5–10 s (broker releases the ID quickly on SCTP FIN). Dirty crash may take up to the full 60 s because the broker holds the crashed host's ID until its own `alive_timeout` — the trade-off for structural single-host-ness and a room that survives worst-case broker delays.

Constants (`src/utils/peerManager.ts`):
- `HEARTBEAT_INTERVAL_MS = 2000` — host broadcasts `STATE` every 2 s even without a local change (also serves as the heartbeat).
- `HEARTBEAT_TIMEOUT_MS = 8000` — client watchdog; any inbound data resets it.
- `MIGRATION_BUDGET_MS = 60000` — total runMigration window. Covers the full PeerJS broker `alive_timeout` on a dirty crash so the room doesn't die prematurely.
- `MIGRATION_GRACE_MS = 10000` — non-elector passive-wait before Phase B unlocks.
- `RANK_STAGGER_MS = 2000` — stagger between rank N and rank N+1 in Phase B.
- `OPEN_PEER_TIMEOUT_MS = 3000`, `CONNECT_TIMEOUT_MS = 2500`, `MIGRATION_RETRY_INTERVAL_MS = 1000` — per-iteration timing.
- `LEAVING_FLUSH_MS = 300` — delay between broadcasting LEAVING and destroying the peer, so SCTP can flush cross-network.
- `KICK_REJECT_WINDOW_MS = 5000`, `KICK_MESSAGE_FLUSH_MS = 200`.
- `GHOST_CLEANUP_DELAY_MS = 20000` — one-shot sweep after `becomeHost`.

#### Message protocol (4 types)

```ts
STATE   { payload: RoomState }  // RoomState includes epoch + hostId + roomId + players + isRevealed
ACTION  { epoch; payload: JOIN | SELECT_CARD | REVEAL | RESET | KICK | TRANSFER_HOST }
LEAVING { epoch; nextHostId: string | null }
KICKED  { epoch }
```

- No separate `PING` type: `STATE` doubles as the heartbeat (sent every 2 s even without a local change).
- No `HOST_LEAVING_ACK`: the leaving host destroys after `LEAVING_FLUSH_MS`. Anyone who misses the LEAVING packet falls back to the watchdog + rank-based recovery path, which converges on the same outcome via broker arbitration — so the explicit ACK is redundant.
- Every message carries the sender's current `epoch`. Receivers silently drop any with `epoch < localEpoch`. The exception is JOIN — a reconnecting client may have an older epoch until they receive our next STATE, and we must honor the join.
- Messages are idempotent: STATE is a full snapshot, JOIN dedupes on `playerId`, LEAVING/KICKED are single-shot. No retries needed; the 2 s STATE heartbeat covers cross-network loss.

#### Graceful leave / manual transfer

- `HOSTING` client calls `leave()` or `transferHost(newHostId)`:
  1. Broadcast `LEAVING { nextHostId }` to all connections. `nextHostId` is the designated successor (the target of `transferHost`, or oldest-non-host by `joinedAt` for `leave()`, or `null` if solo).
  2. Wait `LEAVING_FLUSH_MS = 300 ms`.
  3. Destroy own peer (releases the well-known ID at the broker).
  4. `leave()`: done → IDLE.
  5. `transferHost()`: re-enter as a client via the same `runMigration` loop (non-elector path), reconnects to the new host once they claim the well-known ID.

- On the client side: `LEAVING` is received over the still-open hostConnection BEFORE the destroy; clients save `designatedSuccessor = nextHostId` and stay in FOLLOWING. When the hostConnection subsequently closes, `onHostConnectionLost` → `runMigration` with `designatedSuccessor` pre-seeded.

- `LEAVING { nextHostId: null }`: sent when the last-remaining host leaves solo. Receivers interpret this as "room is closing", toast `roomEmpty`, and go straight to IDLE without attempting any migration.

#### Kick flow

`KICK` is dispatched only by the host. Host's `processAction('KICK')`:
1. Remove victim from `state.players`.
2. Record `kickedUntil.set(playerId, Date.now() + KICK_REJECT_WINDOW_MS)` — a 5 s window within which JOIN from that playerId is rejected.
3. **Remove victim's DataConnection from `this.connections` BEFORE the trailing STATE broadcast.** Otherwise the kicked peer would race a STATE (that rebuilds `players` including them) against the KICKED message, briefly putting them back into the Room UI after they've leaveRoom'd.
4. `send({ type: 'KICKED', epoch })` to the victim's conn.
5. Wait `KICK_MESSAGE_FLUSH_MS = 200 ms` for SCTP to flush.
6. Close the conn.

Victim's `handleClientMessage` routes `KICKED` → `handleKicked`: set `intentionalLeave`, toast `youWereKicked`, `leaveRoom` (clears roomId → App re-renders Home), destroy peer. The 5 s rejection window defends against the case where KICKED itself is lost in transit — any JOIN within the window gets a fresh KICKED + close. Window is deliberately short: the kick is "stop the auto-reconnect loop", not a ban.

#### Broker re-registration

`peer.on('disconnected')` fires when the WebSocket to the PeerJS broker drops (tab backgrounded, network blip) while the Peer object is alive locally. The handler flips `connectionStatus='reconnecting'` and calls `peer.reconnect()` to re-register the same peer ID. A subsequent `peer.on('open')` flips status back to `connected`. The handler short-circuits when `intentionalLeave` is set, and `destroyPeer()` calls `removeAllListeners()` before `destroy()` — both prevent a reconnect-race during teardown that would hold the old peer ID alive on the broker.

#### New joiner via `?room=XYZ`

`joinRoomWithRetry(roomId, { onProgress })` returns `{ cancel, promise }`. Internally loops `joinAsClient(well-known)` with a 5 s per-attempt timeout until success or cancel (no internal time cap — the UI owns the way out). `onProgress` distinguishes `peer-unavailable` (ID not registered: room doesn't exist, or broker just released it mid-migration) from `timeout` (broker still has the ID but the peer is unreachable: migration likely in progress), so the UI can tell the user *why* it's waiting. `Home.tsx`'s JoinForm shows a spinner + progress message throughout; after `LONG_WAIT_PROMPT_MS = 30 s` a non-blocking amber banner offers Dismiss / Give up.

#### Migration UI

`src/components/MigrationOverlay.tsx` reads `migrationPhase` from the store (`'idle' | 'reclaiming' | 'waiting'`) and renders a semi-transparent overlay while migration runs. `ELECTING` sets `reclaiming`; `FOLLOWING_WAIT` sets `waiting`.

#### Unload guard

While `roomId` is set, `App.tsx` installs a `beforeunload` listener that triggers the browser's native "Leave site?" prompt on desktop/Android. iOS Safari ignores `beforeunload`, so `src/index.css` sets `overscroll-behavior-y: contain` on `html, body` to block pull-to-refresh. Address-bar refresh and swipe-back on iOS remain unblockable, but `playerId` persistence + URL `?room=XYZ` means a refreshed client can click Join to return.

### 4. Reconnection Identity

- Because `playerId` is persisted, a client that refreshes or briefly disconnects rejoins under the same identity. The Host's `processAction` JOIN handler detects this: if the incoming `playerId` already exists in `players`, it updates `peerId` and `name` but preserves `joinedAt` (keeping host-election ordering stable), and emits a `{name} 已重新連上` toast. If the player is new, a `{name} 已加入` toast is shown.
- When a client connection closes on the Host side, the Host looks up the player by matching `peerId`. The player is removed and a `{name} 已離線` toast is broadcast.
- **Ghost cleanup after `becomeHost`**: After a migration, the new host's `connections` map starts empty while the `players` map still carries everyone from the previous host's last broadcast — including the crashed old host. `becomeHost` schedules a one-shot `scheduleGhostCleanup` (`GHOST_CLEANUP_DELAY_MS = 20 s`): live clients land back via `runMigration`'s client-side loop within that window, and anyone whose `peerId` still isn't in `connections.keys()` when the timer fires gets removed + toasted as offline.

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
- **Crystalline glass card back**: translucent blue gradient base (lighter top-left, cooler bottom-right) layered with a top crescent highlight, a diagonal bright streak, a thin secondary streak (faceted feel), and a bottom inner glow. Inset rim highlights (bright top/left, dark bottom/right) and a subtle outer edge complete the glass-edge illusion. The revealed front face picks up the same rim/sheen treatment so both sides read as glass, not as paper. There is NO pointer-tracked specular — the fixed-position highlights already sell the glass look, and the tracked highlight was distracting in playtests.
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

`scripts/e2e.js` is a thin CLI dispatcher over `scripts/e2e/modes/*.js` with shared utilities in `scripts/e2e/helpers.js`. 24 modes in total: a handful of diagnostic/interactive ones (no assertions) and 20 assertion modes that print a final `Result:` line.

### Prerequisites

- Either `npm run dev` (or `VITE_E2E=1 npm run dev` for modes that read store state; see below), or pass `--url https://your-deployment/` to target a deployed build. Default target is `http://localhost:5173`.
- Puppeteer is already a devDependency; `npm install` is enough.
- **`VITE_E2E=1`**: when set, `src/main.tsx` exposes `window.__POKER_STATE__ = usePokerStore.getState` on the page so helpers like `readStoreState` / `readStatistics` can introspect the zustand store. Production builds never ship this. Modes that need it: `vote`, `refresh`, `state-persist`, `deadman`, `settings`. Safe to always set — the other modes ignore it.

### Layout

- `scripts/e2e.js` — parseArgs + mode dispatch. Also owns the `HELP_TEXT`.
- `scripts/e2e/helpers.js` — `setupRoom`, `snap`, `snapAll`, `printResult`, `pickCard`, `kickPlayer`, `transferToPlayer`, `leaveRoomViaMenu`, `readStoreState`, `readStatistics`, etc. Every mode file uses these.
- `scripts/e2e/modes/<name>.js` — one file per mode, exports `run(browser, config)`. Assertion modes end with `printResult({...})`.

### Modes

Every assertion mode follows the shape: call `setupRoom`, run the scenario, call `snapAll`, assert, `printResult`. Each has an `npm run e2e:<name>` shortcut.

Interactive / diagnostic (no Result line):

- **`host`** — one browser creates a room, prints the Room ID, keeps page open. `--duration <sec>` makes it finite. **Exits?** Only after `--duration` or SIGINT. **Asserts:** nothing — the `Room ID` print is the success signal.
- **`swarm`** — N isolated browser contexts join `--room`, each votes at `--vote-probability`. `--verbose N` forwards the first N clients' console. **Exits?** SIGINT only. **Asserts:** nothing.
- **`observe`** — single client joins `--room` and forwards browser console + pageerrors. **Exits?** SIGINT only. **Asserts:** nothing.

Assertion modes (print `Result:` line; `Result:` with any `=false` = fail):

- **`check`** (alias `e2e`) — host + N clients; asserts every TesterNN is visible in the host's DOM. **Exits?** Yes, with status code 0 on pass / 1 on fail. **Asserts:** `seen.size >= count` via exit code.
- **`transfer`** — bot-driven graceful host transfer from Host → Tester01. Exercises `HOST_LEAVING` + `HOST_LEAVING_ACK` + `directConnectToSuccessor` + background well-known reclaim. **Exits?** SIGINT. **Asserts:** `allInRoom=true playerCountMatches=true`.
- **`crash`** — host + N clients, then `hostPage.close()` abruptly. Drives heartbeat → probe → `handleHostDisconnect` → self-promote. **Exits?** SIGINT. **Asserts:** `allInRoom=true playerCountMatches=true` for survivors.
- **`kick`** — host kicks Tester01, waits past the 5 s reject window. Regression guard for kicked-but-auto-rejoins. **Exits?** SIGINT. **Asserts:** `tester01Left=true survivorsInRoom=true playerCountMatches=true`.
- **`vote`** — host + 3 clients pick `3`/`5`/`☕`, host reveals, asserts Statistics panel reports `average=4 min=3 max=5` (☕ excluded) with correct `distribution`. Host resets, asserts every card is back to null. **Exits?** SIGINT. **Asserts:** `votesRecorded=true statsCorrect=true resetClears=true`.
- **`refresh`** — client reloads mid-session. Asserts the rejoin is recognised as the same player (no duplicate) and explicitly captures the known trade-off that the vote is lost on reload. **Exits?** SIGINT. **Asserts:** `sameCount=true noDuplicates=true voteLostAsExpected=true`.
- **`state-persist`** (shortcut: `e2e:state`) — everyone votes, host reveals, host transfers. Asserts votes + `isRevealed` + stats all survive the migration. **Exits?** SIGINT. **Asserts:** `votesPreserved=true revealedPreserved=true statsStable=true`.
- **`kick-window`** — host kicks Tester01, immediately asserts a manual re-join is blocked (within 5 s `KICK_REJECT_WINDOW_MS`), waits past the window, then a manual re-join succeeds. **Exits?** SIGINT. **Asserts:** `kickedLanded=true blockedWithinWindow=true rejoinAfterWindow=true`.
- **`late-joiner`** — spawns a fresh Tester99 via `?room=XYZ` during a host transfer. Asserts Tester99 eventually lands in the room and `playerCount` converges to 4 across every page. **Exits?** SIGINT. **Asserts:** `lateJoined=true allInRoom=true playerCountConverges=true`.
- **`deadman`** — host transfers to Tester02 (not the oldest non-host) then closes Tester02's page before it can selfPromote. Asserts the rank-0 deadman fallback (Host, oldest) recovers the room. **Exits?** SIGINT. **Asserts:** `hostRecovered=true survivorsInRoom=true`.
- **`disarm`** — arms kick on Tester01, waits > 3 s past `CONFIRM_TIMEOUT_MS`, asserts the button's `data-confirming` is cleared and a subsequent click re-arms (rather than fires). Guards the two-click arm pattern. **Exits?** SIGINT. **Asserts:** `autoDisarmed=true reArmsNotConfirms=true tester01Stays=true`.
- **`join-ux`** — Home URL routing: `/` shows Create; `/?room=ILO123` shows Join with the input normalized (`I→1, L→1, O→0, U→V` → `110123`); cancelling an in-flight join returns to the form. **Exits?** SIGINT. **Asserts:** `createShownAtRoot=true joinShownWithRoom=true normalized=true cancelWorks=true`.
- **`settings`** — theme toggle + persistence across reload, language toggle (EN ↔ 中), animations toggle (via store state). **Exits?** SIGINT. **Asserts:** `themeFlips=true themePersists=true languageFlips=true animationsToggle=true`.
- **`copy-toast`** — copy-room-id + copy-invite-link each surface a toast; both auto-dismiss within 4.5 s (> 3.5 s Toast timer). **Exits?** SIGINT. **Asserts:** `roomIdToast=true linkToast=true toastsAutoDismiss=true`.
- **`solo-leave`** — solo host arms + confirms Leave via menu. Asserts back on Home and `?room=` is stripped from the URL. **Exits?** SIGINT. **Asserts:** `leftAfterConfirm=true backOnHome=true urlCleaned=true`.
- **`panel-ux`** — Players panel close via X, Escape, and backdrop click. **Exits?** SIGINT. **Asserts:** `xCloses=true escapeCloses=true backdropCloses=true`.
- **`split-brain`** — 1 host + 5 clients (overridable via `--count`; minimum 5), host transfers to Tester01. Regression lock on the real-world 5-client cross-network bug: multiple clients formerly fell into parallel `recoverNoHost` paths and each became a solo host. Under broker arbitration, every page must agree on hostId AND no page ends up as a solo host. **Exits?** SIGINT. **Asserts:** `allInRoom=true playerCountMatches=true hostIdConsistent=true noSoloHosts=true`.
- **`crash-mid-transfer`** — host + 3 clients; host transfers to Tester02 (not rank-0) then Tester02 is force-closed before it can open the well-known ID. Asserts the rank-0 Phase-B fallback (original host) takes over via broker arbitration. **Exits?** SIGINT. **Asserts:** `hostRecovered=true allInRoom=true playerCountMatches=true`.
- **`election-race`** — host + 4 clients; host page force-closed. Four clients' watchdogs fire nearly simultaneously and race to open the well-known ID. Asserts broker arbitration produces exactly one winner and every other client ends up FOLLOWING them. **Exits?** SIGINT. **Asserts:** `exactlyOneHost=true everyoneAgrees=true allInRoom=true playerCountMatches=true`.
- **`partition`** — host + 4 clients; two clients (Tester03 + Tester04) leave simultaneously via menu. Asserts majority stays together with accurate playerCount and the departing pair is back on Home (no split-brain solo hosts). (Note: true network-partition simulation requires CDP-level control over UDP/WebRTC, which Puppeteer doesn't provide — this mode exercises the observable-close path instead.) **Exits?** SIGINT. **Asserts:** `majorityInRoom=true majorityCountMatches=true hostStill=true minorityLeftRoom=true`.

Orchestrator:

- **`all`** (`npm run e2e:all`) — spawns every assertion mode above as a child process in sequence, parses each `Result:` line, and exits 0 iff every sub-mode passed. Prints a per-mode summary with pass/fail and duration. Hang-forever modes are killed with SIGTERM as soon as they print their `Result:` line (so a single run takes ~5–8 minutes instead of ∞). **This is the recommended CI command.**

### Interpreting results

- `check` and `all` are the only modes with exit codes. Other assertion modes print `Result:` but hang (so the user can inspect the live browser). To turn one into a CI check:

  ```bash
  npm run e2e:transfer -- --count 3 2>&1 | tee out.log
  grep -q 'allInRoom=true playerCountMatches=true' out.log || exit 1
  ```

- Room entry is detected via `data-slot="hand-card"`. All automation targets `data-slot` attributes — never text content — so i18n and CSS changes don't break tests.

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
  - `peerManager.ts` — PeerJS wrapper. FSM with 5 states (`IDLE` / `HOSTING` / `FOLLOWING` / `ELECTING` / `FOLLOWING_WAIT`). Public API: `createRoom`, `joinRoom`, `joinRoomWithRetry`, `leave`, `sendAction`. Internal: `runMigration` (single broker-arbitrated loop), `becomeHost`, `joinAsClient`, `decideElectorInfo`, `transferHost`, `handleKicked`, `startHeartbeat`/`touchWatchdog`, `scheduleGhostCleanup`. No secondary peer, no `reclaimWellKnownInBackground`, no `authoritativeSuccessor` / `migrationAttempted` flags — consensus is the broker's one-peer-per-ID guarantee at `scrum-poker-{roomId}`.
  - `roomId.ts` — Crockford Base32 generation and input normalisation.
  - `browserDetect.ts` — Arc detection via CSS variable.
  - `stats.ts` — pure `computeStats(players)` returning averages, min/max, consensus, distribution.

## Known Limitations

- **No TURN server**: Peers behind symmetric NAT, corporate firewalls blocking UDP, or browsers with aggressive WebRTC privacy policies may be unable to connect. Adding a TURN server would solve this at the cost of hosting infrastructure.
- **Arc Browser as host is broken in practice**: Arc's WebRTC stack (even with `arc://flags` → "Anonymize local IPs exposed to WebRTC" set to Disabled) intermittently fails to complete ICE with Chrome peers. Symptom: Chrome clients' incoming connection to an Arc host stays in `iceStateChanged = checking` and never reaches `connected`, or flaps between `connected` and `disconnected`. Chrome ↔ Firefox transfers work reliably; any transfer that hands the crown to Arc strands Chrome clients until they `leaveRoom` and manually rejoin (which also takes anywhere from seconds to minutes of ICE retries). The `ArcBrowserWarning` banner now explicitly advises Arc users to avoid taking the Host role. `handleIncomingConnection` bounds the half-open state via `INCOMING_OPEN_TIMEOUT_MS = 20 s` so the host side doesn't accumulate dead RTCPeerConnection objects while clients retry, but the underlying connectivity gap can only be fully closed by adding a TURN server.
- **Brief network blips trigger migration**: a 8 s+ network pause on a client's side (not the host's) looks identical to a dead host from its perspective. Under the new design the client lands in `runMigration`; if the real host is still there, they'll `joinAsClient(wellKnown)` succeed immediately and flip back to FOLLOWING. A migration overlay flashes briefly during the blip.
- **Dirty-crash migration can take up to ~60 s**: when a host crashes without sending SCTP FIN (e.g. tab killed, network cut), the PeerJS broker may hold the well-known ID until its own `alive_timeout`. Clients keep trying `openPeer(wellKnown)` during `MIGRATION_BUDGET_MS = 60 s`; if the broker releases in time, a new host emerges. Beyond 60 s clients surface a "room lost" toast and invite rejoin. Graceful leave/transfer settles in ~5–10 s because `destroy()` sends FIN and the broker releases promptly.
- **True network partition is not testable in Puppeteer**: CDP's `Network.emulateNetworkConditions({offline:true})` blocks HTTP requests but not the UDP/ICE layer used by WebRTC DataChannels. The `partition` e2e mode therefore uses graceful menu-leave on the minority side to exercise the observable-close handling. Real-world partition behavior is indirectly covered by `election-race` (simultaneous watchdog fires) and `crash-mid-transfer`.
