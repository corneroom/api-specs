// listing-service — the guide directory behind Experiences (read-only).
//
// Experiences are guide-led, and `services/experience-reservations-flow.mjs`
// drives the money end to end, but the `/guides` surface itself — the
// directory a traveller browses and the profile a would-be guide reads back —
// had no coverage.
//
// ── WHY THIS FILE IS READ-ONLY, AND MUST STAY THAT WAY ─────────────────────
//
// `POST /guides` and `POST /guides/apply` are deliberately NOT exercised, and
// this is a warning, not a preference: **there is no way to delete a guide
// profile over the app gateway.** The routes are create, list, apply,
// get-mine, get-by-id and nothing else (listing-service
// internal/rest/experience_handler.go:85-91). Calling `apply` once, even with
// an empty body, permanently adds the calling account to the public guide
// directory — the apply path has no body validation, and for a
// facematch-verified account (which every seeded bot is) it lands
// `status:"approved"`, `verified:true` immediately by design
// (`ApplyGuide`, internal/service/experience.go:826-834). That is exactly
// what happened while this file was being written: an exploratory
// `POST /guides/apply {}` as the suite account created guide
// `yw6Z3BGtYUxhqJpV26Jl` — a blank, approved, verified guide profile for
// `TEST_EMAIL` — with no gateway call able to remove it. It has to be deleted
// straight from staging Firestore.
//
// So: if you extend this file, extend the READS. A write case here costs a
// permanent row in a public directory every six hours.
//
// Because of that residue, `GET /guides/me` is asserted as "either a profile
// that belongs to me, or a clean 404" — both are correct answers depending on
// whether the suite account currently holds a guide profile, and the test
// must not silently depend on which.
import { login, authHeaders } from '../lib/auth.mjs';
import { config } from '../lib/env.mjs';
import { fetchMeId } from '../lib/feed-helpers.mjs';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function gw(tokens, path) {
  const res = await fetch(`${config.gwUrl}${path}`, { headers: authHeaders(tokens, 'full') });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, data: json?.data, text };
}

export default {
  name: 'listing-service (guide directory — read-only, see the header before adding a write)',
  cases: [
    {
      name: 'GET /guides — the directory lists guides with the fields the browse screen needs',
      run: async () => {
        const tokens = await login();
        const res = await gw(tokens, '/guides?limit=5');
        assert(res.status === 200, `GET /guides expected 200, got ${res.status}: ${res.text}`);
        const guides = res.data?.guides ?? res.data ?? [];
        assert(Array.isArray(guides), `GET /guides must return a guides array, got: ${res.text}`);

        // Skip visibly rather than fail if staging has no guides — the same
        // rule the smoke suite follows for environments without the data.
        if (guides.length === 0) {
          console.log('    ⏭ no guides in this environment — directory endpoint healthy but empty');
          return;
        }
        for (const g of guides) {
          assert(g.id, `a guide row has no id: ${JSON.stringify(g)}`);
          assert(g.user_id, `guide ${g.id} has no user_id — the profile link would be dead`);
          assert('status' in g, `guide ${g.id} has no status`);
        }
      },
    },

    {
      name: 'GET /guides/{id} — a guide in the directory is readable by id, and an unknown id 404s',
      run: async () => {
        const tokens = await login();
        const list = await gw(tokens, '/guides?limit=5');
        const guides = list.data?.guides ?? list.data ?? [];

        if (guides.length > 0) {
          const first = guides[0];
          const one = await gw(tokens, `/guides/${first.id}`);
          assert(one.status === 200, `GET /guides/{id} expected 200 for a listed guide, got ${one.status}: ${one.text}`);
          const g = one.data?.guide ?? one.data;
          assert(g?.id === first.id, `GET /guides/{id} returned a different guide: ${g?.id} vs ${first.id}`);
        } else {
          console.log('    ⏭ no guides in this environment — skipping the by-id read');
        }

        const missing = await gw(tokens, '/guides/gateway-suite-no-such-guide');
        assert(missing.status === 404, `an unknown guide id must 404, got ${missing.status}: ${missing.text}`);
      },
    },

    {
      name: 'GET /guides/me — either my own guide profile or a clean 404, never somebody else\'s',
      run: async () => {
        const tokens = await login();
        const meId = await fetchMeId(tokens);
        const res = await gw(tokens, '/guides/me');
        assert([200, 404].includes(res.status), `GET /guides/me must be 200 or 404, got ${res.status}: ${res.text}`);
        if (res.status === 200) {
          const g = res.data?.guide ?? res.data;
          assert(g?.user_id === meId, `GET /guides/me returned a profile belonging to ${g?.user_id}, not ${meId}`);
        }
      },
    },

    {
      name: 'every /guides path rejects an anonymous caller — including the two write paths',
      run: async () => {
        const paths = [
          ['GET', '/guides'],
          ['GET', '/guides/me'],
          ['GET', '/guides/gateway-suite-no-such-guide'],
          ['POST', '/guides'],
          ['POST', '/guides/apply'],
        ];
        for (const [method, path] of paths) {
          const res = await fetch(`${config.gwUrl}${path}`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: method === 'POST' ? '{}' : undefined,
          });
          // 401 before the handler runs is also what keeps the two write
          // paths safe to name here: an anonymous POST creates nothing.
          assert(res.status === 401, `anonymous ${method} ${path} must be 401, got ${res.status}`);
        }
      },
    },
  ],
};
