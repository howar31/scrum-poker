// copy-toast mode — clicking copy-room-id / copy-invite-link fires
// clipboard.writeText and queues a toast. Asserts toasts appear and
// auto-dismiss within the 3.5 s timer.
import { clickSlot, delay, printResult, setupRoom } from '../helpers.js';

async function countToasts(page) {
  return page.evaluate(
    () => document.querySelectorAll('[data-slot="toast-dismiss"]').length
  );
}

export async function run(browser, { baseUrl }) {
  console.log(`Copy-toast scenario at ${baseUrl}`);

  const { hostPage } = await setupRoom(browser, {
    baseUrl,
    clientCount: 0,
    verboseClients: false,
    settleMs: 300,
  });

  // Grant clipboard permission for the page's origin. Puppeteer defaults
  // to denying navigator.clipboard.writeText.
  const url = new URL(baseUrl);
  const origin = `${url.protocol}//${url.host}`;
  const context = hostPage.browserContext();
  try {
    await context.overridePermissions(origin, ['clipboard-write']);
  } catch (e) {
    console.log('clipboard permission override failed:', e.message);
  }

  const beforeCopy = await countToasts(hostPage);
  console.log('toasts before copy:', beforeCopy);

  console.log('\n>>> Click copy-room-id <<<');
  await clickSlot(hostPage, 'copy-room-id');
  await delay(300);
  const afterRoomCopy = await countToasts(hostPage);
  console.log('toasts after copy-room-id:', afterRoomCopy);
  const roomIdToast = afterRoomCopy > beforeCopy;

  console.log('\n>>> Click copy-invite-link <<<');
  await clickSlot(hostPage, 'copy-invite-link');
  await delay(300);
  const afterLinkCopy = await countToasts(hostPage);
  console.log('toasts after copy-invite-link:', afterLinkCopy);
  const linkToast = afterLinkCopy > afterRoomCopy;

  // Wait past the 3.5 s auto-dismiss. Both toasts should be gone.
  console.log('\n>>> Waiting 4.5 s for auto-dismiss <<<');
  await delay(4500);
  const afterDismiss = await countToasts(hostPage);
  console.log('toasts after 4.5 s wait:', afterDismiss);
  const toastsAutoDismiss = afterDismiss === 0;

  printResult({ roomIdToast, linkToast, toastsAutoDismiss });

  console.log('\nDone. Ctrl+C to exit.');
  await new Promise(() => {});
}
