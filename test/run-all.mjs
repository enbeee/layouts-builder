// Runs every verify-*.mjs integration test against a running server.
// Tests that lack prerequisites (server down, OBS unreachable) SKIP cleanly,
// so `npm test` is meaningful on any machine.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const tests = readdirSync(ROOT).filter((f) => /^verify-.*\.mjs$/.test(f)).sort();

let failed = 0;
for (const t of tests) {
  console.log(`\n--- ${t} ---`);
  const r = spawnSync(process.execPath, [path.join(ROOT, t)], { stdio: 'inherit', timeout: 60000 });
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n${failed} test(s) FAILED` : `\nall ${tests.length} test(s) passed or skipped`);
process.exit(failed ? 1 : 0);
