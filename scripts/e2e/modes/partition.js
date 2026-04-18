// partition mode — simulate two clients leaving via the menu at almost
// the same moment. Historically the old state.hostId + ghost-cleanup
// machinery could leave dangling players in this scenario; under the
// new design conn.on('close') on the host side removes them cleanly.
//
// (Note: cleanly testing true network-partition-and-recover requires
// reliable CDP control over WebRTC, which Puppeteer doesn't currently
// provide — offline-mode only blocks HTTP, not UDP. Triggering a
// deliberate graceful leave on each minority page is the closest we
// can get without exposing internal peerManager methods to tests.)
//
// Asserts: majority (host + 2 surviving clients) stays together with
// accurate playerCount; host is still the same host; no split-brain.
import { clickSlot, delay, printResult, readStoreState, setupRoom, snap, snapAll } from '../helpers.js';

export async function run(browser, { baseUrl }) {
  console.log(`Partition scenario: 1 host + 4 clients at ${baseUrl}`);

  const { hostPage, clientPages } = await setupRoom(browser, {
    baseUrl,
    clientCount: 4,
    verboseClients: false,
  });

  const hostState = await readStoreState(hostPage);
  const hostPlayerId = hostState?.playerId ?? null;

  const minority = clientPages.filter((c) =>
    ['Tester03', 'Tester04'].includes(c.name)
  );
  const majority = clientPages.filter(
    (c) => !['Tester03', 'Tester04'].includes(c.name)
  );

  console.log('\n>>> Two clients leaving simultaneously via menu <<<');
  // Arm + confirm menu-leave in parallel on both minority pages.
  await Promise.all(
    minority.map(async ({ page }) => {
      await clickSlot(page, 'menu-trigger');
      await delay(100);
      await clickSlot(page, 'menu-leave');
      await delay(500);
      await clickSlot(page, 'menu-leave');
    })
  );

  // Both leaves triggered near-simultaneously. Host side gets two
  // conn.on('close') events back-to-back.
  console.log('\nWaiting 8 s for departure to propagate...');
  await delay(8000);

  const hostSnap = await snap(hostPage, 'Host');
  const majoritySnaps = await snapAll(majority);
  const expectedCount = majority.length + 1; // host + surviving clients
  const majorityInRoom =
    hostSnap?.inRoom && majoritySnaps.every((c) => c.snap?.inRoom);
  const majorityCountMatches =
    String(hostSnap?.playerCount) === String(expectedCount) &&
    majoritySnaps.every(
      (c) => String(c.snap?.playerCount) === String(expectedCount)
    );
  const hostStill =
    (await readStoreState(hostPage))?.hostId === hostPlayerId;

  // Minority should be back on Home.
  const minoritySnaps = await snapAll(minority);
  const minorityLeftRoom = minoritySnaps.every(
    (c) => c.snap?.onHome === true || c.snap?.inRoom !== true
  );

  printResult({
    majorityInRoom,
    majorityCountMatches,
    hostStill,
    minorityLeftRoom,
    expected: expectedCount,
  });

  console.log('\nDone. Ctrl+C to exit.');
  await new Promise(() => {});
}
