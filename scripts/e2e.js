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

Flags:
  --url <url>                   Base app URL (default: http://localhost:5173)
  --room <id>                   Room ID (required for swarm / observe)
  --count <n>                   Number of clients for swarm / e2e (default: 10)
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
const voteProbability = parseFloat(parsed.values['vote-probability']);
const staggerMs = parseInt(parsed.values.stagger, 10);
const durationSec = parsed.values.duration ? parseInt(parsed.values.duration, 10) : null;
const headless = parsed.values.headless !== 'false';
const nameOverride = parsed.values.name;

if (!mode || !['host', 'swarm', 'e2e', 'observe'].includes(mode)) {
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
  await page.waitForSelector('input[placeholder*="name"]', { timeout: 15000 });
  await page.type('input[placeholder*="name"]', name);
}

async function clickButtonMatching(page, needles) {
  return page.evaluate((ns) => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const target = buttons.find((b) => {
      const t = (b.textContent ?? '').trim();
      return ns.some((n) => t.includes(n));
    });
    if (target) {
      target.click();
      return true;
    }
    return false;
  }, needles);
}

// The Room component only mounts after the first STATE_UPDATE broadcast
// arrives. The hand rail heading ("Your hand" / "你的手牌") is the signal
// that we've actually entered the room rather than lingered on Home.
async function waitForRoomRender(page, timeoutMs = 25000) {
  await page.waitForFunction(
    () => {
      const txt = document.body.innerText;
      return txt.includes('Your hand') || txt.includes('你的手牌');
    },
    { timeout: timeoutMs }
  );
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
      const btns = Array.from(document.querySelectorAll('button'));
      const t = btns.find((b) => b.textContent?.trim() === value);
      if (t) {
        t.click();
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

async function spawnSwarmClient(browser, name, joinUrl) {
  const page = await openPage(browser, { isolated: true });
  page.on('pageerror', (err) => console.log(`[${name}] pageerror:`, err.message));
  try {
    await page.goto(joinUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await fillName(page, name);
    await clickButtonMatching(page, ['Join Room', '加入房間']);
    await waitForRoomRender(page);
    console.log(`[${name}] joined`);
    setTimeout(() => tryVote(page, name), 1500 + Math.random() * 4500);
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
  await clickButtonMatching(page, ['Create New Room', '建立新房間']);
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
  console.log(`Spawning ${count} clients at ${joinUrl}`);

  for (let i = 0; i < count; i++) {
    const name = `Tester${String(i + 1).padStart(2, '0')}`;
    spawnSwarmClient(browser, name, joinUrl);
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
  await clickButtonMatching(hostPage, ['Create New Room', '建立新房間']);
  await waitForRoomRender(hostPage);
  const roomId = await getRoomIdFromUrl(hostPage);
  console.log(`Host created room ${roomId}`);

  // Phase 2: spawn N clients into that room.
  const joinUrl = `${baseUrl}/?room=${roomId}`;
  for (let i = 0; i < count; i++) {
    const name = `Tester${String(i + 1).padStart(2, '0')}`;
    await spawnSwarmClient(browser, name, joinUrl);
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
  await clickButtonMatching(page, ['Join Room', '加入房間']);

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
