// solo-leave mode — last-person-leaves lifecycle. Host creates a room
// alone, opens menu, arms + confirms Leave. Asserts they end up on
// Home and the URL's ?room= param is stripped.
import { delay, leaveRoomViaMenu, printResult, setupRoom, snap } from '../helpers.js';

export async function run(browser, { baseUrl }) {
  console.log(`Solo-leave scenario at ${baseUrl}`);

  const { hostPage } = await setupRoom(browser, {
    baseUrl,
    clientCount: 0,
    verboseClients: false,
    settleMs: 300,
  });

  // Accept any "leave site?" dialog.
  hostPage.on('dialog', (d) => d.accept().catch(() => {}));

  console.log('\n>>> Opening menu and arming + confirming Leave <<<');
  const { armed, confirmed } = await leaveRoomViaMenu(hostPage);
  console.log(`armed=${armed} confirmed=${confirmed}`);

  await delay(1500);
  const afterLeave = await snap(hostPage, 'Host');
  const leftAfterConfirm =
    afterLeave?.inRoom === false && afterLeave?.onHome === true;

  const url = new URL(hostPage.url());
  const urlCleaned = !url.searchParams.has('room');
  console.log('URL after leave:', hostPage.url());

  const backOnHome = leftAfterConfirm;

  printResult({ leftAfterConfirm, backOnHome, urlCleaned });

  console.log('\nDone. Ctrl+C to exit.');
  await new Promise(() => {});
}
