// Generates README showcase assets against a local dev server.
// - 5 static PNGs via Puppeteer screenshots
// - 1 animated hero GIF via Puppeteer page.screencast + ffmpeg palette pipeline
// Prerequisites: `npm run dev` running at http://localhost:5173, and ffmpeg on PATH.
// Usage: node scripts/generate-screenshots.js

import { mkdir, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  launchBrowser,
  openPage,
  fillName,
  clickSlot,
  pickCard,
  waitForRoomRender,
  getRoomIdFromUrl,
  spawnSwarmClient,
  delay,
} from './e2e/helpers.js';

const BASE_URL = process.env.SCREENSHOT_BASE_URL || 'http://localhost:5173';
const OUT_DIR = path.resolve('docs/screenshots');

const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 2 };
// 428×926 viewport at DPR 1.5 yields exactly 642×1389 output, matching the
// compressed pwa.png dimensions byte-for-byte so all three README mobile
// cells render at identical natural width (no DPR / pHYs drift).
const MOBILE = {
  width: 428,
  height: 926,
  deviceScaleFactor: 1.5,
  isMobile: true,
  hasTouch: true,
};
// Hero GIF: 1x DPR keeps file size tractable for animated content.
const HERO = { width: 1280, height: 800, deviceScaleFactor: 1 };

const HOST_NAME = 'Howard';
const BOTS = ['Alice', 'Bob', 'Chen', 'Diya', 'Elena', 'Finn'];

// ---- Menu helpers (open → toggle → close) -----------------------------

async function openMenu(page) {
  await clickSlot(page, 'menu-trigger');
  await delay(300);
}
async function closeMenu(page) {
  // The menu-trigger button toggles; clicking it again closes the menu.
  await clickSlot(page, 'menu-trigger');
  await delay(200);
}

async function ensureTheme(page, target) {
  const current = await page.evaluate(() =>
    document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  );
  if (current === target) return;
  await openMenu(page);
  await clickSlot(page, 'menu-theme');
  await delay(300);
  await closeMenu(page);
}

async function ensureLang(page, target) {
  const current = await page.evaluate(
    () => localStorage.getItem('scrum-poker-lang') || 'en'
  );
  if (current === target) return;
  await openMenu(page);
  await clickSlot(page, 'menu-language');
  await delay(400);
  await closeMenu(page);
}

// ---- Room setup builder -----------------------------------------------

async function makeHost(browser, viewport) {
  const page = await openPage(browser, { isolated: true });
  await page.setViewport(viewport);
  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle0' });
  await fillName(page, HOST_NAME);
  return page;
}

async function spawnBots(browser, joinUrl, names) {
  const pages = [];
  for (const name of names) {
    const page = await spawnSwarmClient(browser, name, joinUrl, {
      verbose: false,
      autoVote: false,
    });
    pages.push({ name, page });
    await delay(700);
  }
  return pages;
}

async function setupRoom({
  browser,
  viewport,
  botNames,
  theme = 'dark',
  lang = 'en',
}) {
  const hostPage = await makeHost(browser, viewport);
  await ensureTheme(hostPage, theme);
  await ensureLang(hostPage, lang);
  await clickSlot(hostPage, 'home-create');
  await waitForRoomRender(hostPage);
  const roomId = await getRoomIdFromUrl(hostPage);
  const joinUrl = `${BASE_URL}/?room=${roomId}`;
  const botPages = await spawnBots(browser, joinUrl, botNames);
  await delay(2000);
  return { hostPage, botPages, roomId };
}

async function shoot(page, file) {
  const target = path.join(OUT_DIR, file);
  await page.screenshot({ path: target, fullPage: false });
  const s = await stat(target);
  console.log(`  saved ${file} (${(s.size / 1024).toFixed(0)} KB)`);
}

async function closeAll(hostPage, botPages) {
  await hostPage.close();
  for (const { page } of botPages) await page.close();
}

// ---- PNG captures -----------------------------------------------------

async function captureHome(browser) {
  console.log('[1/6] home.png — desktop light en');
  const page = await openPage(browser, { isolated: true });
  await page.setViewport(DESKTOP);
  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle0' });
  await fillName(page, HOST_NAME);
  await delay(300);
  await ensureTheme(page, 'light');
  await ensureLang(page, 'en');
  await delay(400);
  await shoot(page, 'home.png');
  await page.close();
}

async function captureRoomVoting(browser) {
  console.log('[2/6] room-voting.png — desktop dark zh-TW');
  const { hostPage, botPages } = await setupRoom({
    browser,
    viewport: DESKTOP,
    botNames: BOTS.slice(0, 5),
    theme: 'dark',
    lang: 'zh-TW',
  });
  // 3 of 5 bots vote — shows partial progress in Statistics panel
  const votes = ['3', '5', '3'];
  for (let i = 0; i < votes.length; i++) {
    await pickCard(botPages[i].page, votes[i]);
    await delay(300);
  }
  await delay(1500);
  await shoot(hostPage, 'room-voting.png');
  await closeAll(hostPage, botPages);
}

