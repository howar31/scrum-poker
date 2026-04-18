#!/usr/bin/env node
/**
 * End-to-end browser automation for Scrum Poker, driven by Puppeteer.
 *
 * Replaces the old test-host / test-live / test-live-e2e / test-10-clients
 * scripts. Pick a mode and pass flags:
 *
 *   node scripts/e2e.js --mode host   --url https://lab.howar31.com/scrum-poker
 *   node scripts/e2e.js --mode swarm  --url ... --room ABCDEFG --count 10
 *   node scripts/e2e.js --mode e2e    --url ... --count 5
 *   node scripts/e2e.js --mode observe --url ... --room ABCDEFG
 *
 * Or via npm scripts (see package.json):
 *   npm run e2e:swarm -- --room ABCDEFG --count 5
 *
 * Run `--help` for the full flag list.
 */
import puppeteer from 'puppeteer';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const CARDS = ['0', '0.5', '1', '2', '3', '5', '8', '13', '21', '?', '☕'];

const HELP_TEXT = `
Scrum Poker E2E driver

Usage:
  node scripts/e2e.js --mode <mode> [flags]

Modes:
  host      Create a room and stay alive. Prints the Room ID on success.
  swarm     Spawn N clients that join an existing --room and randomly vote.
  e2e       Create a host + spawn N clients, assert host sees all of them, exit.
  observe   Single silent client that joins --room and forwards console logs.
  transfer  host + N clients (default 2) + bot-driven host transfer from host to
            Tester01, all verbose. Diagnostic-only; exits after observation.
  crash     host + N clients (default 3), then kill the host page abruptly
            (no HOST_LEAVING) so migration is driven by heartbeat + handleHostDisconnect.
            Verifies the unplanned-disconnect path rather than the graceful one.
  kick      host + N clients (default 3), host kicks Tester01, asserts
            Tester01 lands on Home and survivors show the reduced playerCount.
            Verifies the reconnect loop isn't too eager (kicked player
            shouldn't pop right back in).

Flags:
  --url <url>                   Base app URL (default: http://localhost:5173)
  --room <id>                   Room ID (required for swarm / observe)
  --count <n>                   Number of clients for swarm / e2e (default: 10)
  --verbose <n>                 Forward full browser console for the first N swarm clients (default: 0)
  --vote-probability <0..1>     Chance each swarm client votes (default: 0.7)
  --stagger <ms>                Delay between spawning each swarm client (default: 2500)
  --duration <sec>              Exit after N seconds (host mode; default: stay alive)
  --headless <true|false>       Run browsers headless (default: true)
  --name <name>                 Override the auto-generated display name
  --help                        Show this message

Examples:
  node scripts/e2e.js --mode host --url https://lab.howar31.com/scrum-poker
  node scripts/e2e.js --mode swarm --url https://lab.howar31.com/scrum-poker \\
    --room Y8QEZCS --count 10
  # 10 clients, first 2 forward full console — useful for host-transfer debugging
  node scripts/e2e.js --mode swarm --room XXX --count 10 --verbose 2
  npm run e2e:check -- --url http://localhost:5173 --count 5
`;

// ---- CLI parsing -------------------------------------------------------

