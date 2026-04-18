#!/usr/bin/env node
/**
 * End-to-end browser automation for Scrum Poker, driven by Puppeteer.
 *
 * Thin entry point: parses CLI flags and dispatches to a mode module
 * under scripts/e2e/modes/. Each mode is a small self-contained file.
 * Shared primitives (setupRoom, snap, pickCard, etc.) live in
 * scripts/e2e/helpers.js.
 *
 * Run `--help` for the full flag list.
 */
import { parseArgs } from 'node:util';
import { launchBrowser } from './e2e/helpers.js';

const HELP_TEXT = `
Scrum Poker E2E driver

Usage:
  node scripts/e2e.js --mode <mode> [flags]
  (or: npm run e2e:<mode> -- [flags])

Prerequisites:
  Either run 'npm run dev' (or 'VITE_E2E=1 npm run dev' to enable the
  test-only window.__POKER_STATE__ hook that some modes require), or
  pass --url pointing at a deployed build.

Assertion modes (scenarios that print a final 'Result:' line):
  check         npm run e2e:check         [EXITS 0/1]
                Host + N clients join, assert every TesterNN is visible.
                The only mode with a real exit code.

  vote          npm run e2e:vote          [SIGINT]
                Host + 3 clients pick 3/5/☕, host reveals. Asserts
                Statistics panel shows average=4 min=3 max=5 and
                distribution includes ☕. Then host resets and asserts
                every card is back to unselected.

  refresh       npm run e2e:refresh       [SIGINT]
                Client reloads mid-session. Asserts playerId persists
                (same room, same player count, vote preserved).

  state-persist npm run e2e:state         [SIGINT]
                Everyone votes, host reveals, host transfers to
                Tester01. Asserts votes + isRevealed survive the
                migration.

  transfer      npm run e2e:transfer      [SIGINT]
                Bot-driven graceful host transfer. Exercises
                HOST_LEAVING + ACK + direct-connect + reclaim.
                Asserts: allInRoom=true playerCountMatches=true.

  crash         npm run e2e:crash         [SIGINT]
                Host page is abruptly closed (no HOST_LEAVING).
                Exercises heartbeat → probe → handleHostDisconnect →
                self-promote. Asserts survivors reunite.

  kick          npm run e2e:kick          [SIGINT]
                Host kicks Tester01. Asserts they end up on Home, not
                auto-rejoined; survivors still in room.

  kick-window   npm run e2e:kick-window   [SIGINT]
                Asserts the 5 s kicked-ID reject window blocks auto-
                reconnect but lets a manual re-join through afterwards.

  late-joiner   npm run e2e:late-joiner   [SIGINT]
                Spawns a fresh client while a host transfer is
                in-flight. Asserts they eventually land in the room.

  deadman       npm run e2e:deadman       [SIGINT]
                Transfer to a non-oldest client, then kill that client
                before it can selfPromote. Asserts the rank-0 fallback
                (the original host) recovers the room.

  disarm        npm run e2e:disarm        [SIGINT]
                Arms kick on Tester01, waits > 3 s, asserts next click
                re-arms instead of firing (auto-disarm works).

  join-ux       npm run e2e:join-ux       [SIGINT]
                Home URL routing, roomId normalization, cancel button,
                30 s long-wait banner.

  settings      npm run e2e:settings      [SIGINT]
                Theme / language / animations toggles + persistence.

  copy-toast    npm run e2e:copy-toast    [SIGINT]
                Copy room ID + invite link surface toasts; toasts
                auto-dismiss after 3.5 s.

  solo-leave    npm run e2e:solo-leave    [SIGINT]
                Solo host leaves via menu; asserts back on Home,
                ?room= stripped.

  panel-ux      npm run e2e:panel-ux      [SIGINT]
                Players panel backdrop / Escape / X close behaviors.

  all           npm run e2e:all           [EXITS 0/1]
                Runs every assertion mode above sequentially as child
                processes, parses each Result: line, exits 0 iff
                every sub-mode passes.

Interactive / diagnostic modes (no final Result: line):
  host          npm run e2e:host          [no exit]   Create room, stay alive.
  swarm         npm run e2e:swarm         [no exit]   N random-voting clients.
  observe       npm run e2e:observe       [no exit]   Single client + console forwarding.

Flags:
  --url <url>                   Base app URL (default: http://localhost:5173)
  --room <id>                   Room ID (required for swarm / observe)
  --count <n>                   Number of clients (default: 10; modes may default lower)
  --verbose <n>                 Forward full browser console for first N swarm clients (default: 0)
  --vote-probability <0..1>     Swarm: chance each client votes (default: 0.7)
  --stagger <ms>                Swarm: delay between spawns (default: 2500)
  --duration <sec>              Exit after N seconds (host mode; default: stay alive)
  --headless <true|false>       Run browsers headless (default: true)
  --name <name>                 Override the auto-generated display name
  --help                        Show this message

Interpreting results:
  Only 'check' and 'all' set an exit code. For the other assertion
  modes, grep the stdout for a passing Result: line, e.g.:
    npm run e2e:transfer -- --count 3 2>&1 | tee out.log
    grep -q 'allInRoom=true playerCountMatches=true' out.log && echo OK

Examples:
  npm run e2e:all                                          # run the whole suite
  npm run e2e:check -- --count 5                           # CI smoke test
  npm run e2e:vote                                         # voting flow
  npm run e2e:transfer -- --count 3                        # host migration
  npm run e2e:swarm -- --room ABC1234 --count 10 --verbose 2   # load test
  npm run e2e:host -- --url https://lab.howar31.com/scrum-poker --duration 60
`;

