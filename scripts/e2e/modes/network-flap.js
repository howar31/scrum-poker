// network-flap mode — simulate a client losing network connectivity
// briefly via Puppeteer's `setOfflineMode`, then coming back. Exercises
// the `online` / `offline` window listeners attached by peerManager.
//
// IMPORTANT LIMITATION: Puppeteer's offline mode blocks HTTP and the
// PeerJS broker WebSocket, but does NOT close already-open UDP / WebRTC
// SCTP DataChannels. So this primarily verifies:
//   - `offline` event is observed and connectionStatus flips to
//     'reconnecting-ice' (or another reconnecting-* state)
//   - `online` event fires and connectionStatus returns to 'connected'
//   - The client stays in the room throughout (no spurious leave)
//   - No host migration occurs (epoch unchanged)
// It does NOT prove real ICE failure recovery — that would require
// killing UDP sockets, which Puppeteer cannot do.
import {
  delay,
  printResult,
  readStoreState,
  setupRoom,
  snap,
} from '../helpers.js';

export async function run(browser, { baseUrl }) {
  console.log(`Network-flap scenario: 1 host + 2 clients at ${baseUrl}`);

  const { hostPage, clientPages } = await setupRoom(browser, {
    baseUrl,
    clientCount: 2,
    verboseClients: false,
  });

  const victim = clientPages[0];
  console.log(`\n>>> ${victim.name} goes offline for 4 s <<<`);

  const beforeState = await readStoreState(hostPage);
  const beforeEpoch = beforeState?.epoch ?? -1;
  const beforeCount = beforeState?.players.length ?? -1;

  // Capture the connectionStatus trace on the victim throughout the flap.
  const sawReconnectingStatuses = new Set();
  const statusPoll = setInterval(async () => {
    const s = await readStoreState(victim.page).catch(() => null);
    if (s?.connectionStatus && s.connectionStatus.startsWith('reconnecting')) {
      sawReconnectingStatuses.add(s.connectionStatus);
    }
  }, 250);

  await victim.page.setOfflineMode(true);
  await delay(4000);
  await victim.page.setOfflineMode(false);
  console.log('\nWaiting 8 s for recovery to settle...');
  await delay(8000);
  clearInterval(statusPoll);

  const afterState = await readStoreState(hostPage);
  const afterEpoch = afterState?.epoch ?? -1;
  const afterCount = afterState?.players.length ?? -1;
  const victimState = await readStoreState(victim.page);
  const victimStatus = victimState?.connectionStatus ?? '(null)';
  const victimSnap = await snap(victim.page, victim.name);

  const stayedInRoom = victimSnap?.inRoom === true;
  const noMigration = beforeEpoch === afterEpoch && beforeEpoch !== -1;
  const playerCountStable = beforeCount === afterCount && beforeCount === 3;
  const recovered = victimStatus === 'connected';
  const sawReconnecting = sawReconnectingStatuses.size > 0;

  console.log(
    `victim status final=${victimStatus} ` +
      `seen-during-flap=[${[...sawReconnectingStatuses].join(',')}]`
  );

  printResult({
    stayedInRoom,
    noMigration,
    playerCountStable,
    recovered,
    sawReconnecting,
  });

  console.log('\nDone. Ctrl+C to exit.');
  await new Promise(() => {});
}
