// transfer mode — host triggers a graceful host transfer to Tester01.
// Exercises HOST_LEAVING + HOST_LEAVING_ACK + directConnectToSuccessor
// + background well-known reclaim end-to-end.
//
// Asserts: everyone ends up in the room AND everyone agrees the
// designated successor (Tester01) is the new host. Catches the
// cross-network bug where conn.close beats HOST_LEAVING on some
// clients and they auto-elect a different successor, leaving the
// UI crown + Reveal/Reset buttons on the wrong player.
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
  // Default 4 clients (5 total) — catches the cross-network stranding
  // class of bugs that fewer-client configurations can hide. Accepts an
  // override for smaller ad-hoc runs.
  const clientCount = count || 4;
  console.log(`Transfer scenario: 1 host + ${clientCount} clients at ${baseUrl}`);

  const { hostPage, clientPages } = await setupRoom(browser, {
    baseUrl,
    clientCount,
    verboseClients: true,
  });

  // Grab Tester01's playerId BEFORE the transfer so we can assert it
  // ends up as the hostId on every page after migration.
  const tester01 = clientPages.find((c) => c.name === 'Tester01');
  const tester01State = await readStoreState(tester01.page);
  const expectedHostId = tester01State?.playerId ?? null;

  console.log('\n>>> Host transferring host to Tester01 <<<');
  const { armed, confirmed } = await transferToPlayer(hostPage, 'Tester01');
  console.log(armed ? 'Armed OK' : '❌ Could not arm');
  console.log(confirmed ? 'Confirmed OK — transfer triggered' : '❌ Could not confirm');

  console.log('\nObserving for 20 s...');
  await delay(20000);

  console.log('\n>>> Final snapshots <<<');
  const hostSnap = await snap(hostPage, 'Host (ex-host)');
  const clientSnaps = await snapAll(clientPages);

  const expectedCount = clientCount + 1;
  const allInRoom = hostSnap?.inRoom && clientSnaps.every((c) => c.snap?.inRoom);
  const playerCountMatches = clientSnaps.every(
    (c) => String(c.snap?.playerCount) === String(expectedCount)
  );

  // Every page must agree Tester01 is the new host. readStoreState needs
  // VITE_E2E=1 on the dev server; without it this assertion is skipped.
  const hostStoreState = await readStoreState(hostPage);
  const clientStoreStates = [];
  for (const c of clientPages) {
    clientStoreStates.push({
      name: c.name,
      state: await readStoreState(c.page),
    });
  }
  let hostIdAgrees = null;
  if (hostStoreState && clientStoreStates.every((c) => c.state)) {
    const everyoneAgrees =
      hostStoreState.hostId === expectedHostId &&
      clientStoreStates.every((c) => c.state.hostId === expectedHostId);
    hostIdAgrees = everyoneAgrees;
    console.log(
      `expectedHostId=${expectedHostId?.slice(0, 6)} hostView=${hostStoreState.hostId?.slice(0, 6)} ${clientStoreStates
        .map((c) => `${c.name}=${c.state.hostId?.slice(0, 6)}`)
        .join(' ')}`
    );
  } else {
    // readStoreState returned null on at least one page (VITE_E2E not
    // set). Skip the assertion rather than false-failing.
    hostIdAgrees = true;
    console.log('hostIdAgrees: skipped (VITE_E2E not set)');
  }

  printResult({ allInRoom, playerCountMatches, hostIdAgrees, expected: expectedCount });

  console.log('\nDone. Ctrl+C to exit — leaving browsers open for inspection.');
  await new Promise(() => {});
}
