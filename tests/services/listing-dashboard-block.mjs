// listing-service — home-shelf dashboard endpoints (`GET /listings/dashboard/{section}`)
// now exclude listings whose host is in the caller's block list (deployed
// 2026-08-01, same underlying filter as tests/services/listing-block.mjs's
// GET /listings coverage, applied to the dashboard shelves too).
//
// Response shape: `{ data: { items: [...], pagination: {...} } }` — NOT the
// flat `data: [...]` array that plain GET /listings uses. See dataOf() in
// lib/assert.mjs for the outer envelope unwrap; `.items` still needs to be
// pulled out manually here.
//
// Rather than seeding fixtures, this picks a REAL host already present in an
// authenticated read of the shelf (same "reuse real data" pattern as
// listing-block.mjs / community-feed-block.mjs), blocks them, and asserts
// the shelf no longer contains any of their listings. Covers two shelves
// (`free`, `top-rated`) since the filter is applied per-section in the
// backend and either could regress independently.
import { login, authHeaders } from '../lib/auth.mjs';
import { config } from '../lib/env.mjs';
import { fetchMeId } from '../lib/feed-helpers.mjs';

async function fetchShelfItems(tokens, section) {
  const res = await fetch(`${config.gwUrl}/listings/dashboard/${section}?limit=25`, {
    headers: authHeaders(tokens, 'full'),
  });
  if (res.status !== 200) return null;
  const body = await res.json().catch(() => ({}));
  const items = body.data?.items;
  return Array.isArray(items) ? items : null;
}

// Find a real host (id) present in the given shelf that isn't the caller.
async function pickOtherShelfHost(tokens, section, meId) {
  const items = await fetchShelfItems(tokens, section);
  if (!items) return null;
  for (const item of items) {
    const hostId = item.host?.id;
    if (hostId && hostId !== meId) return hostId;
  }
  return null;
}

function shelfCases(section, hostId) {
  return [
    {
      name: `POST /users/blocks (seed: block ${section} shelf host ${hostId})`,
      method: 'POST',
      path: '/users/blocks',
      body: { blocked_user_id: hostId },
      expect: 200,
    },
    {
      name: `GET /listings/dashboard/${section} excludes blocked host ${hostId}`,
      path: `/listings/dashboard/${section}?limit=25`,
      expect: 200,
      check: (json) => {
        const items = json.data?.items ?? [];
        const leaked = items.filter((l) => l.host?.id === hostId);
        return leaked.length
          ? `${section} shelf still contains ${leaked.length} item(s) from blocked host ${hostId}: ${JSON.stringify(
              leaked.map((l) => l.id)
            )}`
          : null;
      },
    },
    {
      name: `DELETE /users/blocks/${hostId} (cleanup: unblock)`,
      method: 'DELETE',
      path: `/users/blocks/${hostId}`,
      expect: 200,
    },
    {
      name: `GET /listings/dashboard/${section} shows host ${hostId} again after unblock`,
      path: `/listings/dashboard/${section}?limit=25`,
      expect: 200,
      check: (json) => {
        const items = json.data?.items ?? [];
        const present = items.some((l) => l.host?.id === hostId);
        return present ? null : `expected host ${hostId}'s listing(s) to reappear in ${section} shelf after unblock, found none`;
      },
    },
  ];
}

async function buildCases() {
  const tokens = await login();
  const meId = await fetchMeId(tokens);
  const cases = [];

  for (const section of ['free', 'top-rated']) {
    const hostId = meId ? await pickOtherShelfHost(tokens, section, meId) : null;
    if (!hostId) {
      cases.push({
        name: `GET /listings/dashboard/${section} (authed) — read-only sanity, no other host found for a block-filter test`,
        path: `/listings/dashboard/${section}?limit=10`,
        expect: 200,
        check: (json) => (Array.isArray(json.data?.items) ? null : 'expected data.items to be an array'),
      });
      continue;
    }
    cases.push(...shelfCases(section, hostId));
  }

  return cases;
}

export default {
  name: 'listing-service (dashboard shelves exclude blocked hosts)',
  cases: await buildCases(),
};
