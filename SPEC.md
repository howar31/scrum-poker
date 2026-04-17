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
- **Signaling**: Uses PeerJS's public cloud server by default.
- **Connections**: Data connections are strictly between the Host and individual Peers.
- **Room Identification**: A room's ID is inherently the `playerId` of the current Host. This ensures seamless PeerJS connections using the structure `scrum-poker-{roomId}`.
- **Invite Links**: Joining a room via an invite link uses URL search parameters (`?room=XYZ`). The application automatically populates the join field from the URL.

### 2. State Management (Zustand)
- Persists user preferences (name, theme, animation toggle) using `zustand/middleware` `persist`.
- Manages transient room state (roomId, hostId, players, isRevealed).
- `Player` object structure: `{ id, name, card, joinedAt }`

### 3. Peaceful Host Migration
- **Automatic Election**: When a Peer detects the Host connection is closed, it sorts the remaining players by `joinedAt` (oldest first). The oldest non-host player promotes themselves to Host. Others automatically try to connect to the new Host.
- **Manual Transfer**: The Host can manually transfer host privileges to another player, downgrading themselves to a Peer and connecting to the new Host.

### 4. Animations & UI
- **Framer Motion**: Used for card flip and hover animations.
- **Coffee Card Effect**: Special smoking effect for the ☕ card.
- **Accessibility/Performance**: A toggle to disable animations (`animationsEnabled`). When disabled, framer-motion elements fallback to standard CSS or static components.
- **Theming**: Dark mode support via Tailwind's `dark:` classes and toggled on `<html>` element.

### 5. Room Lifecycle
- Rooms are ephemeral. They exist entirely in memory. When the last participant leaves, the room simply ceases to exist.

## File Structure
- `src/components/`: React UI components (`Home.tsx`, `Room.tsx`, `Card.tsx`).
- `src/store/`: Zustand state definitions (`usePokerStore.ts`).
- `src/utils/`: P2P logic and WebRTC wrappers (`peerManager.ts`).
