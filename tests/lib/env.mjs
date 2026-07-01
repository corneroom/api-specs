import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '.env');

// Minimal .env loader (no dependency). Existing process.env wins, so CI can
// inject creds without a file.
function loadDotEnv() {
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadDotEnv();

export const config = {
  gwUrl: process.env.GW_URL || 'https://app-staging-gateway-cissa23j.uc.gateway.dev/api/v1',
  email: process.env.TEST_EMAIL || '',
  password: process.env.TEST_PASSWORD || '',
};

export function requireCreds() {
  if (!config.email || !config.password) {
    console.error(
      '\n❌ Missing TEST_EMAIL / TEST_PASSWORD.\n' +
        '   Copy tests/.env.example → tests/.env and fill in a STAGING test account\n' +
        '   (or export the vars in your shell / CI).\n'
    );
    process.exit(2);
  }
}
