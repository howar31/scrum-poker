# Scrum Poker

A Serverless P2P Scrum Poker web application built with React, Vite, TailwindCSS, and PeerJS.
This application allows teams to estimate stories without requiring a backend server or database.

## Features

- **Serverless & P2P**: WebRTC (via PeerJS) for real-time communication between browsers. No server-side state.
- **Table-style Layout**: All played cards are laid out on a felt table so everyone's vote is visible at a glance, even with 8+ players. A dedicated Statistics panel shows Average, Min, Max, Consensus badge, and vote distribution as soon as cards are revealed.
- **Players Panel**: An on-demand drawer (right-side on desktop, bottom sheet on mobile) lists every player with vote status and host crown. Transfer host and kick live here with a two-click confirmation so you can't misfire on a quick tap. Kicked users return to the Home screen with a toast and won't auto-reconnect back into the room.
- **Rich Card Effects**: Pointer-tracked 3D tilt, crystalline glass-style card back with layered fixed highlights, and a physical "pick up → flip → place down" reveal animation. Hand cards lift on hover; played cards lean at natural angles on the table.
- **Readable Room IDs**: 7-character Crockford Base32 codes (no confusable characters like `0/O`, `1/L/I`, `U/V`) so they can be dictated verbally without errors.
- **Mistake-proof Entry**: The Home page shows only one primary action at a time — Join when you arrive via an invite link, Create otherwise — so you can't accidentally click the wrong button.
- **Fast Host Migration (~10 s, regardless of broker grace)**: An application-layer heartbeat detects a dead host within ~8 seconds instead of waiting for WebRTC's built-in 15–30 s ICE timeout. The elected successor keeps their original peer ID so existing members can direct-connect to them immediately — no waiting for the PeerJS broker to release the well-known room ID. In the background, the new host opens a *second* PeerJS peer at the well-known ID (with up to ~70 s of retries) purely so late joiners via `?room=XYZ` can still find the room. Existing members never notice the reclaim.
- **Resilient Joins**: If a new joiner arrives while the room is switching hosts, the Join form turns into a cancellable retry with a spinner and a progress message that distinguishes "can't find this room yet" from "host isn't responding". The retry never pauses — after 30 s it surfaces a non-blocking banner explaining it's still trying, which you can dismiss or use to Give up. Walk away, come back, or bail out at any time.
- **Graceful Leave / Transfer**: When the host clicks Leave or transfers host, the leaving host broadcasts the authoritative successor and **waits for every client to acknowledge** before tearing down. Without the ACK round-trip, cross-network transfers in 4+ player rooms could lose the handoff message to laggier peers (real-world RTT outruns any short fixed flush) — now the teardown is a hard consequence of delivery. A dedicated overlay tells users the room is switching so the app never looks frozen.
- **No-host Deadman Recovery**: If a handoff still fails (e.g., the designated successor's network dropped mid-migration so nobody becomes host), clients fall into a rank-staggered recovery keyed by join time — the oldest-joined player (typically the original room creator) self-promotes first, and others stagger by `rank × 3 s` before trying to reconnect or, if still no host, take over themselves. The room survives instead of evicting everyone, and the original host is the natural first fallback.
- **Ghost Sweep**: After a migration, a 20 s sweep clears any players who didn't make it back (e.g., the crashed old host) so the player list stays accurate.
- **Honest Connection Status**: A three-state dot in the header — green for live, yellow (pulsing) for reconnecting, red (pulsing) for disconnected. On desktop the status label renders inline next to the dot; on mobile it stays icon-only to save space, and tapping it pushes a toast with the full explanation. If the WebSocket to the PeerJS broker drops (tab backgrounded, heartbeat timeout), the app automatically calls `peer.reconnect()` behind the scenes and the dot flips back to green once re-registered.
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

### End-to-end browser automation

A single Puppeteer script at `scripts/e2e.js` drives the app through real browsers for smoke-testing and load simulation. It targets `data-slot` attributes on the rendered controls so it's robust against i18n text changes and icon-only buttons. All modes accept `--url` (defaults to `http://localhost:5173`) and other flags — run `npm run e2e -- --help` for the full list.

```bash
# Create a room in a headless browser and keep it alive
npm run e2e:host -- --url https://lab.howar31.com/scrum-poker

# Spawn 10 clients into an existing room; each randomly votes
npm run e2e:swarm -- --url https://lab.howar31.com/scrum-poker --room ABC1234 --count 10

# Same, but forward the full browser console from the first 2 clients
# (useful when debugging host migration or reconnect flow)
npm run e2e:swarm -- --room ABC1234 --count 10 --verbose 2

# Create host + 5 clients, assert host sees them all, exit with code 0/1
npm run e2e:check -- --count 5

# Silent single-client debug helper with console forwarding
npm run e2e:observe -- --room ABC1234
```

## Deployment

This project is configured to automatically deploy to GitHub Pages when changes are pushed to the `main` branch, via GitHub Actions (`.github/workflows/deploy.yml`).

## Known Limitations

- **No TURN server.** Peers behind symmetric NAT, certain corporate firewalls, or browsers with aggressive WebRTC privacy settings (notably **Arc Browser** in its default configuration) may fail to connect. Arc users should disable `arc://flags` → "Anonymize local IPs exposed to WebRTC", or switch to Chrome, Firefox, or Safari.
