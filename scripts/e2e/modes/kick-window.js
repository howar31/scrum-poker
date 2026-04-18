// kick-window mode — host kicks Tester01; within the 5 s reject window
// a manual re-join attempt is rejected; after the window expires, a
// manual re-join succeeds. Regression guard for the KICK_REJECT_WINDOW_MS
// mechanism added in commit 2dcb915.
import { clickSlot, delay, kickPlayer, printResult, setupRoom, snap } from '../helpers.js';

async function attemptRejoin(page) {
  // After kick, page is back on Home (with ?room= still in URL). Name is
  // persisted; just click Join.
  const hasJoinBtn = await page.$('[data-slot="home-join"]');
  if (!hasJoinBtn) return false;
  return clickSlot(page, 'home-join');
}

export async function run(browser, { baseUrl }) {
  console.log(`Kick-window scenario: 1 host + 2 clients at ${baseUrl}`);

  const { hostPage, clientPages } = await setupRoom(browser, {
    baseUrl,
    clientCount: 2,
    verboseClients: false,
  });

  const t1 = clientPages.find((c) => c.name === 'Tester01');
  console.log('\n>>> Host kicks Tester01 <<<');
  await kickPlayer(hostPage, 'Tester01');
  // Wait for kick to propagate to Tester01.
  await delay(1500);

  const afterKick = await snap(t1.page, 'Tester01 post-kick');
  const kickedLanded = afterKick?.onHome === true && afterKick?.inRoom === false;

  // Attempt re-join WITHIN the 5 s reject window. Host should send KICKED
  // again and close the new conn; client ends up still on Home.
  console.log('\n>>> Tester01 attempts to rejoin immediately (within reject window) <<<');
  await attemptRejoin(t1.page);
  // Give the handshake a moment to fail.
  await delay(3500);

  const afterEarlyRejoin = await snap(t1.page, 'Tester01 post-early-rejoin');
  const blockedWithinWindow =
    afterEarlyRejoin?.onHome === true && afterEarlyRejoin?.inRoom === false;

  // Wait until the reject window has passed (total elapsed since kick > 5 s).
  console.log('\n>>> Waiting for reject window to expire, then rejoining <<<');
  await delay(3000);
  await attemptRejoin(t1.page);
  await delay(4000);

  const afterLateRejoin = await snap(t1.page, 'Tester01 post-late-rejoin');
  const rejoinAfterWindow =
    afterLateRejoin?.inRoom === true && afterLateRejoin?.onHome === false;

  printResult({ kickedLanded, blockedWithinWindow, rejoinAfterWindow });

  console.log('\nDone. Ctrl+C to exit.');
  await new Promise(() => {});
}
