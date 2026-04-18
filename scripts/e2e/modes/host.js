// host mode — create a room, print Room ID, stay alive. Debug/smoke
// helper, no Result: line.
import {
  clickSlot,
  delay,
  fillName,
  getRoomIdFromUrl,
  openPage,
  waitForRoomRender,
} from '../helpers.js';

export async function run(browser, { baseUrl, durationSec, nameOverride }) {
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
