// Environment-agnostic, READ-ONLY smoke suite.
//
// Answers one question for one environment: "is this gateway wired up, serving,
// and not leaking what we already fixed?" It takes NO credentials and performs
// NO writes, so it is safe to point at production.
//
//   node tests/smoke.mjs staging
//   node tests/smoke.mjs prod
//   GW_URL=https://.../api/v1 PUBLIC_BUCKET=... node tests/smoke.mjs
//
// Nothing here is hardcoded to a fixture: every id it needs is discovered from
// the environment it is pointed at. A check whose data does not exist in that
// environment SKIPs (visibly) rather than failing — prod legitimately has no
// experiences yet, and that is not a regression.
//
// The authenticated suite (run.mjs) stays STAGING-ONLY: it blocks users and
// writes wishlists, which we do not do against the live marketplace.

const ENVS = {
  staging: {
    gwUrl: 'https://app-staging-gateway-cissa23j.uc.gateway.dev/api/v1',
    buckets: ['corneroom-82fbb-public', 'corneroom-82fbb-community-media'],
  },
  prod: {
    // The custom domain is what real clients use, so that is what we verify.
    gwUrl: 'https://api.corneroom.com/api/v1',
    buckets: ['corneroom-prod-504810-public', 'corneroom-prod-504810-community-media'],
  },
};

const envName = process.argv[2];
const preset = ENVS[envName];
// A known env name OR an explicit GW_URL is enough; requiring both would break
// the documented GW_URL-only form (and any ad-hoc target).
if (!preset && !process.env.GW_URL) {
  console.error(`
Usage: node tests/smoke.mjs <staging|prod>
   or: GW_URL=<base> PUBLIC_BUCKET=<bucket>[,<bucket>] node tests/smoke.mjs

Read-only. No credentials. Safe against production.
`);
  process.exit(2);
}

const gwUrl = (process.env.GW_URL || preset.gwUrl).replace(/\/$/, '');
const buckets = process.env.PUBLIC_BUCKET
  ? process.env.PUBLIC_BUCKET.split(',').map((b) => b.trim()).filter(Boolean)
  : preset?.buckets ?? [];

let pass = 0, fail = 0, skip = 0;
const ok   = (n, d) => { pass++; console.log(`  ✓ ${n}${d ? `  [${d}]` : ''}`); };
const bad  = (n, w) => { fail++; console.log(`  ✗ ${n}  — ${w}`); };
const skipd= (n, w) => { skip++; console.log(`  ⏭ ${n}  — ${w}`); };

async function get(url, opts = {}) {
  try {
    const res = await fetch(url, { ...opts, headers: { 'User-Agent': 'corneroom-smoke', ...(opts.headers || {}) } });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON is a valid result to assert on */ }
    return { status: res.status, json, text };
  } catch (e) {
    return { status: 0, json: null, text: String(e.message) };
  }
}

// Responses are inconsistently shaped across services ({data:[]}, {feed:[]},
// {data:{experiences:[]}}), so unwrap defensively rather than per-endpoint.
function listOf(json) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return null;
  for (const v of [json.data, json.feed, json.listings, json.data?.experiences]) {
    if (Array.isArray(v)) return v;
  }
  return null;
}

function deepFind(obj, predicate, path = '') {
  const hits = [];
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      const p = path ? `${path}.${k}` : k;
      if (predicate(k, v)) hits.push(p);
      hits.push(...deepFind(v, predicate, p));
    }
  }
  return hits;
}

console.log(`\nCorneroom gateway smoke — ${envName ?? 'custom'}`);
console.log(`Gateway: ${gwUrl}`);
console.log(`Buckets: ${buckets.join(', ') || '(none configured — storage checks skipped)'}`);

// ---------------------------------------------------------------- routing --
console.log('\nrouting & health');
for (const svc of ['users', 'listings', 'bookings', 'payments', 'reviews', 'rewards', 'wishlists', 'conversations', 'community', 'documents']) {
  const r = await get(`${gwUrl}/${svc}/heartbeat`);
  r.status === 200
    ? ok(`GET /${svc}/heartbeat`, r.status)
    : bad(`GET /${svc}/heartbeat`, `expected 200, got ${r.status}`);
}

// ------------------------------------------------------------ public reads --
console.log('\npublic surface (unauthenticated)');
const listings = await get(`${gwUrl}/listings?limit=10`);
const listingItems = listOf(listings.json);
if (listings.status !== 200 || !listingItems) {
  bad('GET /listings', `expected 200 + array, got ${listings.status}`);
} else {
  ok('GET /listings', `${listings.status}, ${listingItems.length} items`);
}

for (const [name, path] of [
  ['GET /community/public/feed', '/community/public/feed?limit=5'],
  ['GET /experiences/public', '/experiences/public?limit=5'],
]) {
  const r = await get(`${gwUrl}${path}`);
  const items = listOf(r.json);
  if (r.status !== 200) bad(name, `expected 200, got ${r.status}`);
  else if (!items) bad(name, 'response was not a recognisable list');
  else if (items.length === 0) skipd(name, 'endpoint healthy but empty in this environment');
  else ok(name, `${r.status}, ${items.length} items`);
}

