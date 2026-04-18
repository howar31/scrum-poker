// disarm mode — two-click arm + 3 s auto-disarm timeout. First click
// on player-kick arms the button (data-confirming=true). After waiting
// > 3 s the arm should have cleared; a second click should re-arm
// rather than fire the kick. Guards the PlayersPanel disarm behavior.
import { delay, printResult, setupRoom, snap } from '../helpers.js';

async function armingState(hostPage, playerId) {
  return hostPage.evaluate((pid) => {
    const btn = document.querySelector(
      `[data-slot="player-kick"][data-player-id="${pid}"]`
    );
    return btn?.getAttribute('data-confirming') ?? null;
  }, playerId);
}

async function clickKick(hostPage, playerId) {
  return hostPage.evaluate((pid) => {
    const btn = document.querySelector(
      `[data-slot="player-kick"][data-player-id="${pid}"]`
    );
    if (btn instanceof HTMLElement) {
      btn.click();
      return true;
    }
    return false;
  }, playerId);
}

export async function run(browser, { baseUrl }) {
  console.log(`Disarm scenario: 1 host + 2 clients at ${baseUrl}`);

  const { hostPage, clientPages } = await setupRoom(browser, {
    baseUrl,
    clientCount: 2,
    verboseClients: false,
  });

  // Open the Players panel.
  await hostPage.evaluate(() => {
    const el = document.querySelector('[data-slot="players-pill"]');
    if (el instanceof HTMLElement) el.click();
  });
  await delay(500);

  const tester01Id = await hostPage.evaluate(() => {
    const row = Array.from(document.querySelectorAll('[data-slot="player-row"]')).find(
      (el) => el.textContent?.includes('Tester01')
    );
    return row?.getAttribute('data-player-id') ?? null;
  });

  console.log('\n>>> First click on kick (arm) <<<');
  await clickKick(hostPage, tester01Id);
  await delay(300);
  const armedFirst = await armingState(hostPage, tester01Id);
  console.log('armed after first click:', armedFirst);

  // Wait past the 3 s auto-disarm window.
  console.log('\n>>> Waiting 4 s for auto-disarm <<<');
  await delay(4000);
  const armedAfterWait = await armingState(hostPage, tester01Id);
  console.log('armed after 4 s wait:', armedAfterWait);
  const autoDisarmed = armedAfterWait === 'false' || armedAfterWait === null;

  console.log('\n>>> Second click should re-arm (not fire) <<<');
  await clickKick(hostPage, tester01Id);
  await delay(300);
  const armedAfterRearm = await armingState(hostPage, tester01Id);
  console.log('armed after re-arm click:', armedAfterRearm);
  const reArmsNotConfirms = armedAfterRearm === 'true';

  // Most important: Tester01 should still be in the room — the click
  // did not fire the kick.
  await delay(1500);
  const t1Snap = await snap(clientPages[0].page, 'Tester01');
  const tester01Stays = t1Snap?.inRoom === true;

  printResult({ autoDisarmed, reArmsNotConfirms, tester01Stays });

  console.log('\nDone. Ctrl+C to exit.');
  await new Promise(() => {});
}
