// reward-service read/write helpers shared by tests/services/rewards-referral-flow.mjs.
import { config } from './env.mjs';
import { authHeaders } from './auth.mjs';

// GET /rewards/me/wallet -> array of active, non-expired coupons.
export async function getWallet(tokens) {
  const res = await fetch(`${config.gwUrl}/rewards/me/wallet`, { headers: authHeaders(tokens, 'full') });
  if (res.status !== 200) throw new Error(`GET /rewards/me/wallet failed ${res.status}: ${await res.text()}`);
  return (await res.json()).data.coupons ?? [];
}

// GET /rewards/me/referral -> { user_id, code, created_at, referred_by?: { first_name, status } }.
export async function getMyReferral(tokens) {
  const res = await fetch(`${config.gwUrl}/rewards/me/referral`, { headers: authHeaders(tokens, 'full') });
  if (res.status !== 200) throw new Error(`GET /rewards/me/referral failed ${res.status}: ${await res.text()}`);
  return (await res.json()).data;
}

export async function applyReferralCode(tokens, code) {
  const res = await fetch(`${config.gwUrl}/rewards/referral/apply`, {
    method: 'POST',
    headers: { ...authHeaders(tokens, 'full'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (res.status !== 200) throw new Error(`POST /rewards/referral/apply failed ${res.status}: ${await res.text()}`);
  return (await res.json()).data;
}
