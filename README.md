# Scrum Poker

A Serverless P2P Scrum Poker web application built with React, Vite, TailwindCSS, and PeerJS.
This application allows teams to estimate stories without requiring a backend server or database.

## Features

- **Serverless & P2P**: WebRTC (via PeerJS) for real-time communication between browsers. No server-side state.
- **Table-style Layout**: All played cards are laid out on a felt table so everyone's vote is visible at a glance, even with 8+ players. A dedicated Statistics panel shows Average, Min, Max, Consensus badge, and vote distribution as soon as cards are revealed.
- **Players Panel**: An on-demand drawer (right-side on desktop, bottom sheet on mobile) lists every player with vote status and host crown. Transfer host and kick live here with a two-click confirmation so you can't misfire on a quick tap.
- **Rich Card Effects**: Pointer-tracked 3D tilt, glass-style card back with a pointer-following specular highlight, and a physical "pick up → flip → place down" reveal animation. Hand cards lift on hover; played cards lean at natural angles on the table.
- **Readable Room IDs**: 7-character Crockford Base32 codes (no confusable characters like `0/O`, `1/L/I`, `U/V`) so they can be dictated verbally without errors.
- **Mistake-proof Entry**: The Home page shows only one primary action at a time — Join when you arrive via an invite link, Create otherwise — so you can't accidentally click the wrong button.
- **Resilient Connections**: Automatic reconnect with exponential backoff (5 attempts over ~31 s) for unplanned disconnects. When the host clicks Leave, a graceful handoff skips the grace period — the leaving host designates a successor, who reclaims the well-known peer ID so remaining clients reconnect in ~1–2 seconds instead of 30. A dedicated overlay tells users the room is reclaiming / waiting so the app never looks frozen. After a reclaim, a 20 s sweep clears any players who didn't make it back (e.g., the crashed old host) so the player list stays accurate.
- **Honest Connection Status**: A three-state dot in the header — green for live, yellow (pulsing) for reconnecting, red (pulsing) for disconnected. Hovering shows a label + short explanation; tapping on mobile pushes a toast with the same info. If the WebSocket to the PeerJS broker drops (tab backgrounded, heartbeat timeout), the app automatically calls `peer.reconnect()` behind the scenes and the dot flips back to green once re-registered.
- **Persistent Identity**: Your player ID survives page reloads, so a refresh is recognised as a reconnect rather than a duplicate player.
- **Toast Notifications**: Non-intrusive notifications for joins, leaves, reconnects, host changes, and connection errors — all auto-dismiss so stale messages don't linger after a successful reconnect.
- **Arc Browser Warning**: Arc's default WebRTC privacy settings break P2P connections without a TURN server; the app detects Arc and displays actionable guidance on how to adjust the setting.
- **Accessibility**: A "Reduce Motion" toggle disables every animation in one click.
- **Theming**: Supports Dark and Light modes.
- **Internationalization**: English and Traditional Chinese (繁體中文), switchable from the header. Auto-detects the browser language on first load and persists the choice.
- **Responsive**: Fully responsive design for mobile and desktop.

## Development

### Install Dependencies

```bash
npm install
```

### Start Local Server

```bash
npm run dev
```

### Build for Production

```bash
npm run build
```

### Lint

```bash
npm run lint
```

## Deployment

This project is configured to automatically deploy to GitHub Pages when changes are pushed to the `main` branch, via GitHub Actions (`.github/workflows/deploy.yml`).

## Known Limitations

- **No TURN server.** Peers behind symmetric NAT, certain corporate firewalls, or browsers with aggressive WebRTC privacy settings (notably **Arc Browser** in its default configuration) may fail to connect. Arc users should disable `arc://flags` → "Anonymize local IPs exposed to WebRTC", or switch to Chrome, Firefox, or Safari.
