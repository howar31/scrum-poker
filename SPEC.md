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
- Manages in-memory toast queue (`toasts`, `pushToast`, `dismissToast`) consumed by `src/components/Toast.tsx`.
- `Player` object structure: `{ id, name, card, joinedAt, peerId }`.

### 3. Host Migration & Reconnection

- **Auto-reconnect (primary)**: When a Peer's host connection drops after having been open, `PeerManager.onHostConnectionLost` schedules up to 5 reconnect attempts to the *same* Room ID with exponential backoff (1s, 2s, 4s, 8s, 16s — total ~31s). Each attempt pushes a toast `連線中斷，正在重試 (n/5)`. On success, a `已重新連上` toast is shown.
- **Graceful host leave (fast path)**: When the host clicks Leave, `peerManager.leave()` broadcasts a `HOST_LEAVING` message (payload: `{ nextHostId }`) to every connected client *before* destroying the peer. The leaving host is the authoritative decider — `nextHostId` is computed once there using the same oldest-non-host-by-`joinedAt` rule, so no client recomputes and there's no split-brain risk. A 50 ms defer flushes the data-channel queue before `destroy()` runs. Clients that receive `HOST_LEAVING` cancel any pending reconnect and jump straight into migration (reclaim if self, waiting overlay otherwise), skipping the 31 s grace period.
- **Unplanned host disconnect (fallback)**: If all 5 reconnect attempts fail (host genuinely vanished without sending `HOST_LEAVING`), each client runs `handleHostDisconnect` locally. A `migrationAttempted` flag prevents infinite loops: the second time a client enters that path in one session, it gives up and leaves the room.
- **Well-known peer-ID reclaim**: Whoever ends up as the new host calls `reclaimHostIdentity(roomId)` which destroys the current peer and re-inits as `scrum-poker-{roomId}`. PeerJS signaling may still hold the old host's ID for a few seconds (heartbeat grace), so the reclaim retries with backoff `[0, 1, 2, 4, 8] s`. Once the claim succeeds, `migrationPhase` returns to `'idle'` and `broadcastState()` fires. Remaining clients' retry loops naturally land on the new host at the well-known ID — no point-to-point handoff needed. If all reclaim attempts fail, the would-be host toasts an error and leaves the room instead of leaving the room in a broken state.
- **Migration UI**: `src/components/MigrationOverlay.tsx` reads `migrationPhase` from the store (`'idle' | 'reclaiming' | 'waiting'`) and renders a semi-transparent overlay with a spinner and phase-specific copy while migration is in progress. Rendered at the `App` root so it covers everything.
- **Manual transfer**: The current host may transfer host privileges to another player via `TRANSFER_HOST` action. The host demotes itself and reconnects to the new host. This path still uses the old random-peerId handoff (not the well-known reclaim), since both peers are alive and can coordinate directly.
- **Intentional leave**: `peerManager.leave()` (invoked from the UI's Leave Room button) cancels any pending reconnect and tears everything down, including the role flag. Internal `destroy()` (called during re-initialisation) does *not* touch the intentional-leave flag, so reconnect flows survive peer re-creation.
- **Unload guard**: while `roomId` is set, `App.tsx` installs a `beforeunload` listener that calls `preventDefault()` + sets `returnValue`, so refresh / tab-close / window-close triggers the browser's native "Leave site?" prompt on desktop / Android. iOS Safari ignores `beforeunload`, so `src/index.css` also sets `overscroll-behavior-y: contain` on `html, body` to block the pull-to-refresh gesture (the most common accidental refresh on mobile). Address-bar refresh and swipe-back on iOS remain unblockable, but `playerId` persistence + URL `?room=XYZ` means a refreshed client can click Join again to return.

### 4. Reconnection Identity

- Because `playerId` is persisted, a client that refreshes or briefly disconnects rejoins under the same identity. The Host's `processAction` JOIN handler detects this: if the incoming `playerId` already exists in `players`, it updates `peerId` and `name` but preserves `joinedAt` (keeping host-election ordering stable), and emits a `{name} 已重新連上` toast. If the player is new, a `{name} 已加入` toast is shown.
- When a client connection closes on the Host side, the Host looks up the player by matching `peerId`. The player is removed and a `{name} 已離線` toast is broadcast.

### 5. Arc Browser Support

- Arc identifies itself as Chrome in `navigator.userAgent` but exposes Arc-specific CSS variables on `:root` (e.g., `--arc-palette-title`). `src/utils/browserDetect.ts` detects Arc by reading this variable.
- Arc's default WebRTC privacy settings (mDNS anonymisation of local IPs) prevent successful ICE negotiation without a TURN server. The Home page displays a prominent amber warning when Arc is detected, instructing the user to change the `arc://flags` setting or switch browsers.

### 6. Room Layout (Table + Hand + Stats)

- **App header** (`src/App.tsx`) — single horizontal bar that doubles as the room header when `roomId` is set. Left side: Scrum Poker logo, Room ID button (click = copy Room ID), link icon button (click = copy invite URL), and a small connection dot (green/red with pulse when disconnected). Right side: a `MoreVertical` trigger that opens a dropdown menu containing Language / Animations / Theme rows, plus a **Leave room** entry (room mode only) separated by a divider. Leave uses a two-step confirmation: the first click arms the item (red fill + "Click again to confirm" hint) and a 3 s timer auto-disarms it; the second click actually leaves. Opening/closing the menu or clicking outside also disarms. The dropdown closes on outside click or `Escape`. Collapsing every secondary action into one menu keeps the header compact on mobile where the right-side buttons used to overlap the Room ID.
- **Table** (`src/components/Table.tsx`) — green-felt surface with all players' played cards arranged in a responsive `flex-wrap` row. Each card is rotated ±6° based on a deterministic hash of `player.id`, so the same player's card always leans the same direction but different players lean differently, producing an organic "cards tossed on a table" feel without risking upside-down cards.
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

- **Toasts**: right-side slide-in / fade-out with `AnimatePresence`, auto-dismiss after 3.5 s. Rendered at the `App` root so they appear in both Home and Room views. All user-facing errors (connection failures, peer errors) go through this channel — there is no inline error banner.
- **Accessibility / Performance**: `animationsEnabled` toggle respected by every animated component.
- **Theming**: Dark mode support via Tailwind's `dark:` classes and toggled on `<html>` element.
- **i18n**: `react-i18next` powers the UI language. Initialised in `src/i18n/index.ts` with `i18next-browser-languagedetector` — order is `localStorage` → `navigator`, cached in `localStorage` under key `scrum-poker-lang`. Supported languages: `en`, `zh-TW`; fallback is `en`. Locale files live in `src/i18n/locales/`. React components read strings via `useTranslation()` (`t('namespace.key')`); non-React code (`peerManager.ts`) imports the `i18n` instance and calls `i18n.t(...)` directly. A language toggle in the header flips between `en` and `zh-TW`.

### 10. Room Lifecycle

- Rooms are ephemeral. They exist entirely in memory. When the last participant leaves, the room simply ceases to exist.

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
- `src/i18n/` — `react-i18next` setup and locale files (`locales/en.json`, `locales/zh-TW.json`).
- `src/store/usePokerStore.ts` — Zustand state, persistence, and toast queue.
- `src/utils/`
  - `peerManager.ts` — PeerJS wrapper: `createRoom`, `joinRoom`, `joinHost`, `scheduleReconnect`, `handleHostDisconnect`, `transferHost`, `leave`.
  - `roomId.ts` — Crockford Base32 generation and input normalisation.
  - `browserDetect.ts` — Arc detection via CSS variable.
  - `stats.ts` — pure `computeStats(players)` returning averages, min/max, consensus, distribution.

## Known Limitations

- **No TURN server**: Peers behind symmetric NAT, corporate firewalls blocking UDP, or browsers with aggressive WebRTC privacy policies (Arc) may be unable to connect. Adding a TURN server would solve this at the cost of hosting infrastructure.
- **No heartbeat**: Connection liveness relies on PeerJS `close` events and the auto-reconnect flow. A truly wedged-but-open connection will not be detected until the next message send attempt.
