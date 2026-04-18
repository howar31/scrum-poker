// deadman mode — force the recoverNoHost fallback path. Host transfers
// to Tester02 (rank 2) then that page is immediately closed before
// Tester02 can selfPromote. Asserts the rank-0 deadman (Host) takes
// the room back.
import { delay, printResult, readStoreState, setupRoom, snap, transferToPlayer } from '../helpers.js';

export async function run(browser, { baseUrl }) {
  console.log(`Deadman scenario: 1 host + 3 clients at ${baseUrl}`);

  const { hostPage, clientPages } = await setupRoom(browser, {
    baseUrl,
    clientCount: 3,
    verboseClients: false,
  });

  const tester02 = clientPages.find((c) => c.name === 'Tester02');

  // Grab Host's playerId so we can verify it ends up as the new hostId.
  const hostState = await readStoreState(hostPage);
  const hostPlayerId = hostState?.playerId;

  console.log('\n>>> Host transfers to Tester02 then Tester02 is killed <<<');
  // Fire the transfer but don't await — we want to kill Tester02 mid-flight.
  const transferPromise = transferToPlayer(hostPage, 'Tester02');
  await delay(150);
  // Kill the chosen successor before they have a chance to selfPromote.
  await tester02.page.close();
  await transferPromise.catch(() => {});

  // Budget: 20 s migration + rank*3 s stagger + direct-connect settle.
  // Host is rank 0 (oldest), so it recovers at t≈20 s. Others (ranks 1,
  // 2) stagger; Tester01 tries at t≈23 s, reaches host via well-known.
  console.log('\nWaiting 40 s for deadman recovery...');
  await delay(40000);

  const finalHostState = await readStoreState(hostPage);
  const hostSnap = await snap(hostPage, 'Host');

  const survivors = clientPages.filter((c) => c.name !== 'Tester02');
  const survivorSnaps = [];
  for (const { name, page } of survivors) {
    survivorSnaps.push({ name, snap: await snap(page, name) });
  }

  const hostRecovered =
    finalHostState?.hostId === hostPlayerId && hostSnap?.inRoom === true;
  const survivorsInRoom = survivorSnaps.every((c) => c.snap?.inRoom === true);

  printResult({ hostRecovered, survivorsInRoom });

  console.log('\nDone. Ctrl+C to exit.');
  await new Promise(() => {});
}
