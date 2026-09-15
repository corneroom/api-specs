import { config, requireCreds, requireHostCreds } from './env.mjs';

// POST /users/login/email — tokens come back in RESPONSE HEADERS, not the body.
// `label` only ever appears in the failure message; the password is never
// logged or echoed.
async function loginWithPassword(email, password, label) {
  const res = await fetch(`${config.gwUrl}/users/login/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) {
    throw new Error(`${label} login failed: ${res.status} ${await res.text()}`);
  }
  const raw = res.headers.get('x-corneroom-access');
  const refresh = res.headers.get('x-corneroom-refresh');
  if (!raw) throw new Error(`${label} login ok but no X-Corneroom-Access header returned`);
  return { raw, refresh };
}

let cached = null;

// Log in once per process against the app gateway and cache the tokens.
export async function login() {
  if (cached) return cached;
  requireCreds();
  cached = await loginWithPassword(config.email, config.password, 'suite account');
  return cached;
}

let cachedHost = null;

// The SECOND identity: a seeded bot HOST. Cached per process for the same
// reason `login()` is — user-service rate-limits its whole auth group to 10
// requests per minute per IP, so a flow must not re-login per case.
//
// Mirrors `login()` exactly, including the shape of what it returns, so
// `authHeaders(hostTokens, ...)` works unchanged everywhere.
export async function loginHost() {
  if (cachedHost) return cachedHost;
  requireHostCreds();
  cachedHost = await loginWithPassword(config.hostEmail, config.hostPassword, 'bot host account');
  return cachedHost;
}

// A THIRD kind of identity: an arbitrary account named by env vars, used by
// flows whose subject account is chosen per run (e.g. the PayPal dispute flow,
// where a human pays as whichever guest they were logged in as). Cached PER
// EMAIL for the same reason `login()` is cached at all — user-service
// rate-limits its whole auth group to 10 requests per minute per IP.
//
// Returns the same shape as `login()`, so `authHeaders(tokens, ...)` works
// unchanged. The password is never logged; `label` is what appears on failure.
const cachedByEmail = new Map();

export async function loginAs(email, password, label = 'named account') {
  if (!email || !password) throw new Error(`${label}: email and password are both required`);
  if (cachedByEmail.has(email)) return cachedByEmail.get(email);
  const tokens = await loginWithPassword(email, password, label);
  cachedByEmail.set(email, tokens);
  return tokens;
}

// Model how the mobile app authenticates. The Flutter AuthInterceptor sends
// THREE headers on every request (see mobile lib/core/network/interceptors/
// auth_interceptor.dart): Authorization, X-Corneroom-Access, X-Forwarded-Authorization.
// Different backends read different ones — user-service accepts X-Corneroom-Access
// alone, but payment-service and verification-service require Authorization /
// X-Forwarded-Authorization. The non-'full' modes exist for negative tests.
//   full        → all three headers (what the app sends)
//   access-only → only X-Corneroom-Access (should be REJECTED by payment/verification)
//   none        → no auth headers
export function authHeaders(tokens, mode = 'full') {
  const { raw, refresh } = tokens;
  const bearer = `Bearer ${raw}`;
  const refreshHdr = refresh ? { 'X-Corneroom-Refresh': refresh } : {};
  switch (mode) {
    case 'none':
      return {};
    case 'access-only':
      return { 'X-Corneroom-Access': raw, ...refreshHdr };
    case 'full':
    default:
      return {
        Authorization: bearer,
        'X-Corneroom-Access': raw,
        'X-Forwarded-Authorization': bearer,
        ...refreshHdr,
      };
  }
}
