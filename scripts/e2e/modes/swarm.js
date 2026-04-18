// swarm mode — spawn N clients into an existing --room, each votes
// randomly. Load test / manual observation helper. No Result: line.
import { delay, spawnSwarmClient } from '../helpers.js';

export async function run(browser, { baseUrl, roomArg, count, verboseCount, staggerMs, voteProbability }) {
  if (!roomArg) {
    console.error('Error: --room is required for swarm mode');
    process.exit(1);
  }
  const joinUrl = `${baseUrl}/?room=${roomArg}`;
  const verboseMsg = verboseCount > 0 ? ` (${verboseCount} verbose)` : '';
  console.log(`Spawning ${count} clients${verboseMsg} at ${joinUrl}`);

  for (let i = 0; i < count; i++) {
    const name = `Tester${String(i + 1).padStart(2, '0')}`;
    spawnSwarmClient(browser, name, joinUrl, {
      verbose: i < verboseCount,
      autoVote: true,
      voteProbability,
    });
    if (i < count - 1) await delay(staggerMs);
  }

  console.log(`\nAll ${count} clients spawned. Votes trickle in over the next few seconds.`);
  console.log('Ctrl+C to exit.');
  await new Promise(() => {});
}
