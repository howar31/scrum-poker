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

  // Budget: migration is up to MIGRATION_BUDGET_MS (60 s) + settle time.
  // Under dirty crash the broker alive_timeout can hold the well-known
  // ID for ~60 s so we wait 70 s for convergence.
  console.log('\nObserving clients for 70 s while migration runs...');
  await delay(70000);

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
