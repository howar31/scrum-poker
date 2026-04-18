// kick mode — host kicks Tester01. Asserts the kicked client ends up
// on Home (didn't auto-rejoin) and the survivors still show the
// correct reduced playerCount. Regression guard for the
// "reconnect loop too eager" bug fixed in commit 2dcb915.
import { delay, kickPlayer, printResult, setupRoom, snap, snapAll } from '../helpers.js';

export async function run(browser, { baseUrl, count }) {
  const clientCount = count || 3;
  console.log(`Kick scenario: 1 host + ${clientCount} clients at ${baseUrl}`);

  const { hostPage, clientPages } = await setupRoom(browser, {
    baseUrl,
    clientCount,
    verboseClients: true,
  });

  console.log('\n>>> Host kicking Tester01 <<<');
  const { armed, confirmed } = await kickPlayer(hostPage, 'Tester01');
  console.log(armed ? 'Armed OK' : '❌ Could not arm');
  console.log(confirmed ? 'Confirmed OK — kick triggered' : '❌ Could not confirm');

  // Wait past KICK_REJECT_WINDOW_MS (5 s) + room broadcast settle.
  console.log('\nObserving for 10 s (covers the 5 s reject window)...');
  await delay(10000);

  console.log('\n>>> Final snapshots <<<');
  const hostSnap = await snap(hostPage, 'Host');
  const clientSnaps = await snapAll(clientPages);

  const expectedCount = clientCount; // host + remaining testers
  const tester01 = clientSnaps.find((c) => c.name === 'Tester01');
  const survivors = clientSnaps.filter((c) => c.name !== 'Tester01');

  const tester01Left = tester01?.snap?.onHome === true && tester01?.snap?.inRoom === false;
  const survivorsInRoom = hostSnap?.inRoom && survivors.every((c) => c.snap?.inRoom);
  const playerCountMatches =
    String(hostSnap?.playerCount) === String(expectedCount) &&
    survivors.every((c) => String(c.snap?.playerCount) === String(expectedCount));

  printResult({
    tester01Left,
    survivorsInRoom,
    playerCountMatches,
    expected: expectedCount,
  });

  console.log('\nDone. Ctrl+C to exit.');
  await new Promise(() => {});
}