const parsed = parseArgs({
  strict: false,
  options: {
    mode: { type: 'string' },
    url: { type: 'string', default: 'http://localhost:5173' },
    room: { type: 'string' },
    count: { type: 'string', default: '10' },
    verbose: { type: 'string', default: '0' },
    'vote-probability': { type: 'string', default: '0.7' },
    stagger: { type: 'string', default: '2500' },
    duration: { type: 'string' },
    headless: { type: 'string', default: 'true' },
    name: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (parsed.values.help) {
  console.log(HELP_TEXT);
  process.exit(0);
}

const mode = parsed.values.mode;
const baseUrl = (parsed.values.url ?? '').replace(/\/$/, '');
const roomArg = parsed.values.room;
const count = parseInt(parsed.values.count, 10);
const verboseCount = parseInt(parsed.values.verbose, 10);
const voteProbability = parseFloat(parsed.values['vote-probability']);
const staggerMs = parseInt(parsed.values.stagger, 10);
const durationSec = parsed.values.duration ? parseInt(parsed.values.duration, 10) : null;
const headless = parsed.values.headless !== 'false';
const nameOverride = parsed.values.name;

if (
  !mode ||
  !['host', 'swarm', 'e2e', 'observe', 'transfer', 'crash', 'kick'].includes(mode)
) {
  console.error('Error: missing or invalid --mode. Run with --help for options.');
  process.exit(1);
}

// ---- Browser / page helpers -------------------------------------------

async function openPage(browser, { isolated }) {
  // `isolated: true` gives the page its own localStorage so zustand's
  // persisted `playerId` doesn't collide with other concurrent clients.
  const context = isolated
    ? browser.createBrowserContext
      ? await browser.createBrowserContext()
      : await browser.createIncognitoBrowserContext()
    : browser.defaultBrowserContext();
  return context.newPage();
}

async function fillName(page, name) {
  await page.waitForSelector('[data-slot="home-name"]', { timeout: 15000 });
  await page.type('[data-slot="home-name"]', name);
}

async function clickSlot(page, slot) {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-slot="${id}"]`);
    if (el instanceof HTMLElement) {
      el.click();
      return true;
    }
    return false;
  }, slot);
}

// The Room component only mounts after the first STATE_UPDATE broadcast
// arrives. The hand rail cards carry a stable `data-slot="hand-card"`
// attribute — waiting for one is language- and text-transform-agnostic.
async function waitForRoomRender(page, timeoutMs = 25000) {
  await page.waitForSelector('[data-slot="hand-card"]', { timeout: timeoutMs });
}

async function getRoomIdFromUrl(page) {
  const url = new URL(page.url());
  return url.searchParams.get('room');
}

// ---- Voting ------------------------------------------------------------

async function tryVote(page, name) {
  if (Math.random() > voteProbability) {
    console.log(`[${name}] sitting out`);
    return;
  }
  const pick = CARDS[Math.floor(Math.random() * CARDS.length)];
  try {
    const clicked = await page.evaluate((value) => {
      const target = document.querySelector(
        `[data-slot="hand-card"][data-card-value="${value}"]`
      );
      if (target instanceof HTMLElement) {
        target.click();
        return true;
      }
      return false;
    }, pick);
    console.log(clicked ? `[${name}] voted ${pick}` : `[${name}] vote button missing`);
  } catch (err) {
    console.log(`[${name}] vote failed:`, err.message);
  }
}

// ---- Client spawners --------------------------------------------------

async function spawnSwarmClient(browser, name, joinUrl, { verbose = false } = {}) {
  const page = await openPage(browser, { isolated: true });
  page.on('pageerror', (err) => console.log(`[${name}] pageerror:`, err.message));
  if (verbose) {
    // Forward everything — used when you need to see PeerJS signaling
    // errors, migration state transitions, etc. Truncate to keep one
    // line per log.
    page.on('console', (msg) => console.log(`[${name}]`, msg.text().slice(0, 250)));
  }
  try {
    await page.goto(joinUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await fillName(page, name);
    await clickSlot(page, 'home-join');
    try {
      await waitForRoomRender(page);
      console.log(`[${name}] joined${verbose ? ' (verbose)' : ''}`);
      setTimeout(() => tryVote(page, name), 1500 + Math.random() * 4500);
    } catch {
      // Hand rail never appeared. Dump a short snapshot so we can tell
      // the difference between "still on Home with error banner" vs
      // "joined but detection selector is wrong".
      const snapshot = await page
        .evaluate(() => document.body.innerText.slice(0, 200).replace(/\s+/g, ' '))
        .catch(() => '(unreadable)');
      console.log(`[${name}] never saw hand rail. body="${snapshot}"`);
    }
  } catch (err) {
    console.log(`[${name}] setup failed:`, err.message);
  }
  return page;
}

// ---- Modes ------------------------------------------------------------

async function runHost(browser) {
  const page = await openPage(browser, { isolated: false });
  page.on('pageerror', (err) => console.log('[host] pageerror:', err.message));

  console.log(`Creating a room at ${baseUrl}...`);
  await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
  await fillName(page, nameOverride ?? 'Host');
  await clickSlot(page, 'home-create');
  await waitForRoomRender(page);

  const roomId = await getRoomIdFromUrl(page);
  console.log(`\n✅ Room created: ${roomId}`);
  console.log(`Invite URL: ${baseUrl}/?room=${roomId}\n`);

  if (durationSec != null) {
    console.log(`Staying alive for ${durationSec}s...`);
    await delay(durationSec * 1000);
    return;
  }
  console.log('Stay-alive mode — Ctrl+C to exit.');
  await new Promise(() => {});
}

async function runSwarm(browser) {
  if (!roomArg) {
    console.error('Error: --room is required for swarm mode');
    process.exit(1);
  }
  const joinUrl = `${baseUrl}/?room=${roomArg}`;
  const verboseMsg = verboseCount > 0 ? ` (${verboseCount} verbose)` : '';
  console.log(`Spawning ${count} clients${verboseMsg} at ${joinUrl}`);

  for (let i = 0; i < count; i++) {
    const name = `Tester${String(i + 1).padStart(2, '0')}`;
    spawnSwarmClient(browser, name, joinUrl, { verbose: i < verboseCount });
    if (i < count - 1) await delay(staggerMs);
  }

  console.log(`\nAll ${count} clients spawned. Votes trickle in over the next few seconds.`);
  console.log('Ctrl+C to exit.');
  await new Promise(() => {});
}

async function runE2E(browser) {
  console.log(`Running E2E check with ${count} clients at ${baseUrl}`);

  // Phase 1: host creates room.
  const hostPage = await openPage(browser, { isolated: false });
  await hostPage.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
  await fillName(hostPage, 'Host');
  await clickSlot(hostPage, 'home-create');
  await waitForRoomRender(hostPage);
  const roomId = await getRoomIdFromUrl(hostPage);
  console.log(`Host created room ${roomId}`);

  // Phase 2: spawn N clients into that room.
  const joinUrl = `${baseUrl}/?room=${roomId}`;
  for (let i = 0; i < count; i++) {
    const name = `Tester${String(i + 1).padStart(2, '0')}`;
    await spawnSwarmClient(browser, name, joinUrl, { verbose: i < verboseCount });
    if (i < count - 1) await delay(800);
  }

  // Phase 3: let JOIN actions propagate, then assert host sees everyone.
  await delay(5000);
  const body = await hostPage.evaluate(() => document.body.innerText);
  const seen = new Set(body.match(/Tester\d{2}/g) ?? []);
  if (seen.size >= count) {
    console.log(`\n✅ E2E PASS: host sees ${seen.size}/${count} clients`);
    process.exit(0);
  }
  console.log(`\n❌ E2E FAIL: host only sees ${seen.size}/${count} clients`);
  console.log('Seen:', [...seen].sort().join(', '));
  process.exit(1);
}

async function runObserve(browser) {
  if (!roomArg) {
    console.error('Error: --room is required for observe mode');
    process.exit(1);
  }
  const joinUrl = `${baseUrl}/?room=${roomArg}`;
  const page = await openPage(browser, { isolated: false });
  page.on('console', (msg) => console.log('[observe]', msg.text().slice(0, 250)));
  page.on('pageerror', (err) => console.log('[observe] pageerror:', err.message));

  console.log(`Joining ${joinUrl} as silent observer...`);
  await page.goto(joinUrl, { waitUntil: 'domcontentloaded' });
  await fillName(page, nameOverride ?? 'Observer');
  await clickSlot(page, 'home-join');

  try {
    await waitForRoomRender(page, 20000);
    console.log('[observe] joined');
  } catch {
    console.log('[observe] failed to enter room (see logs above)');
  }

  console.log('Observing — Ctrl+C to exit.');
  await new Promise(() => {});
}

// ---- Entry point ------------------------------------------------------

// Host creates a room, N clients join, then the host drives a two-click
// transfer to the first Tester. Everything runs verbose so the console
// timeline shows HOST_LEAVING broadcast → reclaim attempts on the new
// host → waiting + scheduleReconnect on other clients → final state.
async function runTransfer(browser) {
  const clientCount = count || 2;
  console.log(`Transfer scenario: 1 host + ${clientCount} clients at ${baseUrl}`);

  // Host (default context so its console mirrors a real user's browser).
  const hostPage = await openPage(browser, { isolated: false });
  hostPage.on('console', (msg) => console.log('[Host]', msg.text().slice(0, 250)));
  hostPage.on('pageerror', (err) => console.log('[Host] pageerror:', err.message));

  await hostPage.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
  await fillName(hostPage, 'Host');
  await clickSlot(hostPage, 'home-create');
  await waitForRoomRender(hostPage);
  const roomId = await getRoomIdFromUrl(hostPage);
  console.log(`Host created room ${roomId}\n`);

  // Clients — isolated so playerIds don't collide. Keep page handles so
  // we can snapshot each one post-transfer to verify nobody got kicked
  // out during migration.
  const joinUrl = `${baseUrl}/?room=${roomId}`;
  const clientPages = [];
  for (let i = 0; i < clientCount; i++) {
    const name = `Tester${String(i + 1).padStart(2, '0')}`;
    const page = await spawnSwarmClient(browser, name, joinUrl, { verbose: true });
    clientPages.push({ name, page });
    await delay(1500);
  }

  console.log('\nLetting JOINs settle for 5 s...');
  await delay(5000);

  // Host triggers transfer on Tester01. Open players panel → find
  // Tester01's row → click make-host twice (arm + confirm).
  console.log('\n>>> Host clicking Players pill <<<');
  await clickSlot(hostPage, 'players-pill');
  await delay(600);

  console.log('>>> Host clicking make-host on Tester01 (1/2: arm) <<<');
  const tester01Id = await hostPage.evaluate(() => {
    const row = Array.from(document.querySelectorAll('[data-slot="player-row"]')).find(
      (el) => el.textContent?.includes('Tester01')
    );
    return row?.getAttribute('data-player-id') ?? null;
  });
  if (!tester01Id) {
    console.log('❌ Could not find Tester01 in player list');
    return;
  }
  console.log(`Tester01 playerId = ${tester01Id}`);

  const clickMakeHost = () =>
    hostPage.evaluate((pid) => {
      const btn = document.querySelector(
        `[data-slot="player-make-host"][data-player-id="${pid}"]`
      );
      if (btn instanceof HTMLElement) {
        btn.click();
        return true;
      }
      return false;
    }, tester01Id);

  const armed = await clickMakeHost();
  console.log(armed ? 'Armed OK' : '❌ Could not arm');
  await delay(500);

  console.log('>>> Host clicking make-host on Tester01 (2/2: confirm) <<<');
  const confirmed = await clickMakeHost();
  console.log(confirmed ? 'Confirmed OK — transfer triggered' : '❌ Could not confirm');

  console.log('\nObserving for 20 s...');
  await delay(20000);

  // Post-mortem snapshot from every page so we can tell at a glance
  // whether anyone was dropped by the migration. Also asserts the player
  // count in the new host's view matches the spawned total.
  const snap = async (page, label) => {
    const data = await page
      .evaluate(() => {
        const status = document
          .querySelector('[data-slot="connection-status"]')
          ?.getAttribute('data-status');
        const roomBanner = document
          .querySelector('[data-slot="copy-room-id"]')
          ?.textContent?.trim();
        const inRoom = !!document.querySelector('[data-slot="hand-card"]');
        // Players pill shows the total count as its trailing text node.
        const pillText = document
          .querySelector('[data-slot="players-pill"]')
          ?.textContent?.trim();
        const playerCount = pillText ? (pillText.match(/\d+/)?.[0] ?? null) : null;
        return { status, roomBanner, inRoom, playerCount };
      })
      .catch(() => null);
    console.log(`[${label}]`, JSON.stringify(data));
    return data;
  };

  console.log('\n>>> Final snapshots <<<');
  const hostSnap = await snap(hostPage, 'Host (ex-host)');
  const clientSnaps = [];
  for (const { name, page } of clientPages) {
    clientSnaps.push({ name, snap: await snap(page, name) });
  }

  const expectedCount = clientCount + 1; // host + clients
  const allInRoom =
    hostSnap?.inRoom && clientSnaps.every((c) => c.snap?.inRoom);
  const countMatches = clientSnaps.every(
    (c) => String(c.snap?.playerCount) === String(expectedCount)
  );
  console.log(
    `\nResult: allInRoom=${allInRoom} playerCountMatches=${countMatches} expected=${expectedCount}`
  );

  console.log('\nDone. Ctrl+C to exit — leaving browsers open for inspection.');
  await new Promise(() => {});
}

// Unplanned-disconnect simulation: host creates room, N clients join, then
// the host's page is killed abruptly (no HOST_LEAVING broadcast). Exercises
// heartbeat detection → Option A probe → handleHostDisconnect → migration
// path, which transfer mode does NOT cover (that one fires HOST_LEAVING).
async function runCrash(browser) {
  const clientCount = count || 3;
  console.log(`Crash scenario: 1 host + ${clientCount} clients at ${baseUrl}`);

  const hostPage = await openPage(browser, { isolated: false });
  hostPage.on('console', (msg) => console.log('[Host]', msg.text().slice(0, 250)));
  hostPage.on('pageerror', (err) => console.log('[Host] pageerror:', err.message));

  await hostPage.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
  await fillName(hostPage, 'Host');
  await clickSlot(hostPage, 'home-create');
  await waitForRoomRender(hostPage);
  const roomId = await getRoomIdFromUrl(hostPage);
  console.log(`Host created room ${roomId}\n`);

  const joinUrl = `${baseUrl}/?room=${roomId}`;
  const clientPages = [];
  for (let i = 0; i < clientCount; i++) {
    const name = `Tester${String(i + 1).padStart(2, '0')}`;
    const page = await spawnSwarmClient(browser, name, joinUrl, { verbose: true });
    clientPages.push({ name, page });
    await delay(1500);
  }

  console.log('\nLetting JOINs settle for 5 s...');
  await delay(5000);

  // Abrupt kill — no HOST_LEAVING, just the tab vanishing mid-session.
  // Closing the page tears down the Peer's WebSocket but skips the normal
  // teardown listeners, which is exactly what a real crash looks like from
  // each client's perspective.
  console.log('\n>>> Closing host page without any graceful leave <<<');
  await hostPage.close();

  console.log('\nObserving clients for 30 s while migration runs...');
  await delay(30000);

  const snap = async (page, label) => {
    const data = await page
      .evaluate(() => {
        const status = document
          .querySelector('[data-slot="connection-status"]')
          ?.getAttribute('data-status');
        const roomBanner = document
          .querySelector('[data-slot="copy-room-id"]')
          ?.textContent?.trim();
        const inRoom = !!document.querySelector('[data-slot="hand-card"]');
        const pillText = document
          .querySelector('[data-slot="players-pill"]')
          ?.textContent?.trim();
        const playerCount = pillText ? (pillText.match(/\d+/)?.[0] ?? null) : null;
        return { status, roomBanner, inRoom, playerCount };
      })
      .catch(() => null);
    console.log(`[${label}]`, JSON.stringify(data));
    return data;
  };

  console.log('\n>>> Final snapshots (host excluded — it was killed) <<<');
  const clientSnaps = [];
  for (const { name, page } of clientPages) {
    clientSnaps.push({ name, snap: await snap(page, name) });
  }

  const expectedCount = clientCount; // host is gone
  const allInRoom = clientSnaps.every((c) => c.snap?.inRoom);
  const countMatches = clientSnaps.every(
    (c) => String(c.snap?.playerCount) === String(expectedCount)
  );
  console.log(
    `\nResult: allInRoom=${allInRoom} playerCountMatches=${countMatches} expected=${expectedCount}`
  );

  console.log('\nDone. Ctrl+C to exit.');
  await new Promise(() => {});
}

// Kick-out regression: host kicks Tester01 via the Players panel, we wait
// out any auto-reconnect window, then assert Tester01 really left (Home
// page visible, not a hand rail) and the remaining room shows the correct
// reduced playerCount. Catches the "reconnect loop too eager, kicked
// player pops right back" bug.
async function runKick(browser) {
  const clientCount = count || 3;
  console.log(`Kick scenario: 1 host + ${clientCount} clients at ${baseUrl}`);

  const hostPage = await openPage(browser, { isolated: false });
  hostPage.on('console', (msg) => console.log('[Host]', msg.text().slice(0, 250)));
  hostPage.on('pageerror', (err) => console.log('[Host] pageerror:', err.message));

  await hostPage.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
  await fillName(hostPage, 'Host');
  await clickSlot(hostPage, 'home-create');
  await waitForRoomRender(hostPage);
  const roomId = await getRoomIdFromUrl(hostPage);
  console.log(`Host created room ${roomId}\n`);

  const joinUrl = `${baseUrl}/?room=${roomId}`;
  const clientPages = [];
  for (let i = 0; i < clientCount; i++) {
    const name = `Tester${String(i + 1).padStart(2, '0')}`;
    const page = await spawnSwarmClient(browser, name, joinUrl, { verbose: true });
    clientPages.push({ name, page });
    await delay(1500);
  }

  console.log('\nLetting JOINs settle for 5 s...');
  await delay(5000);

  // Host triggers kick on Tester01. Open players panel → find row → click
  // player-kick twice (arm + confirm).
  console.log('\n>>> Host clicking Players pill <<<');
  await clickSlot(hostPage, 'players-pill');
  await delay(600);

  const tester01Id = await hostPage.evaluate(() => {
    const row = Array.from(document.querySelectorAll('[data-slot="player-row"]')).find(
      (el) => el.textContent?.includes('Tester01')
    );
    return row?.getAttribute('data-player-id') ?? null;
  });
  if (!tester01Id) {
    console.log('❌ Could not find Tester01 in player list');
    return;
  }
  console.log(`Tester01 playerId = ${tester01Id}`);

  const clickKick = () =>
    hostPage.evaluate((pid) => {
      const btn = document.querySelector(
        `[data-slot="player-kick"][data-player-id="${pid}"]`
      );
      if (btn instanceof HTMLElement) {
        btn.click();
        return true;
      }
      return false;
    }, tester01Id);

  console.log('>>> Host clicking kick on Tester01 (1/2: arm) <<<');
  const armed = await clickKick();
  console.log(armed ? 'Armed OK' : '❌ Could not arm');
  await delay(500);

  console.log('>>> Host clicking kick on Tester01 (2/2: confirm) <<<');
  const confirmed = await clickKick();
  console.log(confirmed ? 'Confirmed OK — kick triggered' : '❌ Could not confirm');

  // Wait longer than KICK_REJECT_WINDOW_MS (5 s) so we also prove the
  // reject window expires cleanly without the kicked client popping back
  // in during it. If they were going to reconnect, they would've by now.
  console.log('\nObserving for 10 s (covers the 5 s reject window)...');
  await delay(10000);

  const snap = async (page, label) => {
    const data = await page
      .evaluate(() => {
        const status = document
          .querySelector('[data-slot="connection-status"]')
          ?.getAttribute('data-status');
        const roomBanner = document
          .querySelector('[data-slot="copy-room-id"]')
          ?.textContent?.trim();
        const inRoom = !!document.querySelector('[data-slot="hand-card"]');
        // Kicked clients should land back on Home, which shows
        // home-create (no ?room=) or home-join (with ?room=). Either
        // presence signals we're not in a Room anymore.
        const onHome =
          !!document.querySelector('[data-slot="home-create"]') ||
          !!document.querySelector('[data-slot="home-join"]');
        const pillText = document
          .querySelector('[data-slot="players-pill"]')
          ?.textContent?.trim();
        const playerCount = pillText ? (pillText.match(/\d+/)?.[0] ?? null) : null;
        return { status, roomBanner, inRoom, onHome, playerCount };
      })
      .catch(() => null);
    console.log(`[${label}]`, JSON.stringify(data));
    return data;
  };

  console.log('\n>>> Final snapshots <<<');
  const hostSnap = await snap(hostPage, 'Host');
  const clientSnaps = [];
  for (const { name, page } of clientPages) {
    clientSnaps.push({ name, snap: await snap(page, name) });
  }

  // Host + (clientCount - 1) survivors (Tester01 was kicked).
  const expectedCount = clientCount; // host + remaining testers
  const tester01 = clientSnaps.find((c) => c.name === 'Tester01');
  const survivors = clientSnaps.filter((c) => c.name !== 'Tester01');

  const tester01Left = tester01?.snap?.onHome === true && tester01?.snap?.inRoom === false;
  const survivorsInRoom =
    hostSnap?.inRoom && survivors.every((c) => c.snap?.inRoom);
  const countMatches =
    String(hostSnap?.playerCount) === String(expectedCount) &&
    survivors.every((c) => String(c.snap?.playerCount) === String(expectedCount));

  console.log(
    `\nResult: tester01Left=${tester01Left} survivorsInRoom=${survivorsInRoom} playerCountMatches=${countMatches} expected=${expectedCount}`
  );

  console.log('\nDone. Ctrl+C to exit.');
  await new Promise(() => {});
}

async function main() {
  const browser = await puppeteer.launch({
    headless,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await browser.close().catch(() => {});
    process.exit(0);
  });

  try {
    switch (mode) {
      case 'host':
        await runHost(browser);
        break;
      case 'swarm':
        await runSwarm(browser);
        break;
      case 'e2e':
        await runE2E(browser);
        break;
      case 'observe':
        await runObserve(browser);
        break;
      case 'transfer':
        await runTransfer(browser);
        break;
      case 'crash':
        await runCrash(browser);
        break;
      case 'kick':
        await runKick(browser);
        break;
    }
  } finally {
    // e2e / finite-duration host exits here; swarm / observe keep the
    // promise pending and never reach this point until SIGINT.
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
