// vote mode — full vote → reveal → reset cycle. Asserts the Statistics
// panel renders the correct average / min / max (☕ and ? excluded) and
// that reset clears every card.
import {
  delay,
  pickCard,
  printResult,
  readStatistics,
  readStoreState,
  resetCards,
  revealCards,
  setupRoom,
} from '../helpers.js';

export async function run(browser, { baseUrl }) {
  console.log(`Vote scenario: 1 host + 3 clients at ${baseUrl}`);

  const { hostPage, clientPages } = await setupRoom(browser, {
    baseUrl,
    clientCount: 3,
    verboseClients: false,
  });

  const [t1, t2, t3] = clientPages;
  console.log('\n>>> Casting votes: Tester01=3, Tester02=5, Tester03=☕ <<<');
  await pickCard(t1.page, '3');
  await pickCard(t2.page, '5');
  await pickCard(t3.page, '☕');

  // Let STATE_UPDATE broadcasts settle on the host.
  await delay(1500);

  const preRevealState = await readStoreState(hostPage);
  const votesRecorded =
    preRevealState &&
    preRevealState.players.filter((p) => p.card !== null).length === 3 &&
    preRevealState.players.find((p) => p.name === 'Tester01')?.card === '3' &&
    preRevealState.players.find((p) => p.name === 'Tester02')?.card === '5' &&
    preRevealState.players.find((p) => p.name === 'Tester03')?.card === '☕';

  console.log('\n>>> Host revealing <<<');
  await revealCards(hostPage);
  await delay(2000);

  const stats = await readStatistics(hostPage);
  console.log('Stats:', JSON.stringify(stats));
  // 3 and 5 are numeric, ☕ is excluded. Average = (3+5)/2 = 4.
  const statsCorrect =
    stats.average === 4 &&
    stats.min === 3 &&
    stats.max === 5 &&
    stats.distribution['3'] === 1 &&
    stats.distribution['5'] === 1 &&
    stats.distribution['☕'] === 1;

  console.log('\n>>> Host resetting <<<');
  await resetCards(hostPage);
  await delay(1500);

  const postResetState = await readStoreState(hostPage);
  const resetClears =
    postResetState &&
    !postResetState.isRevealed &&
    postResetState.players.every((p) => p.card === null);

  printResult({ votesRecorded, statsCorrect, resetClears });

  console.log('\nDone. Ctrl+C to exit.');
  await new Promise(() => {});
}
