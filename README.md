# Scrum Poker

A Serverless P2P Scrum Poker web application built with React, Vite, TailwindCSS, and PeerJS.
This application allows teams to estimate stories without requiring a backend server or database.

## Features

- **Serverless & P2P**: WebRTC (via PeerJS) for real-time communication between browsers. No server-side state.
- **Readable Room IDs**: 7-character Crockford Base32 codes (no confusable characters like `0/O`, `1/L/I`, `U/V`) so they can be dictated verbally without errors.
- **Resilient Connections**: Automatic reconnect with exponential backoff (5 attempts over ~31 s). If reconnection truly fails, host migration kicks in — the oldest remaining peer is promoted to host and everyone else reconnects to them.
- **Persistent Identity**: Your player ID survives page reloads, so a refresh is recognised as a reconnect rather than a duplicate player.
- **Toast Notifications**: Non-intrusive notifications for joins, leaves, reconnects, and host changes.
- **Arc Browser Warning**: Arc's default WebRTC privacy settings break P2P connections without a TURN server; the app detects Arc and displays actionable guidance on how to adjust the setting.
- **Rich Animations**: Staggered card reveal, spring-based player list animations, and card selection feedback — all powered by Framer Motion. A "Reduce Motion" toggle disables everything for performance or accessibility.
- **Theming**: Supports Dark and Light modes.
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
