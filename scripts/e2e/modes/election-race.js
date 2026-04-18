// election-race mode — two clients concurrently lose the host
// connection (host page force-closed). Under the broker-arbitration
// design, when multiple clients simultaneously race to open the
// well-known ID, the broker gives it to exactly one and returns
// `unavailable-id` to the other(s). The losers must transition to
// FOLLOWING and connect to the winner.
//
// Passes iff: exactly one client ends up HOSTING, every other client
// ends up FOLLOWING the same host, no page thinks it's a solo host.
import {
  delay,
  printResult,
  readStoreState,
  setupRoom,
  snap,
  snapAll,
} from '../helpers.js';

export async function run(browser, { baseUrl }) {
  console.log(`Election-race scenario: 1 host + 4 clients at ${baseUrl}`);

  const { hostPage, clientPages } = await setupRoom(browser, {
    baseUrl,
    clientCount: 4,
    verboseClients: false,
  });

  // Force-close the host page (no graceful leave — no HOST_LEAVING sent).
  // Every client's watchdog will fire around T+8 s simultaneously. Two or
  // more of them will think they're rank 0 (because they all read slightly
  // different player maps) and race to open the well-known ID. Broker
  // arbitration must produce exactly one winner.
  console.log('\n>>> Killing host page abruptly <<<');
  await hostPage.close();

  // Budget: watchdog ~8 s + broker alive_timeout up to ~60 s + ELECTING
  // retries. Give 70 s.
  console.log('\nWaiting 70 s for election to settle...');
  await delay(70000);

  const snaps = await snapAll(clientPages);
  const states = [];
  for (const c of clientPages) {
    states.push({ name: c.name, state: await readStoreState(c.page) });
  }

  // Exactly one client should have hostId === their own playerId AND be
  // in the room. Everyone else should have hostId === winner's playerId.
  let winnerId = null;
  let winnerCount = 0;
  if (states.every((s) => s.state)) {
    const hosts = states.filter((s) => s.state.hostId === s.state.playerId);
    winnerCount = hosts.length;
    if (hosts.length === 1) winnerId = hosts[0].state.playerId;
  }

  const exactlyOneHost = winnerCount === 1;
  const everyoneAgrees =
    !!winnerId && states.every((s) => s.state?.hostId === winnerId);
  const allInRoom = snaps.every((c) => c.snap?.inRoom);
  const expectedCount = clientPages.length;
  // After ghost cleanup (20 s one-shot on new host), the dead host is
  // swept; so playerCount drops to clientPages.length.
  const playerCountMatches = snaps.every(
    (c) => String(c.snap?.playerCount) === String(expectedCount)
  );

  if (states.every((s) => s.state)) {
    console.log(
      `winner=${winnerId?.slice(0, 6) ?? '(none)'} hostCount=${winnerCount} | ` +
        states.map((s) => `${s.name}=${s.state.hostId?.slice(0, 6)}`).join(' ')
    );
  }

  printResult({
    exactlyOneHost,
    everyoneAgrees: states.every((s) => s.state) ? everyoneAgrees : true,
    allInRoom,
    playerCountMatches,
    expected: expectedCount,
  });

  console.log('\nDone. Ctrl+C to exit.');
  await new Promise(() => {});
}