async function capturePlayersPanel(browser) {
  console.log('[3/6] players-panel.png — desktop dark en');
  const { hostPage, botPages } = await setupRoom({
    browser,
    viewport: DESKTOP,
    botNames: BOTS.slice(0, 5),
    theme: 'dark',
    lang: 'en',
  });
  const votes = ['3', '5', '3', '5', '8'];
  for (let i = 0; i < votes.length; i++) {
    await pickCard(botPages[i].page, votes[i]);
    await delay(250);
  }
  await delay(1200);
  await clickSlot(hostPage, 'host-reveal');
  await delay(2000);
  await clickSlot(hostPage, 'players-pill');
  await delay(800);
  await shoot(hostPage, 'players-panel.png');
  await closeAll(hostPage, botPages);
}

async function captureMobileRoom(browser) {
  console.log('[4/6] mobile-room.png — 428×926 dark en');
  const { hostPage, botPages } = await setupRoom({
    browser,
    viewport: MOBILE,
    botNames: BOTS.slice(0, 4),
    theme: 'dark',
    lang: 'en',
  });
  const votes = ['3', '5', '3'];
  for (let i = 0; i < votes.length; i++) {
    await pickCard(botPages[i].page, votes[i]);
    await delay(300);
  }
  await delay(1500);
  await shoot(hostPage, 'mobile-room.png');
  await closeAll(hostPage, botPages);
}

async function captureMobilePanel(browser) {
  console.log('[5/6] mobile-panel.png — 428×926 dark en (bottom sheet)');
  const { hostPage, botPages } = await setupRoom({
    browser,
    viewport: MOBILE,
    botNames: BOTS.slice(0, 4),
    theme: 'dark',
    lang: 'en',
  });
  const votes = ['3', '5', '3', '5'];
  for (let i = 0; i < votes.length; i++) {
    await pickCard(botPages[i].page, votes[i]);
    await delay(250);
  }
  await delay(1500);
  await clickSlot(hostPage, 'host-reveal');
  await delay(2000);
  await clickSlot(hostPage, 'players-pill');
  await delay(800);
  await shoot(hostPage, 'mobile-panel.png');
  await closeAll(hostPage, botPages);
}

// ---- Hero GIF (two-round disagreement → consensus) --------------------

async function ffmpegWebmToGif(webmPath, gifPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i',
      webmPath,
      '-vf',
      'fps=15,scale=1280:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5',
      '-loop',
      '0',
      gifPath,
    ];
    const ff = spawn('ffmpeg', args);
    let err = '';
    ff.stderr.on('data', (d) => (err += d));
    ff.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${err.slice(-400)}`))
    );
  });
}

async function captureHeroGif(browser) {
  console.log('[6/6] hero.gif — two-round scene → ffmpeg');
  const { hostPage, botPages } = await setupRoom({
    browser,
    viewport: HERO,
    botNames: BOTS,
    theme: 'dark',
    lang: 'en',
  });
  // HERO viewport already applied in makeHost.
  await delay(500);

  const webmPath = path.join(OUT_DIR, 'hero.webm');
  const gifPath = path.join(OUT_DIR, 'hero.gif');
  const recorder = await hostPage.screencast({ path: webmPath });
  console.log('  recording started');

  // t=0: hold empty table briefly
  await delay(500);

  // Round 1 — disagreement: spread votes
  const round1 = ['2', '3', '5', '8', '8', '13'];
  for (let i = 0; i < BOTS.length; i++) {
    await pickCard(botPages[i].page, round1[i]);
    await delay(280);
  }
  await delay(500);

  // Host reveals Round 1
  await clickSlot(hostPage, 'host-reveal');
  await delay(1800); // let cards flip + stats panel render + hold for "see the gap"

  // Reset (implying team discussion)
  await clickSlot(hostPage, 'host-reset');
  await delay(700);

  // Round 2 — consensus: everyone votes 5
  for (let i = 0; i < BOTS.length; i++) {
    await pickCard(botPages[i].page, '5');
    await delay(260);
  }
  await delay(400);

  // Host reveals Round 2
  await clickSlot(hostPage, 'host-reveal');
  await delay(2200); // hold on consensus payoff

  await recorder.stop();
  console.log('  recording stopped, converting to GIF...');

  await ffmpegWebmToGif(webmPath, gifPath);
  const s = await stat(gifPath);
  console.log(`  saved hero.gif (${(s.size / 1024 / 1024).toFixed(2)} MB)`);
  // Keep webm around only if ffmpeg succeeded — delete intermediate
  await rm(webmPath, { force: true });

  await closeAll(hostPage, botPages);
}

// ---- Main -------------------------------------------------------------

async function run() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await launchBrowser({ headless: true });
  try {
    await captureHome(browser);
    await captureRoomVoting(browser);
    await capturePlayersPanel(browser);
    await captureMobileRoom(browser);
    await captureMobilePanel(browser);
    await captureHeroGif(browser);
    console.log('\nDone. Assets in', OUT_DIR);
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