// ---- CLI parsing ------------------------------------------------------

const parsed = parseArgs({
  strict: false,
  options: {
    mode: { type: 'string' },
    url: { type: 'string', default: 'http://localhost:5173' },
    room: { type: 'string' },
    count: { type: 'string', default: '10' },
    verbose: { type: 'string', default: '0' },
    'vote-probability': { type: 'string', default: '0.7' },
    stagger: { type: 'string', default: '2500' },
    duration: { type: 'string' },
    headless: { type: 'string', default: 'true' },
    name: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (parsed.values.help) {
  console.log(HELP_TEXT);
  process.exit(0);
}

const ALL_MODES = [
  'host',
  'swarm',
  'e2e', // back-compat alias for 'check'
  'check',
  'observe',
  'transfer',
  'crash',
  'kick',
  'vote',
  'refresh',
  'kick-window',
  'late-joiner',
  'deadman',
  'state-persist',
  'disarm',
  'join-ux',
  'settings',
  'copy-toast',
  'solo-leave',
  'panel-ux',
  'all',
];

const mode = parsed.values.mode;
if (!mode || !ALL_MODES.includes(mode)) {
  console.error('Error: missing or invalid --mode. Run with --help for options.');
  process.exit(1);
}

const config = {
  baseUrl: (parsed.values.url ?? '').replace(/\/$/, ''),
  roomArg: parsed.values.room,
  count: parseInt(parsed.values.count, 10),
  verboseCount: parseInt(parsed.values.verbose, 10),
  voteProbability: parseFloat(parsed.values['vote-probability']),
  staggerMs: parseInt(parsed.values.stagger, 10),
  durationSec: parsed.values.duration ? parseInt(parsed.values.duration, 10) : null,
  headless: parsed.values.headless !== 'false',
  nameOverride: parsed.values.name,
};

// ---- Dispatch ---------------------------------------------------------

const MODE_TO_MODULE = {
  host: './e2e/modes/host.js',
  swarm: './e2e/modes/swarm.js',
  e2e: './e2e/modes/check.js',
  check: './e2e/modes/check.js',
  observe: './e2e/modes/observe.js',
  transfer: './e2e/modes/transfer.js',
  crash: './e2e/modes/crash.js',
  kick: './e2e/modes/kick.js',
  vote: './e2e/modes/vote.js',
  refresh: './e2e/modes/refresh.js',
  'kick-window': './e2e/modes/kick-window.js',
  'late-joiner': './e2e/modes/late-joiner.js',
  deadman: './e2e/modes/deadman.js',
  'state-persist': './e2e/modes/state-persist.js',
  disarm: './e2e/modes/disarm.js',
  'join-ux': './e2e/modes/join-ux.js',
  settings: './e2e/modes/settings.js',
  'copy-toast': './e2e/modes/copy-toast.js',
  'solo-leave': './e2e/modes/solo-leave.js',
  'panel-ux': './e2e/modes/panel-ux.js',
  all: './e2e/modes/all.js',
};

async function main() {
  // 'all' mode spawns sub-processes and doesn't need its own browser.
  if (mode === 'all') {
    const { run } = await import(MODE_TO_MODULE[mode]);
    await run(config);
    return;
  }

  const browser = await launchBrowser({ headless: config.headless });
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await browser.close().catch(() => {});
    process.exit(0);
  });

  try {
    const { run } = await import(MODE_TO_MODULE[mode]);
    await run(browser, config);
  } finally {
    // Modes that exit early (check) reach here; SIGINT-waiting modes
    // (everything else) don't.
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
