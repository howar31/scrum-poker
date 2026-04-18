// panel-ux mode — Players panel open / close interactions.
// Asserts the X button, backdrop click, and Escape key all close it.
import { clickSlot, delay, printResult, setupRoom } from '../helpers.js';

async function isOpen(page) {
  const el = await page.$('[data-slot="players-panel-close"]');
  return !!el;
}

async function openPanel(page) {
  await clickSlot(page, 'players-pill');
  await delay(300);
}

export async function run(browser, { baseUrl }) {
  console.log(`Panel-UX scenario: 1 host + 2 clients at ${baseUrl}`);

  const { hostPage } = await setupRoom(browser, {
    baseUrl,
    clientCount: 2,
    verboseClients: false,
  });

  // 1. Open via pill, close via X.
  await openPanel(hostPage);
  const openedInitially = await isOpen(hostPage);
  await clickSlot(hostPage, 'players-panel-close');
  await delay(300);
  const xCloses = openedInitially && !(await isOpen(hostPage));

  // 2. Open + Escape closes.
  await openPanel(hostPage);
  await hostPage.keyboard.press('Escape');
  await delay(300);
  const escapeCloses = !(await isOpen(hostPage));

  // 3. Open + click backdrop closes. The backdrop is the outer
  // fullscreen element wrapping the panel; it catches clicks outside
  // the drawer. Find by data-slot="players-panel-backdrop" if it
  // exists; otherwise click the body near the left edge (desktop) /
  // top area (mobile). For robustness we use keyboard (Escape)
  // semantics below and target the backdrop via a JS click on any
  // element outside the panel card.
  await openPanel(hostPage);
  // Click the body far from the drawer. The panel sits on the right
  // (desktop md+). Click at (5, 100) — guaranteed to hit backdrop.
  await hostPage.mouse.click(5, 100);
  await delay(500);
  const backdropCloses = !(await isOpen(hostPage));

  printResult({ xCloses, escapeCloses, backdropCloses });

  console.log('\nDone. Ctrl+C to exit.');
  await new Promise(() => {});
}
