// all mode — CI wrapper. Spawns every assertion mode as a child
// process in sequence, captures stdout, parses the final `Result:` line,
// prints a summary table, and exits 0 iff every sub-mode passed.
//
// Because every sub-mode follows the uniform `Result: key=value ...`
// convention (printed by printResult in helpers.js), aggregation is
// just a regex.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const E2E_ENTRY = join(__dirname, '../../e2e.js');

// Ordered list of modes run by `all`. Excluded on purpose: host,
// swarm, observe (no assertions) and transfer-mode aliases (covered
// by the explicit sibling modes).
const MODES = [
  { name: 'check', args: (count) => ['--count', String(count)] },
  { name: 'vote', args: () => [] },
  { name: 'refresh', args: () => [] },
  { name: 'transfer', args: (count) => ['--count', String(count)] },
  { name: 'state-persist', args: () => [] },
  { name: 'crash', args: (count) => ['--count', String(count)] },
  { name: 'kick', args: (count) => ['--count', String(count)] },
  { name: 'kick-window', args: () => [] },
  { name: 'late-joiner', args: () => [] },
  { name: 'deadman', args: () => [] },
  { name: 'disarm', args: () => [] },
  { name: 'join-ux', args: () => [] },
  { name: 'settings', args: () => [] },
  { name: 'copy-toast', args: () => [] },
  { name: 'solo-leave', args: () => [] },
  { name: 'panel-ux', args: () => [] },
];

// `check` mode calls process.exit itself. Every other mode hangs
// waiting for SIGINT after printing Result. We kill them as soon as
// we see the Result line on stdout (plus a short grace).
const HANGS_AFTER_RESULT = new Set(MODES.map((m) => m.name));
HANGS_AFTER_RESULT.delete('check');

function runMode({ name, args }, { baseUrl, count, headless }) {
  return new Promise((resolve) => {
    const start = Date.now();
    const forwarded = [
      '--mode', name,
      '--url', baseUrl,
      '--headless', String(headless),
      ...args(count),
    ];
    const child = spawn(process.execPath, [E2E_ENTRY, ...forwarded], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let resultLine = null;
    let out = '';
    let err = '';
    let killed = false;

    const killAfterResult = () => {
      if (killed) return;
      killed = true;
      // Short grace so the child can flush final lines before SIGTERM.
      setTimeout(() => child.kill('SIGTERM'), 200);
    };

    child.stdout.on('data', (buf) => {
      const text = buf.toString();
      out += text;
      // Capture the LAST Result line we see (later modes might emit
      // multiple if they retry, but printResult only writes one per run).
      const match = text.match(/Result:\s+(.+)/);
      if (match) {
        resultLine = match[1].trim();
        if (HANGS_AFTER_RESULT.has(name)) {
          killAfterResult();
        }
      }
    });
    child.stderr.on('data', (buf) => {
      err += buf.toString();
    });

    child.on('exit', (code) => {
      const durationMs = Date.now() - start;
      // Parse the result line into { key: boolean|number }. Any
      // key=true counts as passing for its field; a key=false anywhere
      // fails the mode. For modes like `check` that don't emit a
      // Result line but use the exit code, treat code 0 as pass.
      let pass = false;
      let summary = resultLine;
      if (resultLine) {
        pass = !/=false\b/.test(resultLine);
      } else if (name === 'check') {
        pass = code === 0;
        summary = `exit=${code}`;
      } else {
        pass = false;
        summary = '(no Result line, no exit code) tail=' +
          (out.slice(-200).replace(/\s+/g, ' ') || err.slice(-200));
      }
      resolve({ name, pass, summary, durationMs });
    });
  });
}

export async function run({ baseUrl, count, headless }) {
  const clientCount = count || 3;
  console.log(`Running e2e:all against ${baseUrl} (headless=${headless}, count=${clientCount})\n`);

  const results = [];
  for (const mode of MODES) {
    process.stdout.write(`→ ${mode.name.padEnd(14)} `);
    const res = await runMode(mode, { baseUrl, count: clientCount, headless });
    results.push(res);
    const marker = res.pass ? '✅' : '❌';
    const sec = (res.durationMs / 1000).toFixed(1);
    console.log(`${marker} (${sec}s)  ${res.summary ?? ''}`);
  }

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log(`\n${passed}/${total} modes passed`);
  if (passed < total) {
    console.log('\nFailures:');
    for (const r of results.filter((r) => !r.pass)) {
      console.log(`  ${r.name}: ${r.summary}`);
    }
  }
  process.exit(passed === total ? 0 : 1);
}
