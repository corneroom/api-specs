import { config } from './env.mjs';
import { login, authHeaders } from './auth.mjs';

// A test case:
//   {
//     name:   string,
//     method: 'GET' (default) | 'POST' | 'PATCH' | 'DELETE' | ...,
//     path:   '/users/me'            (appended to GW_URL),
//     auth:   'full' (default) | 'access-only' | 'none',
//     body:   object                 (sent as JSON, optional),
//     expect: 200 | [200, 204]       (status or list of acceptable statuses),
//   }
async function runCase(tokens, c) {
  const method = c.method || 'GET';
  const headers = { ...authHeaders(tokens, c.auth ?? 'full') };
  let body;
  if (c.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(c.body);
  }
  const res = await fetch(`${config.gwUrl}${c.path}`, { method, headers, body });
  const expected = Array.isArray(c.expect) ? c.expect : [c.expect];
  return { ok: expected.includes(res.status), status: res.status, expected };
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
      const auth = c.auth ?? 'full';
      try {
        const r = await runCase(tokens, c);
        if (r.ok) {
          console.log(`  ✓ ${c.name}  [${r.status}, auth=${auth}]`);
          pass++;
        } else {
          console.log(`  ✗ ${c.name}  expected ${r.expected.join('|')} got ${r.status} (auth=${auth})`);
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
