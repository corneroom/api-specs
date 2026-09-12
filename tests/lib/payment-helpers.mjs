// payment-service read helpers shared by the money-flow tests
// (services/payment-*-flow.mjs). Mirrors lib/reward-helpers.mjs.
import { config } from './env.mjs';
import { authHeaders } from './auth.mjs';

// POST /payments/coupons/quote -> what a coupon WOULD be worth on a checkout.
// Read-only by contract: creates no payment object and takes no hold (the hold
// happens at Reserve, via POST /payments/intents). A coupon that doesn't
// qualify is a normal 200 with { valid:false, coupon_reason_code }.
export async function quoteCoupon(tokens, { bookingId, couponCode, amount, currency }) {
  const res = await fetch(`${config.gwUrl}/payments/coupons/quote`, {
    method: 'POST',
    headers: { ...authHeaders(tokens, 'full'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ booking_id: bookingId, coupon_code: couponCode, amount, currency }),
  });
  if (res.status !== 200) throw new Error(`POST /payments/coupons/quote failed ${res.status}: ${await res.text()}`);
  return (await res.json()).data;
}

// GET /payments/history -> the caller's ledger rows for one booking, newest
// page first. Rows are typed (`booking`, `refund`, …) and carry `status`
// (pending|completed|failed|cancelled|disputed|on_hold) plus `dispute_status`
// — this is the only guest-facing view of what money actually moved.
export async function getBookingTransactions(tokens, bookingId, limit = 25) {
  const res = await fetch(`${config.gwUrl}/payments/history?page=1&limit=${limit}`, {
    headers: authHeaders(tokens, 'full'),
  });
  if (res.status !== 200) throw new Error(`GET /payments/history failed ${res.status}: ${await res.text()}`);
  const data = (await res.json()).data ?? {};
  return (data.transactions ?? []).filter((t) => t.booking_id === bookingId);
}
