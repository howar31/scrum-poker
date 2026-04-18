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

A single Puppeteer script at `scripts/e2e.js` drives the app through real browsers for smoke-testing, load simulation, and regression catching on the P2P migration paths. It targets `data-slot` attributes on the rendered controls so it's robust against i18n text changes, CSS text-transforms, and icon-only buttons.

#### Prerequisites

- Either `npm run dev` (default — script targets `http://localhost:5173`) or pass `--url https://your-deployment/` to point at a deployed build.
- Puppeteer is already a devDependency; `npm install` is sufficient.

#### Modes

Every mode has an `e2e:<name>` npm shortcut. The full flag list is in `npm run e2e -- --help`. All modes accept `--url`, `--headless true|false`, and `--count <n>` where relevant.

| Mode | Shortcut | Exits? | What it does | Passes when... |
| --- | --- | --- | --- | --- |
| `host` | `e2e:host` | No (SIGINT) | Creates a room, prints Room ID, keeps page open. `--duration <sec>` makes it finite. | Room ID printed to stdout. |
| `swarm` | `e2e:swarm` | No (SIGINT) | Spawns `--count` clients into `--room`, each votes at `--vote-probability`. `--verbose N` forwards the full browser console from the first N clients. | Clients join; kill with Ctrl-C. |
| `e2e` | `e2e:check` | **Yes (0/1)** | Host + N clients join, host's DOM is inspected; asserts every `TesterNN` name is visible. Suitable for CI. | Exit code 0. |
| `observe` | `e2e:observe` | No (SIGINT) | Single silent client joins `--room` and forwards browser console + page errors. Debug helper. | Manual — watch the console. |
| `transfer` | `e2e:transfer` | No (SIGINT) | Host + N clients, bot-driven graceful host transfer from Host → Tester01. Covers `HOST_LEAVING` + ACK + direct-connect + background well-known reclaim. | Final `Result:` line shows `allInRoom=true playerCountMatches=true`. |
| `crash` | `e2e:crash` | No (SIGINT) | Host + N clients, then the host page is closed abruptly (no `HOST_LEAVING`). Exercises the unplanned-disconnect path: heartbeat watchdog → Option A probe → `handleHostDisconnect` → self-promote + direct/well-known reconnect. | Final `Result:` line shows `allInRoom=true playerCountMatches=true` for the survivors. |
| `kick` | `e2e:kick` | No (SIGINT) | Host kicks Tester01 via Players panel, waits past the 5 s reject window. Catches "kicked player auto-rejoins" regressions. | Final `Result:` line shows `tester01Left=true survivorsInRoom=true playerCountMatches=true`. |

A "`Result:`" line on the final output of `transfer` / `crash` / `kick` with all fields `=true` means the scenario passed; any `false` field indicates a regression. These modes don't set an exit code — the script stays alive for browser inspection — so `grep -q "allInRoom=true"` (or similar) is the CI-friendly wrapper. `e2e:check` is the only mode that exits with a status code automatically.

#### Examples

```bash
# CI-style assertion: create host + 5 clients, exit 0/1
npm run e2e:check -- --count 5

# Drive a graceful host transfer with 3 clients, watch all migrate
npm run e2e:transfer -- --count 3

# Simulate a host crash and verify survivors reunite
npm run e2e:crash -- --count 3

# Verify kicked player doesn't auto-rejoin
npm run e2e:kick -- --count 3

# Create a room on the deployed site and keep it alive
npm run e2e:host -- --url https://lab.howar31.com/scrum-poker

# Load-test: 10 random-voting clients into an existing room
npm run e2e:swarm -- --url https://lab.howar31.com/scrum-poker --room ABC1234 --count 10

# Same swarm but forward console from the first 2 clients for debugging
npm run e2e:swarm -- --room ABC1234 --count 10 --verbose 2

# Silent single-client debug helper with full console
npm run e2e:observe -- --room ABC1234
```

## Deployment

This project is configured to automatically deploy to GitHub Pages when changes are pushed to the `main` branch, via GitHub Actions (`.github/workflows/deploy.yml`).

## Known Limitations

- **No TURN server.** Peers behind symmetric NAT, certain corporate firewalls, or browsers with aggressive WebRTC privacy settings (notably **Arc Browser** in its default configuration) may fail to connect. Arc users should disable `arc://flags` → "Anonymize local IPs exposed to WebRTC", or switch to Chrome, Firefox, or Safari.
