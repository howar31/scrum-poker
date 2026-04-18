// join-ux mode — Home URL routing, Room ID normalization, join cancel,
// long-wait banner flow. All Home-side behaviors.
import { clickSlot, delay, fillName, openPage, printResult } from '../helpers.js';

export async function run(browser, { baseUrl }) {
  console.log(`Join-UX scenario at ${baseUrl}`);

  // --- 1. Home routing ---
  console.log('\n>>> Visiting / (no room) <<<');
  const p1 = await openPage(browser, { isolated: true });
  await p1.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
  await delay(400);
  const hasCreate = await p1.$('[data-slot="home-create"]');
  const hasInvitedTitle = await p1.evaluate(() =>
    document.body.innerText.toLowerCase().includes("invited")
  );
  const createShownAtRoot = !!hasCreate && !hasInvitedTitle;

  console.log('\n>>> Visiting /?room=ILO123 (mix of look-alike chars) <<<');
  const p2 = await openPage(browser, { isolated: true });
  await p2.goto(`${baseUrl}/?room=ILO123`, { waitUntil: 'domcontentloaded' });
  await delay(400);
  // normalizeRoomId: I→1, L→1, O→0, U→V. "ILO123" → "110123".
  const roomInput = await p2.$eval('[data-slot="home-room-id"]', (el) => el.value);
  const normalized = roomInput === '110123';
  const hasJoin = await p2.$('[data-slot="home-join"]');
  const joinShownWithRoom = !!hasJoin;

  // --- 2. Cancel the retry ---
  console.log('\n>>> Starting join to non-existent room + cancel <<<');
  const p3 = await openPage(browser, { isolated: true });
  await p3.goto(`${baseUrl}/?room=0000000`, { waitUntil: 'domcontentloaded' });
  await fillName(p3, 'Tester');
  await clickSlot(p3, 'home-join');
  // Spinner should appear.
  await p3.waitForSelector('[data-slot="home-join-progress"]', { timeout: 5000 });
  await delay(2000);
  await clickSlot(p3, 'home-join-cancel');
  await delay(800);
  const afterCancel = await p3.$('[data-slot="home-join-progress"]');
  const backToForm = await p3.$('[data-slot="home-join"]');
  const cancelWorks = !afterCancel && !!backToForm;

  printResult({
    createShownAtRoot,
    joinShownWithRoom,
    normalized,
    cancelWorks,
  });

  console.log('\nDone. Ctrl+C to exit.');
  await new Promise(() => {});
}
