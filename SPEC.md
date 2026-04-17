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

### 2. State Management (Zustand)

- Persists user preferences (`playerId`, `playerName`, `theme`, `animationsEnabled`) to `localStorage` via `zustand/middleware` `persist`. Persisting `playerId` is critical: it allows a refreshing client to be recognised as the *same* player when they reconnect, instead of appearing as a duplicate under their original name.
- Manages transient room state (`roomId`, `hostId`, `players`, `isRevealed`).
- Manages in-memory toast queue (`toasts`, `pushToast`, `dismissToast`) consumed by `src/components/Toast.tsx`.
- `Player` object structure: `{ id, name, card, joinedAt, peerId }`.

### 3. Host Migration & Reconnection

- **Auto-reconnect (primary)**: When a Peer's host connection drops after having been open, `PeerManager.onHostConnectionLost` schedules up to 5 reconnect attempts to the *same* Room ID with exponential backoff (1s, 2s, 4s, 8s, 16s — total ~31s). Each attempt pushes a toast `連線中斷，正在重試 (n/5)`. On success, a `已重新連上` toast is shown.
- **Host migration (fallback)**: Only if all reconnect attempts fail does the Peer perform migration. Remaining players are sorted by `joinedAt`; the oldest non-host player promotes itself to Host. Others connect to the new Host via `joinHost(nextHost.peerId)`. Toasts announce the switch.
- **Manual transfer**: The current Host may transfer host privileges to another player via `TRANSFER_HOST` action. The Host demotes itself and reconnects to the new Host.
- **Intentional leave**: `peerManager.leave()` (invoked from the UI's Leave Room button) cancels any pending reconnect and tears everything down. Internal `destroy()` (called during re-initialisation) does *not* touch the intentional-leave flag, so reconnect flows survive peer re-creation.

### 4. Reconnection Identity

- Because `playerId` is persisted, a client that refreshes or briefly disconnects rejoins under the same identity. The Host's `processAction` JOIN handler detects this: if the incoming `playerId` already exists in `players`, it updates `peerId` and `name` but preserves `joinedAt` (keeping host-election ordering stable), and emits a `{name} 已重新連上` toast. If the player is new, a `{name} 已加入` toast is shown.
- When a client connection closes on the Host side, the Host looks up the player by matching `peerId`. The player is removed and a `{name} 已離線` toast is broadcast.

### 5. Arc Browser Support

- Arc identifies itself as Chrome in `navigator.userAgent` but exposes Arc-specific CSS variables on `:root` (e.g., `--arc-palette-title`). `src/utils/browserDetect.ts` detects Arc by reading this variable.
- Arc's default WebRTC privacy settings (mDNS anonymisation of local IPs) prevent successful ICE negotiation without a TURN server. The Home page displays a prominent amber warning when Arc is detected, instructing the user to change the `arc://flags` setting or switch browsers.

### 6. Animations & UI

- **Framer Motion** is used for:
  - Card flip (`rotateY`) with Material Design easing (`[0.4, 0.0, 0.2, 1]`), 0.75s duration, yellow `boxShadow` pulse after reveal.
  - Staggered reveal: when the Host triggers Reveal, each player's card flips with a delay of `revealIndex * 0.12s`, one-by-one rather than simultaneously.
  - Card selection feedback: `whileTap`, scale pulse (1 → 1.15 → 1.05), and a blue ring glow on the selected card.
  - Player list: `AnimatePresence` drives spring-based enter/exit animations as players join/leave.
  - Toasts: right-side slide-in / fade-out with `AnimatePresence`, auto-dismiss after 3.5s.
- **Coffee Card Effect**: Special smoking effect for the ☕ card.
- **Accessibility / Performance**: `animationsEnabled` toggle. When disabled, all framer-motion wrappers fall back to static DOM or plain CSS transitions.
- **Theming**: Dark mode support via Tailwind's `dark:` classes and toggled on `<html>` element.

### 7. Room Lifecycle

- Rooms are ephemeral. They exist entirely in memory. When the last participant leaves, the room simply ceases to exist.

## File Structure

- `src/components/`: React UI components.
  - `Home.tsx`, `Room.tsx`, `Card.tsx` — primary views
  - `ArcBrowserWarning.tsx` — amber banner shown to Arc users
  - `Toast.tsx` — top-right toast container, driven by the store
- `src/store/usePokerStore.ts` — Zustand state, persistence, and toast queue.
- `src/utils/`
  - `peerManager.ts` — PeerJS wrapper: `createRoom`, `joinRoom`, `joinHost`, `scheduleReconnect`, `handleHostDisconnect`, `transferHost`, `leave`.
  - `roomId.ts` — Crockford Base32 generation and input normalisation.
  - `browserDetect.ts` — Arc detection via CSS variable.

## Known Limitations

- **No TURN server**: Peers behind symmetric NAT, corporate firewalls blocking UDP, or browsers with aggressive WebRTC privacy policies (Arc) may be unable to connect. Adding a TURN server would solve this at the cost of hosting infrastructure.
- **No heartbeat**: Connection liveness relies on PeerJS `close` events and the auto-reconnect flow. A truly wedged-but-open connection will not be detected until the next message send attempt.
