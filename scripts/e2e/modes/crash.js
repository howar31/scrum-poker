// crash mode — abruptly close the host page without sending
// HOST_LEAVING. Drives heartbeat → Option A probe → handleHostDisconnect
// → self-promote path.
import { delay, printResult, setupRoom, snapAll } from '../helpers.js';

export async function run(browser, { baseUrl, count }) {
  const clientCount = count || 3;
  console.log(`Crash scenario: 1 host + ${clientCount} clients at ${baseUrl}`);

  const { hostPage, clientPages } = await setupRoom(browser, {
    baseUrl,
    clientCount,
    verboseClients: true,
  });

  console.log('\n>>> Closing host page without any graceful leave <<<');
  await hostPage.close();

  console.log('\nObserving clients for 30 s while migration runs...');
  await delay(30000);

  console.log('\n>>> Final snapshots (host excluded — it was killed) <<<');
  const clientSnaps = await snapAll(clientPages);

  const expectedCount = clientCount;
  const allInRoom = clientSnaps.every((c) => c.snap?.inRoom);
  const playerCountMatches = clientSnaps.every(
    (c) => String(c.snap?.playerCount) === String(expectedCount)
  );

  printResult({ allInRoom, playerCountMatches, expected: expectedCount });

  console.log('\nDone. Ctrl+C to exit.');
  await new Promise(() => {});
}
