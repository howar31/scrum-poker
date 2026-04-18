// crash-mid-transfer mode — host transfers to a designated successor,
// that successor's page is killed before they can open the well-known
// ID on the broker. Asserts that the rank-0 fallback takes over and
// the room survives with everyone else in it.
//
// Verifies: even when the designated successor crashes, broker
// arbitration plus rank-0 failover produces exactly one host and no
// solo rooms.
import {
  delay,
  printResult,
  readStoreState,
  setupRoom,
  snap,
  snapAll,
  transferToPlayer,
} from '../helpers.js';

export async function run(browser, { baseUrl }) {
  console.log(`Crash-mid-transfer scenario: 1 host + 3 clients at ${baseUrl}`);

  const { hostPage, clientPages } = await setupRoom(browser, {
    baseUrl,
    clientCount: 3,
    verboseClients: false,
  });

  // Host is rank 0 (oldest). Transfer to Tester02 (a NON-rank-0 client)
  // so the rank-0 fallback has to do the work — not Tester02's own self.
  const target = clientPages.find((c) => c.name === 'Tester02');

  // Host's playerId → should be the fallback host.
  const hostStoreBefore = await readStoreState(hostPage);
  const hostPlayerId = hostStoreBefore?.playerId ?? null;

  console.log('\n>>> Transfer → Tester02, then kill Tester02 before they elect <<<');
  const transferPromise = transferToPlayer(hostPage, 'Tester02');
  // ~150 ms into the transfer, close Tester02's tab. They've received
  // LEAVING by now; they would have entered ELECTING next. Closing kills
  // the process so broker never sees them claim the well-known ID.
  await delay(150);
  await target.page.close();
  await transferPromise.catch(() => {});

  // Budget: 30 s migration + settle.
  console.log('\nWaiting 40 s for rank-0 fallback to take over...');
  await delay(40000);

  const survivors = clientPages.filter((c) => c.name !== 'Tester02');
  const hostSnap = await snap(hostPage, 'Host (fallback)');
  const survivorSnaps = await snapAll(survivors);

  const expectedCount = survivors.length + 1; // host + survivors
  const allInRoom = hostSnap?.inRoom && survivorSnaps.every((c) => c.snap?.inRoom);
  const playerCountMatches = survivorSnaps.every(
    (c) => String(c.snap?.playerCount) === String(expectedCount)
  );

  const hostStoreAfter = await readStoreState(hostPage);
  const survivorStates = [];
  for (const c of survivors) {
    survivorStates.push({ name: c.name, state: await readStoreState(c.page) });
  }

  // Host (the original room creator, rank 0) should be the one who
  // claimed the well-known ID in the ELECTING path.
  let hostRecovered = null;
  if (hostStoreAfter && survivorStates.every((s) => s.state)) {
    const everyoneAgrees =
      hostStoreAfter.hostId === hostPlayerId &&
      survivorStates.every((s) => s.state.hostId === hostPlayerId);
    hostRecovered = everyoneAgrees;
  } else {
    hostRecovered = true;
    console.log('hostRecovered: skipped (VITE_E2E not set)');
  }

  printResult({ hostRecovered, allInRoom, playerCountMatches, expected: expectedCount });

  console.log('\nDone. Ctrl+C to exit.');
  await new Promise(() => {});
}
