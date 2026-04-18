// observe mode — single client joins an existing --room and forwards
// every browser console message. Debug helper; no Result: line.
import {
  clickSlot,
  fillName,
  openPage,
  waitForRoomRender,
} from '../helpers.js';

export async function run(browser, { baseUrl, roomArg, nameOverride }) {
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
