import { config, requireCreds } from './env.mjs';

let cached = null;

// Log in once per process against the app gateway and cache the tokens.
export async function login() {
  if (cached) return cached;
  requireCreds();
  const res = await fetch(`${config.gwUrl}/users/login/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: config.email, password: config.password }),
  });
  if (res.status !== 200) {
    throw new Error(`login failed: ${res.status} ${await res.text()}`);
  }
  const raw = res.headers.get('x-corneroom-access');
  const refresh = res.headers.get('x-corneroom-refresh');
  if (!raw) throw new Error('login ok but no X-Corneroom-Access header returned');
  cached = { raw, refresh };
  return cached;
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
