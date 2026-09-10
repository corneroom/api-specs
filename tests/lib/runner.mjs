import { config } from './env.mjs';
import { login, authHeaders } from './auth.mjs';

// Resolve the logged-in user's id once, for `{me}` substitution in paths.
let meId;
async function getMeId(tokens) {
  if (meId !== undefined) return meId;
  const res = await fetch(`${config.gwUrl}/users/me`, { headers: authHeaders(tokens, 'full') });
  const body = await res.json().catch(() => ({}));
  const u = body.data ?? body;
  meId = u.id ?? u.user_id ?? null;
  return meId;
}

// A test case is either a single-request check against the shared logged-in
// account:
//   {
//     name:   string,
//     method: 'GET' (default) | 'POST' | 'PATCH' | 'DELETE' | ...,
//     path:   '/users/{me}/profile'   ({me} -> logged-in user id; appended to GW_URL),
//     auth:   'full' (default) | 'access-only' | 'none',
//     body:   object                  (sent as JSON, optional),
//     expect: 200 | [200, 204]        (status or list of acceptable statuses),
//     check:  (json, res) => string|null   (body assertion: return an error msg, or null if OK),
//   }
// ...or a custom multi-step flow that needs its own identities/requests (e.g.
// a write-path flow driving several freshly-registered accounts through a
// real booking + Stripe payment, like tests/services/rewards-referral-flow.mjs):
//   { name: string, run: async () => void }   // throw to fail, resolve to pass
// `run` cases bypass the shared `tokens`/`path`/`expect` machinery entirely —
// they do their own fetches (own logins, own gateway calls, even calls to
// Stripe) and are still reported through the same ✓/✗ pass/fail accounting.
async function runCase(tokens, c) {
  if (typeof c.run === 'function') {
    try {
      await c.run();
      return { ok: true, status: 'custom', expected: 'custom' };
    } catch (e) {
      return { ok: false, status: 'custom', expected: 'custom', note: e.message };
    }
  }
  const method = c.method || 'GET';
  const headers = { ...authHeaders(tokens, c.auth ?? 'full') };
  let reqBody;
  if (c.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    reqBody = JSON.stringify(c.body);
  }
  let path = c.path;
  if (path.includes('{me}')) {
    const id = await getMeId(tokens);
    if (!id) return { ok: false, status: 0, expected: c.expect, note: 'could not resolve {me} user id' };
    path = path.replace('{me}', id);
  }
  const res = await fetch(`${config.gwUrl}${path}`, { method, headers, body: reqBody });
  const expected = Array.isArray(c.expect) ? c.expect : [c.expect];
  let ok = expected.includes(res.status);
  let note;
  if (ok && c.check) {
    let json;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    const err = c.check(json, res);
    if (err) {
      ok = false;
      note = err;
    }
  }
  return { ok, status: res.status, expected, note };
}

// suites: [{ name, cases: [...] }, ...]
export async function runSuites(suites) {
  console.log(`Gateway: ${config.gwUrl}`);
  const tokens = await login();
  let pass = 0;
  let fail = 0;

  for (const suite of suites) {
    console.log(`\n${suite.name}`);
    for (const c of suite.cases) {
      const isCustom = typeof c.run === 'function';
      const auth = c.auth ?? 'full';
      try {
        const r = await runCase(tokens, c);
        if (r.ok) {
          console.log(isCustom ? `  ✓ ${c.name}` : `  ✓ ${c.name}  [${r.status}, auth=${auth}]`);
          pass++;
        } else {
          const why = r.note ? `— ${r.note}` : `expected ${r.expected.join('|')} got ${r.status}`;
          console.log(isCustom ? `  ✗ ${c.name}  ${why}` : `  ✗ ${c.name}  ${why} (auth=${auth})`);
          fail++;
        }
      } catch (e) {
        console.log(`  ✗ ${c.name} — error: ${e.message}`);
        fail++;
      }
    }
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} gateway suite: ${pass} passed, ${fail} failed`);
  return fail;
}
