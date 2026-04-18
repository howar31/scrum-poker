// settings mode — theme, language, animations toggles + persistence.
// All live on the header menu which only renders while in a room, so
// we create one first.
import {
  clickSlot,
  delay,
  printResult,
  readStoreState,
  readThemeClass,
  setupRoom,
  waitForRoomRender,
} from '../helpers.js';

async function openMenu(page) {
  await clickSlot(page, 'menu-trigger');
  await delay(200);
}

export async function run(browser, { baseUrl }) {
  console.log(`Settings scenario at ${baseUrl}`);

  const { hostPage } = await setupRoom(browser, {
    baseUrl,
    clientCount: 0,
    verboseClients: false,
    settleMs: 500,
  });

  // Theme default is 'dark' (from the store partialize / zustand persist).
  const themeBefore = await readThemeClass(hostPage);
  console.log('theme before:', themeBefore);

  await openMenu(hostPage);
  await clickSlot(hostPage, 'menu-theme');
  await delay(300);
  const themeAfter = await readThemeClass(hostPage);
  console.log('theme after:', themeAfter);
  const themeFlips = themeBefore !== themeAfter;

  // Persistence: reload, theme should survive.
  hostPage.on('dialog', (d) => d.accept().catch(() => {}));
  await hostPage.reload({ waitUntil: 'domcontentloaded' });
  // After reload we're back at Home because roomId isn't persisted, but
  // the theme class is rendered globally by App regardless.
  await delay(1000);
  const themeAfterReload = await readThemeClass(hostPage);
  console.log('theme after reload:', themeAfterReload);
  const themePersists = themeAfterReload === themeAfter;

  // Language toggle: open menu, read label, click, re-open if needed,
  // read again. `toggleLanguage` doesn't close the menu but puppeteer
  // outside-click detection can; poll to re-open if we have to.
  async function readLangLabel() {
    const open = await hostPage.$('[data-slot="menu-language"]');
    if (!open) {
      await openMenu(hostPage);
    }
    const el = await hostPage.$('[data-slot="menu-language"]');
    if (!el) return null;
    return el.evaluate((e) => e.innerText);
  }

  await openMenu(hostPage);
  const langBefore = await readLangLabel();
  console.log('language menu before:', JSON.stringify(langBefore));
  await clickSlot(hostPage, 'menu-language');
  await delay(400);
  const langAfter = await readLangLabel();
  console.log('language menu after:', JSON.stringify(langAfter));
  const languageFlips = !!langBefore && !!langAfter && langBefore !== langAfter;

  // Animations toggle: check store state.
  const beforeAnim = await readStoreState(hostPage);
  // Ensure menu is open before clicking — menu-language toggle above
  // may have closed it via outside-click handlers.
  const menuOpen = await hostPage.$('[data-slot="menu-animations"]');
  if (!menuOpen) await openMenu(hostPage);
  const clickedAnim = await clickSlot(hostPage, 'menu-animations');
  console.log('menu-animations click:', clickedAnim);
  await delay(500);
  const afterAnim = await readStoreState(hostPage);
  const animationsToggle = beforeAnim?.animationsEnabled !== afterAnim?.animationsEnabled;
  console.log(
    `animations ${beforeAnim?.animationsEnabled} → ${afterAnim?.animationsEnabled}`
  );

  printResult({ themeFlips, themePersists, languageFlips, animationsToggle });
  // Restore state so sequential test runs don't inherit dark/light/lang swaps.
  // (Best-effort; subsequent modes are in isolated browser contexts anyway.)
  void waitForRoomRender;

  console.log('\nDone. Ctrl+C to exit.');
  await new Promise(() => {});
}
