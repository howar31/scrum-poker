// state-persist mode — vote, reveal, then transfer host. Asserts that
// the votes and isRevealed flag survive the migration (the new host's
// first broadcast still contains the pre-migration state).
import {
  delay,
  pickCard,
  printResult,
  readStatistics,
  readStoreState,
  revealCards,
  setupRoom,
  transferToPlayer,
} from '../helpers.js';

export async function run(browser, { baseUrl }) {
  console.log(`State-persist scenario: 1 host + 2 clients at ${baseUrl}`);

  const { hostPage, clientPages } = await setupRoom(browser, {
    baseUrl,
    clientCount: 2,
    verboseClients: false,
  });

  const [t1, t2] = clientPages;
  console.log('\n>>> Everyone votes, host reveals <<<');
  await pickCard(t1.page, '5');
  await pickCard(t2.page, '3');
  await pickCard(hostPage, '8');
  await delay(1200);
  await revealCards(hostPage);
  await delay(2000);

  const preTransferStats = await readStatistics(hostPage);
  console.log('Pre-transfer stats:', JSON.stringify(preTransferStats));

  console.log('\n>>> Host transfers to Tester01 <<<');
  await transferToPlayer(hostPage, 'Tester01');
  console.log('Waiting 15 s for migration...');
  await delay(15000);

  // After migration, Tester01 is the new host. Read its store + stats.
  const newHostState = await readStoreState(t1.page);
  const postTransferStats = await readStatistics(t1.page);
  console.log('Post-transfer stats:', JSON.stringify(postTransferStats));

  const revealedPreserved = newHostState?.isRevealed === true;
  const votesPreserved =
    (newHostState?.players ?? []).filter((p) => p.card !== null).length === 3;
  const statsStable =
    preTransferStats.average === postTransferStats.average &&
    preTransferStats.min === postTransferStats.min &&
    preTransferStats.max === postTransferStats.max;

  printResult({ votesPreserved, revealedPreserved, statsStable });

  console.log('\nDone. Ctrl+C to exit.');
  await new Promise(() => {});
}