// Host listings, using a host id discovered from the feed above.
const someHost = listingItems?.find((l) => l?.host?.id)?.host?.id;
if (!someHost) {
  skipd('GET /listings/host/{id}', 'no listing with a host id in this environment');
} else {
  const r = await get(`${gwUrl}/listings/host/${someHost}`);
  r.status === 200 ? ok('GET /listings/host/{id}', r.status)
                   : bad('GET /listings/host/{id}', `expected 200, got ${r.status}`);
}

// ------------------------------------------------------- auth is enforced --
console.log('\nprotected routes reject anonymous callers');
for (const [name, path] of [
  ['GET /users/me', '/users/me'],
  ['GET /bookings', '/bookings'],
  ['GET /wishlists', '/wishlists'],
  ['GET /payments/methods', '/payments/methods'],
]) {
  const r = await get(`${gwUrl}${path}`);
  r.status === 401 || r.status === 403
    ? ok(`${name} → ${r.status}`)
    : bad(name, `expected 401/403, got ${r.status}`);
}

// document-service — POST /documents/upload (chat-message attachment
// multipart upload, gateway-exposed). Routing/auth smoke check only: proves
// the route is registered and JWT-protected. The full authenticated
// upload/write path is make test-gateway's territory, not this suite's.
{
  const r = await get(`${gwUrl}/documents/upload`, { method: 'POST' });
  r.status === 401 || r.status === 403
    ? ok(`POST /documents/upload → ${r.status}`)
    : bad('POST /documents/upload', `expected 401/403, got ${r.status}`);
}

// The internal KYC-status write must never be reachable from the app gateway
// (it was an unauthenticated verification bypass). Mirrors services/security.mjs.
{
  const r = await get(`${gwUrl}/internal/users/smoke/verifications/facematch`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'approved' }),
  });
  r.status === 404
    ? ok('PATCH /internal/.../verifications is not exposed', r.status)
    : bad('PATCH /internal/.../verifications is not exposed', `expected 404, got ${r.status}`);
}

// ------------------------------------------------- privacy regression guards --
// These encode fixes that are invisible until they regress. See
// PRELAUNCH_CHECKLIST.md section 6.
console.log('\nprivacy regressions (see PRELAUNCH_CHECKLIST §6)');
if (!listingItems?.length) {
  skipd('public listing privacy', 'no listings in this environment');
} else {
  // v1.0.11 — a queued host edit carries street, postal code and the TRUE
  // coordinates; it must never ride along on the public feed.
  const revisions = deepFind(listings.json, (k) => k === 'pending_revision');
  revisions.length === 0
    ? ok('no pending_revision on the public feed')
    : bad('no pending_revision on the public feed', `found at: ${revisions.slice(0, 3).join(', ')}`);

  // The public feed exposes city/country only — never a street address.
  const addr = deepFind(listings.json, (k) => ['street', 'postal_code', 'unit_number', 'emergency_contact'].includes(k));
  addr.length === 0
    ? ok('no street address on the public feed')
    : bad('no street address on the public feed', `found at: ${addr.slice(0, 3).join(', ')}`);

  // v1.0.10 — coordinates are approximated, but must still be present or the
  // map has no pins. Exact-vs-approximate cannot be proven without the stored
  // value, so we assert the property we CAN prove from outside: the offset is
  // deterministic. A per-request random offset would be averaged away by a
  // caller polling this endpoint, and is the regression worth catching.
  const withCoords = listingItems.filter((l) => typeof l?.location?.latitude === 'number' && l.location.latitude !== 0);
  if (!withCoords.length) {
    skipd('coordinates present', 'no listing carries coordinates in this environment');
  } else {
    ok('coordinates present for map pins', `${withCoords.length}/${listingItems.length} listings`);
    const again = await get(`${gwUrl}/listings?limit=10`);
    const againItems = listOf(again.json) ?? [];
    const drifted = withCoords.filter((l) => {
      const m = againItems.find((x) => x.id === l.id);
      return m && (m.location.latitude !== l.location.latitude || m.location.longitude !== l.location.longitude);
    });
    drifted.length === 0
      ? ok('coordinate offset is deterministic across requests')
      : bad('coordinate offset is deterministic across requests', `${drifted.length} listing(s) moved between two calls — offset may be randomised per request`);
  }
}

// ------------------------------------------------------ storage exposure --
console.log('\npublic buckets serve objects but do not enumerate');
if (!buckets.length) {
  skipd('bucket enumeration', 'no buckets configured for this environment');
} else {
  for (const b of buckets) {
    const r = await get(`https://storage.googleapis.com/storage/v1/b/${b}/o?maxResults=1`);
    r.status === 401 || r.status === 403
      ? ok(`${b} rejects anonymous listing`, r.status)
      : bad(`${b} rejects anonymous listing`, `expected 401/403, got ${r.status} — objects are enumerable`);
  }
  // A known object URL must still serve, or we have broken every image.
  const thumb = listingItems?.map((l) => l?.thumbnail).find((t) => typeof t === 'string' && t.startsWith('https://storage.googleapis.com/'));
  if (!thumb) {
    skipd('public object is readable', 'no storage-hosted thumbnail found to sample');
  } else {
    const r = await get(thumb);
    r.status === 200
      ? ok('public object is readable by URL', r.status)
      : bad('public object is readable by URL', `expected 200, got ${r.status} — images are broken`);
  }
}

console.log(`\n${fail === 0 ? '✅' : '❌'} smoke: ${pass} passed, ${fail} failed, ${skip} skipped  (${gwUrl})`);
process.exit(fail === 0 ? 0 : 1);
