// ice-restart mode — invoke the VITE_E2E-gated
// `window.__POKER_PEER__.restartIce()` hook on a client and assert that
// the DataConnection survives, no host migration is triggered, and the
// store's connectionStatus pulses through 'reconnecting-ice' before
// returning to 'connected'.
//
// Unlike network-flap, this drives the restartIce() code path directly
// without any simulated network failure — useful for verifying the
// reactive plumbing (status transitions, debounce, watchdog non-firing)
// in a deterministic environment.
import {
  delay,
  printResult,
  readStoreState,
  setupRoom,
  snap,
} from '../helpers.js';

export async function run(browser, { baseUrl }) {
  console.log(`ICE-restart scenario: 1 host + 2 clients at ${baseUrl}`);

  const { hostPage, clientPages } = await setupRoom(browser, {
    baseUrl,
    clientCount: 2,
    verboseClients: false,
  });

  const victim = clientPages[0];
  console.log(`\n>>> ${victim.name} triggering ICE restart via debug hook <<<`);

  const beforeState = await readStoreState(hostPage);
  const beforeEpoch = beforeState?.epoch ?? -1;
  const beforeCount = beforeState?.players.length ?? -1;

  const sawReconnectingStatuses = new Set();
  const statusPoll = setInterval(async () => {
    const s = await readStoreState(victim.page).catch(() => null);
    if (s?.connectionStatus && s.connectionStatus.startsWith('reconnecting')) {
      sawReconnectingStatuses.add(s.connectionStatus);
    }
  }, 200);

  const hookFired = await victim.page.evaluate(() => {
    const w = window;
    if (w.__POKER_PEER__ && typeof w.__POKER_PEER__.restartIce === 'function') {
      w.__POKER_PEER__.restartIce();
      return true;
    }
    return false;
  });

  await delay(7000);
  clearInterval(statusPoll);

  const afterState = await readStoreState(hostPage);
  const afterEpoch = afterState?.epoch ?? -1;
  const afterCount = afterState?.players.length ?? -1;
  const victimState = await readStoreState(victim.page);
  const victimSnap = await snap(victim.page, victim.name);

  const stayedInRoom = victimSnap?.inRoom === true;
  const noMigration = beforeEpoch === afterEpoch && beforeEpoch !== -1;
  const playerCountStable = beforeCount === afterCount && beforeCount === 3;
  const recovered = victimState?.connectionStatus === 'connected';
  const sawIceReconnecting = sawReconnectingStatuses.has('reconnecting-ice');

  console.log(
    `hookFired=${hookFired} final=${victimState?.connectionStatus} ` +
      `seen-during-restart=[${[...sawReconnectingStatuses].join(',')}]`
  );

  printResult({
    hookFired,
    stayedInRoom,
    noMigration,
    playerCountStable,
    recovered,
    sawIceReconnecting,
  });

  console.log('\nDone. Ctrl+C to exit.');
  await new Promise(() => {});
}
