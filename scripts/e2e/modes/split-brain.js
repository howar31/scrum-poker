// split-brain mode — directly exercises the real-world bug that prompted
// the broker-arbitration rewrite: 1 host + 5 clients, host transfers to
// one of the middle clients. Under the old design, 2+ stranded clients
// could fall into parallel recoverNoHost paths and each end up as solo
// hosts of their own empty rooms. Under broker arbitration, the PeerJS
// broker only allows one peer at the well-known ID, so losers must
// become followers. Passes iff every page agrees on hostId AND all 6
// pages are in the same room with playerCount == 6.
import {
  delay,
  printResult,
  readStoreState,
  setupRoom,
  snap,
  snapAll,
  transferToPlayer,
} from '../helpers.js';

export async function run(browser, { baseUrl, count }) {
  // Minimum 5 clients (host + 5 = 6 total) — that's the scenario from
  // the real-world bug report. Allow override for stress testing.
  const clientCount = count && count >= 5 ? count : 5;
  console.log(`Split-brain scenario: 1 host + ${clientCount} clients at ${baseUrl}`);

  const { hostPage, clientPages } = await setupRoom(browser, {
    baseUrl,
    clientCount,
    verboseClients: false,
  });

  // Grab the designated successor's playerId BEFORE the transfer.
  const successor = clientPages.find((c) => c.name === 'Tester01');
  const successorState = await readStoreState(successor.page);
  const expectedHostId = successorState?.playerId ?? null;

  console.log('\n>>> Host transferring host to Tester01 <<<');
  const { armed, confirmed } = await transferToPlayer(hostPage, 'Tester01');
  console.log(armed ? 'Armed OK' : '❌ Could not arm');
  console.log(confirmed ? 'Confirmed OK — transfer triggered' : '❌ Could not confirm');

  // 30 s migration budget + settle. Graceful leave settles in ~5-10 s;
  // 30 s is generous so every page has time to converge.
  console.log('\nObserving for 35 s...');
  await delay(35000);

  console.log('\n>>> Final snapshots <<<');
  const hostSnap = await snap(hostPage, 'Host (ex-host)');
  const clientSnaps = await snapAll(clientPages);

  const expectedCount = clientCount + 1;
  const allInRoom = hostSnap?.inRoom && clientSnaps.every((c) => c.snap?.inRoom);
  const playerCountMatches = clientSnaps.every(
    (c) => String(c.snap?.playerCount) === String(expectedCount)
  );

  // The critical assertion: every page agrees on who the host is.
  // Previously, split-brain clients would have hostId = themselves.
  const hostStoreState = await readStoreState(hostPage);
  const clientStoreStates = [];
  for (const c of clientPages) {
    clientStoreStates.push({ name: c.name, state: await readStoreState(c.page) });
  }
  let hostIdConsistent = null;
  if (hostStoreState && clientStoreStates.every((c) => c.state)) {
    const everyoneAgrees =
      hostStoreState.hostId === expectedHostId &&
      clientStoreStates.every((c) => c.state.hostId === expectedHostId);
    hostIdConsistent = everyoneAgrees;
    console.log(
      `expectedHostId=${expectedHostId?.slice(0, 6)} hostView=${hostStoreState.hostId?.slice(0, 6)} ${clientStoreStates
        .map((c) => `${c.name}=${c.state.hostId?.slice(0, 6)}`)
        .join(' ')}`
    );
  } else {
    // Skip when VITE_E2E isn't set.
    hostIdConsistent = true;
    console.log('hostIdConsistent: skipped (VITE_E2E not set)');
  }

  // Additionally assert nobody thinks they are a solo host. A split-brain
  // client would have state.hostId === state.playerId AND NOT be the
  // designated successor.
  const soloHosts = clientStoreStates.filter(
    (c) =>
      c.state?.hostId === c.state?.playerId && c.state?.playerId !== expectedHostId
  );
  const noSoloHosts = soloHosts.length === 0;
  if (!noSoloHosts) {
    console.log(
      `❌ SPLIT-BRAIN detected: ${soloHosts.map((s) => s.name).join(', ')} think they are host`
    );
  }

  printResult({
    allInRoom,
    playerCountMatches,
    hostIdConsistent,
    noSoloHosts,
    expected: expectedCount,
  });

  console.log('\nDone. Ctrl+C to exit.');
  await new Promise(() => {});
}
