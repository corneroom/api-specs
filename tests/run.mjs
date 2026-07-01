import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runSuites } from './lib/runner.mjs';

// Auto-discover every suite in services/. To add coverage, drop a new
// services/<name>.mjs that `export default { name, cases: [...] }` — no wiring.
const here = dirname(fileURLToPath(import.meta.url));
const servicesDir = join(here, 'services');

const suites = [];
for (const f of readdirSync(servicesDir).filter((f) => f.endsWith('.mjs')).sort()) {
  const mod = await import(join(servicesDir, f));
  if (mod.default?.cases) suites.push(mod.default);
}

const failures = await runSuites(suites);
process.exit(failures === 0 ? 0 : 1);
