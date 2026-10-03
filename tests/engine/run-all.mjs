// Runs the whole engine test suite:  node tests/engine/run-all.mjs
// (Node >= 21 treats `node --test <directory>` as a file name, so this lists the test files explicitly.)
// The speed-test unit tests (tests/speedtest/*.test.mjs, pure maths + a simulated network) run here too, so CI and
// `npm test` cover them without another command.
import { readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const list = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => path.join(dir, f)) : []);
const files = [...list(here), ...list(path.join(here, '..', 'speedtest'))];
const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
