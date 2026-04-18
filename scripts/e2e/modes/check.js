// check mode (also aliased as 'e2e'). Host creates a room, N clients
// join, then assert host's DOM shows every TesterNN name. Exits with
// code 0/1 — suitable for CI.
import {
  clickSlot,
  delay,
  fillName,
  getRoomIdFromUrl,
  openPage,
  spawnSwarmClient,
  waitForRoomRender,
} from '../helpers.js';

export async function run(browser, { baseUrl, count, verboseCount }) {
  console.log(`Running E2E check with ${count} clients at ${baseUrl}`);

  const hostPage = await openPage(browser, { isolated: false });
  await hostPage.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
  await fillName(hostPage, 'Host');
  await clickSlot(hostPage, 'home-create');
  await waitForRoomRender(hostPage);
  const roomId = await getRoomIdFromUrl(hostPage);
  console.log(`Host created room ${roomId}`);

  const joinUrl = `${baseUrl}/?room=${roomId}`;
  for (let i = 0; i < count; i++) {
    const name = `Tester${String(i + 1).padStart(2, '0')}`;
    await spawnSwarmClient(browser, name, joinUrl, { verbose: i < verboseCount });
    if (i < count - 1) await delay(800);
  }

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
