// Shared Puppeteer helpers used by every e2e mode. Keep application-
// semantic helpers here (setupRoom, pickCard, kickPlayer, ...) so mode
// files stay short and readable, and future scenarios can be added in
// ~15 lines. Pure DOM targeting via data-slot — never match on text.

import puppeteer from 'puppeteer';
import { setTimeout as delay } from 'node:timers/promises';

export { delay };

// ---- Browser & pages --------------------------------------------------

export async function launchBrowser({ headless = true } = {}) {
  return puppeteer.launch({
    headless,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
}

// `isolated: true` gives the page its own localStorage so zustand's
// persisted `playerId` doesn't collide with other concurrent clients.
export async function openPage(browser, { isolated }) {
  const context = isolated
    ? browser.createBrowserContext
      ? await browser.createBrowserContext()
      : await browser.createIncognitoBrowserContext()
    : browser.defaultBrowserContext();
  return context.newPage();
}

// ---- Basic actions ----------------------------------------------------

export async function fillName(page, name) {
  await page.waitForSelector('[data-slot="home-name"]', { timeout: 15000 });
  await page.type('[data-slot="home-name"]', name);
}

export async function clickSlot(page, slot) {
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
export async function waitForRoomRender(page, timeoutMs = 25000) {
  await page.waitForSelector('[data-slot="hand-card"]', { timeout: timeoutMs });
}

export async function getRoomIdFromUrl(page) {
  const url = new URL(page.url());
  return url.searchParams.get('room');
}

// ---- Voting -----------------------------------------------------------

const CARDS = ['0', '0.5', '1', '2', '3', '5', '8', '13', '21', '?', '☕'];

export { CARDS };

export async function pickCard(page, value) {
  return page.evaluate((v) => {
    const target = document.querySelector(
      `[data-slot="hand-card"][data-card-value="${v}"]`
    );
    if (target instanceof HTMLElement) {
      target.click();
      return true;
    }
    return false;
  }, value);
}

export async function randomVote(page, name, voteProbability = 0.7) {
  if (Math.random() > voteProbability) {
    console.log(`[${name}] sitting out`);
    return;
  }
  const pick = CARDS[Math.floor(Math.random() * CARDS.length)];
  try {
    const clicked = await pickCard(page, pick);
    console.log(clicked ? `[${name}] voted ${pick}` : `[${name}] vote button missing`);
  } catch (err) {
    console.log(`[${name}] vote failed:`, err.message);
  }
}

export async function revealCards(hostPage) {
  return clickSlot(hostPage, 'host-reveal');
}

export async function resetCards(hostPage) {
  return clickSlot(hostPage, 'host-reset');
}

// ---- Moderator actions (two-click arm + confirm) ----------------------
// Both live only on the host's page and only while the Players panel is
// open. `playerName` must match the name shown in the `player-row` text.

export async function openPlayersPanel(page) {
  await clickSlot(page, 'players-pill');
  await delay(300);
}

export async function closePlayersPanel(page) {
  await clickSlot(page, 'players-panel-close');
  await delay(300);
}

async function findPlayerIdByName(page, playerName) {
  return page.evaluate((name) => {
    const row = Array.from(document.querySelectorAll('[data-slot="player-row"]')).find(
      (el) => el.textContent?.includes(name)
    );
    return row?.getAttribute('data-player-id') ?? null;
  }, playerName);
}

async function twoClickOn(page, slot, playerName, armDelayMs = 500) {
  // The kick / make-host buttons live inside the Players panel. Open it
  // first (idempotent — already-open is fine because clicking the pill
  // again would just close it, so we only open when there's no
  // player-row in the DOM yet).
  const panelOpen = await page.$('[data-slot="player-row"]');
  if (!panelOpen) {
    await clickSlot(page, 'players-pill');
    await delay(300);
  }
  const pid = await findPlayerIdByName(page, playerName);
  if (!pid) return { armed: false, confirmed: false, playerId: null };
  const click = () =>
    page.evaluate(
      ({ s, p }) => {
        const btn = document.querySelector(`[data-slot="${s}"][data-player-id="${p}"]`);
        if (btn instanceof HTMLElement) {
          btn.click();
          return true;
        }
        return false;
      },
      { s: slot, p: pid }
    );
  const armed = await click();
  await delay(armDelayMs);
  const confirmed = await click();
  return { armed, confirmed, playerId: pid };
}

export async function kickPlayer(hostPage, playerName) {
  return twoClickOn(hostPage, 'player-kick', playerName);
}

export async function transferToPlayer(hostPage, playerName) {
  return twoClickOn(hostPage, 'player-make-host', playerName);
}

// ---- Leave (via top-right menu) ---------------------------------------

export async function leaveRoomViaMenu(page) {
  await clickSlot(page, 'menu-trigger');
  await delay(200);
  const armed = await clickSlot(page, 'menu-leave');
  await delay(500);
  const confirmed = await clickSlot(page, 'menu-leave');
  return { armed, confirmed };
}

// ---- Client spawners --------------------------------------------------

export async function spawnSwarmClient(
  browser,
  name,
  joinUrl,
  { verbose = false, voteProbability = 0, autoVote = false } = {}
) {
  const page = await openPage(browser, { isolated: true });
  page.on('pageerror', (err) => console.log(`[${name}] pageerror:`, err.message));
  if (verbose) {
    // Forward everything — used when you need to see PeerJS signaling
    // errors, migration state transitions, etc.
    page.on('console', (msg) => console.log(`[${name}]`, msg.text().slice(0, 250)));
  }
  try {
    await page.goto(joinUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await fillName(page, name);
    await clickSlot(page, 'home-join');
    try {
      await waitForRoomRender(page);
      console.log(`[${name}] joined${verbose ? ' (verbose)' : ''}`);
      if (autoVote) {
        setTimeout(() => randomVote(page, name, voteProbability), 1500 + Math.random() * 4500);
      }
    } catch {
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

// ---- Room setup (the most-reused helper) ------------------------------
// Spawns 1 host + N isolated clients, waits for joins to settle.
// Returns { hostPage, clientPages: [{name, page}], roomId }.
export async function setupRoom(
  browser,
  {
    baseUrl,
    hostName = 'Host',
    clientCount,
    verboseHost = true,
    verboseClients = true,
    settleMs = 5000,
    autoVote = false,
  }
) {
  const hostPage = await openPage(browser, { isolated: false });
  hostPage.on('pageerror', (err) => console.log(`[${hostName}] pageerror:`, err.message));
  if (verboseHost) {
    hostPage.on('console', (msg) =>
      console.log(`[${hostName}]`, msg.text().slice(0, 250))
    );
  }

  await hostPage.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
  await fillName(hostPage, hostName);
  await clickSlot(hostPage, 'home-create');
  await waitForRoomRender(hostPage);
  const roomId = await getRoomIdFromUrl(hostPage);
  console.log(`[setupRoom] ${hostName} created ${roomId}`);

  const joinUrl = `${baseUrl}/?room=${roomId}`;
  const clientPages = [];
  for (let i = 0; i < clientCount; i++) {
    const name = `Tester${String(i + 1).padStart(2, '0')}`;
    const page = await spawnSwarmClient(browser, name, joinUrl, {
      verbose: verboseClients,
      autoVote,
      voteProbability: 0.7,
    });
    clientPages.push({ name, page });
    await delay(1500);
  }

  if (settleMs > 0) {
    console.log(`[setupRoom] waiting ${settleMs} ms for JOINs to settle...`);
    await delay(settleMs);
  }

  return { hostPage, clientPages, roomId, joinUrl };
}

// ---- Snapshot + result printing ---------------------------------------
// Uniform snapshot shape so every mode can print and assert consistently.

export async function snap(page, label) {
  const data = await page
    .evaluate(() => {
      const status = document
        .querySelector('[data-slot="connection-status"]')
        ?.getAttribute('data-status');
      const roomBanner = document
        .querySelector('[data-slot="copy-room-id"]')
        ?.textContent?.trim();
      const inRoom = !!document.querySelector('[data-slot="hand-card"]');
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
  if (label) console.log(`[${label}]`, JSON.stringify(data));
  return data;
}

export async function snapAll(labeledPages) {
  const out = [];
  for (const { name, page } of labeledPages) {
    out.push({ name, snap: await snap(page, name) });
  }
  return out;
}

// Prints the canonical Result: line. Every mode ends with one of these
// so `e2e:all` and `grep` can treat every mode uniformly.
export function printResult(checks) {
  const keys = Object.keys(checks);
  const line = keys.map((k) => `${k}=${checks[k]}`).join(' ');
  console.log(`\nResult: ${line}`);
  const pass = keys.every((k) => checks[k] === true || typeof checks[k] === 'number');
  console.log(pass ? '✅ PASS' : '❌ FAIL');
  return pass;
}

// ---- Reading UI state -------------------------------------------------

// Read stats panel values. Requires the test-only data-stat attributes
// added to src/components/Statistics.tsx.
export async function readStatistics(page) {
  return page.evaluate(() => {
    const num = (slot) => {
      const el = document.querySelector(`[data-stat="${slot}"]`);
      if (!el) return null;
      const txt = (el.textContent || '').trim();
      const m = txt.match(/[-+]?\d*\.?\d+/);
      return m ? Number(m[0]) : null;
    };
    const distribution = {};
    document.querySelectorAll('[data-stat="distribution"] [data-card-value]').forEach((el) => {
      const v = el.getAttribute('data-card-value');
      const countAttr = el.getAttribute('data-card-count');
      if (v && countAttr !== null) distribution[v] = Number(countAttr);
    });
    return {
      average: num('average'),
      min: num('min'),
      max: num('max'),
      consensusVisible: !!document.querySelector('[data-stat="consensus"]'),
      distribution,
    };
  });
}

// Test-only store read. Requires the VITE_E2E-gated window.__POKER_STATE__
// exposure in src/main.tsx.
export async function readStoreState(page) {
  return page.evaluate(() => {
    const fn = window.__POKER_STATE__;
    if (typeof fn !== 'function') return null;
    const s = fn();
    // Return a JSON-serialisable shape.
    return {
      roomId: s.roomId,
      hostId: s.hostId,
      playerId: s.playerId,
      playerName: s.playerName,
      isRevealed: s.isRevealed,
      theme: s.theme,
      animationsEnabled: s.animationsEnabled,
      migrationPhase: s.migrationPhase,
      connectionStatus: s.connectionStatus,
      players: Object.values(s.players).map((p) => ({
        id: p.id,
        name: p.name,
        card: p.card,
        peerId: p.peerId,
        joinedAt: p.joinedAt,
      })),
    };
  });
}

// Read the current toast list directly from the DOM (visible only).
export async function readToasts(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-slot="toast-dismiss"]')).map((el) => ({
      id: el.getAttribute('data-toast-id'),
      // Toast text is in a sibling node — grab the whole toast root
      // innerText to get the message.
      text: el.closest('[role="status"],[role="alert"],li,div')?.innerText?.trim() ?? '',
    }))
  );
}

// Read the <html> class list to check the theme.
export async function readThemeClass(page) {
  return page.evaluate(() => {
    const cls = document.documentElement.classList;
    return cls.contains('dark') ? 'dark' : 'light';
  });
}

// Read a hand-card's selected state by its value. A selected card has
// the blue border class `border-blue-500` applied. We match on that rather
// than text so i18n can't break us.
export async function isCardSelected(page, value) {
  return page.evaluate((v) => {
    const btn = document.querySelector(`[data-slot="hand-card"][data-card-value="${v}"]`);
    return !!btn && btn.className.includes('border-blue-500');
  }, value);
}
