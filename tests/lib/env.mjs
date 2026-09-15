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
  // SECOND account — a seeded bot HOST that owns bookable staging listings.
  // The suite's primary account hosts nothing (`has_listing:false`), so every
  // host-side transition (accept / reject / luggage check-in) used to be
  // undrivable. See services/booking-host-flow.mjs.
  hostEmail: process.env.TEST_HOST_EMAIL || '',
  hostPassword: process.env.TEST_HOST_PASSWORD || '',
};

// The ONE host the irreversible dispute flows are allowed to drive.
//
// An ALLOW-LIST, not a deny-list of production-looking substrings: a deny-list
// is a guess about what production will be called, and it fails open for
// anything it did not think of (a new custom domain, an IP, a tunnel). These
// flows cancel and complete real bookings and close real disputes, so the only
// safe rule is "this exact staging gateway or nothing".
export const STAGING_GATEWAY_HOST = 'app-staging-gateway-cissa23j.uc.gateway.dev';

export function assertStagingGateway(what) {
  let host;
  try {
    host = new URL(config.gwUrl).host;
  } catch {
    throw new Error(`REFUSING TO RUN ${what}: GW_URL is not a valid URL (${config.gwUrl})`);
  }
  if (host !== STAGING_GATEWAY_HOST) {
    throw new Error(
      `REFUSING TO RUN ${what}: GW_URL host is '${host}', and this flow may only ever run against the staging ` +
        `gateway ('${STAGING_GATEWAY_HOST}'). It cancels and completes real bookings and closes real disputes.`
    );
  }
}

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

// Host creds are needed by ONE flow, not by the whole run, so this THROWS
// rather than exiting the process: a run without them should fail that flow's
// cases loudly and still execute everything else (and, crucially, still run
// the other flows' cleanup cases).
export function requireHostCreds() {
  if (!config.hostEmail || !config.hostPassword) {
    throw new Error(
      'Missing TEST_HOST_EMAIL / TEST_HOST_PASSWORD — the host-side flow needs a seeded bot HOST account ' +
        '(see tests/.env.example and tests/README.md). In CI these come from the GATEWAY_TEST_HOST_EMAIL / ' +
        'GATEWAY_TEST_HOST_PASSWORD repo secrets.'
    );
  }
}
