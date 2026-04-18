// refresh mode — client reloads mid-session. After reload the page
// returns to Home (roomId is NOT persisted); the client's playerName is
// pre-filled from localStorage and clicking Join uses the SAME playerId
// from the persisted zustand store.
//
// Asserts: the rejoin is recognized as the same player (no duplicate
// entry). NOTE: the vote itself is NOT preserved — when the browser
// tears down the DataConnection on reload, the host's conn.on('close')
// handler removes the player, and the subsequent JOIN re-adds them as
// a fresh row. This is a known app design trade-off (simple over
// resilient); captured here as explicit expected behavior so a future
// change that does preserve votes across refresh would flip the check.
import {
  clickSlot,
  delay,
  pickCard,
  printResult,
  readStoreState,
  setupRoom,
  waitForRoomRender,
} from '../helpers.js';

export async function run(browser, { baseUrl }) {
  console.log(`Refresh scenario: 1 host + 2 clients at ${baseUrl}`);

  const { hostPage, clientPages } = await setupRoom(browser, {
    baseUrl,
    clientCount: 2,
    verboseClients: false,
  });

  const t1 = clientPages[0];
  console.log('\n>>> Tester01 picks 5, then reloads <<<');
  await pickCard(t1.page, '5');
  await delay(1500);

  const beforeState = await readStoreState(hostPage);
  const countBefore = beforeState?.players.length ?? -1;

  // App's beforeunload listener (armed while in a room) shows a native
  // "Leave site?" dialog that blocks puppeteer's navigation. Auto-accept
  // it so reload can proceed.
  t1.page.on('dialog', (d) => d.accept().catch(() => {}));
  await t1.page.reload({ waitUntil: 'domcontentloaded' });
  // After reload we're back on Home with ?room= in the URL. Name is
  // persisted so the form is pre-filled; just re-click Join.
  await t1.page.waitForSelector('[data-slot="home-join"]', { timeout: 10000 });
  await clickSlot(t1.page, 'home-join');
  await waitForRoomRender(t1.page, 20000);
  await delay(3000);

  const afterState = await readStoreState(hostPage);
  const countAfter = afterState?.players.length ?? -1;
  const t1Entry = afterState?.players.find((p) => p.name === 'Tester01');

  const sameCount = countBefore === 3 && countAfter === 3; // host + 2 testers
  const noDuplicates =
    (afterState?.players ?? []).filter((p) => p.name === 'Tester01').length === 1;
  // Expected behavior: vote is NOT preserved (see file header).
  const voteLostAsExpected = t1Entry?.card === null;

  console.log(
    `countBefore=${countBefore} countAfter=${countAfter} t1.card=${t1Entry?.card}`
  );

  printResult({ sameCount, noDuplicates, voteLostAsExpected });

  console.log('\nDone. Ctrl+C to exit.');
  await new Promise(() => {});
}
