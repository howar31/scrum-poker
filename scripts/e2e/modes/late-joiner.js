// late-joiner mode — a fresh client arrives via ?room=XYZ WHILE the
// host transfer is still in flight. Asserts the late joiner eventually
// lands in the room, and final playerCount converges on every peer.
import {
  delay,
  printResult,
  setupRoom,
  snap,
  snapAll,
  spawnSwarmClient,
  transferToPlayer,
} from '../helpers.js';

export async function run(browser, { baseUrl }) {
  console.log(`Late-joiner scenario: 1 host + 2 clients + 1 late joiner at ${baseUrl}`);

  const { hostPage, clientPages, joinUrl } = await setupRoom(browser, {
    baseUrl,
    clientCount: 2,
    verboseClients: false,
  });

  console.log('\n>>> Firing transfer to Tester01 <<<');
  const transferPromise = transferToPlayer(hostPage, 'Tester01');

  // Fire the new joiner almost immediately so they arrive during the
  // ACK/direct-connect window — tests joinRoomWithRetry + migration
  // interaction.
  await delay(300);
  console.log('>>> Spawning late joiner during migration <<<');
  const latePage = await spawnSwarmClient(browser, 'Tester99', joinUrl, {
    verbose: false,
  });

  await transferPromise;
  console.log('\nWaiting 25 s for everything to settle...');
  await delay(25000);

  const hostSnap = await snap(hostPage, 'Host');
  const clientSnaps = await snapAll(clientPages);
  const lateSnap = await snap(latePage, 'Tester99');

  const expectedCount = 4; // host + Tester01 + Tester02 + Tester99
  const lateJoined = lateSnap?.inRoom === true;
  const allInRoom =
    hostSnap?.inRoom && clientSnaps.every((c) => c.snap?.inRoom) && lateJoined;
  const playerCountConverges =
    String(hostSnap?.playerCount) === String(expectedCount) &&
    String(lateSnap?.playerCount) === String(expectedCount) &&
    clientSnaps.every((c) => String(c.snap?.playerCount) === String(expectedCount));

  printResult({ lateJoined, allInRoom, playerCountConverges, expected: expectedCount });

  console.log('\nDone. Ctrl+C to exit.');
  await new Promise(() => {});
}
