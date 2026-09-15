// Stripe SECRET-key client — dispute resolution only (CR-650 / CR-679).
//
// ── WHY THIS EXISTS, AND WHY IT IS FENCED ──────────────────────────────────
// Everything else in this suite talks to Stripe with the PUBLISHABLE key, the
// way the mobile SDK does (lib/booking-flow.mjs `confirmWithTestCard`). That is
// enough to CREATE a dispute (`tok_createDispute`, card 4000 0000 0000 0259)
// but not to CLOSE one: forcing a test-mode dispute to won/lost means
// submitting evidence, and that is a secret-key call.
//
// So this module is the only place in the suite that holds a secret key, it is
// used by exactly one flow (services/payment-dispute-resolution-flow.mjs), and
// it is guarded three ways:
//   1. the key must start with `sk_test_` — a live key throws immediately and
//      is never sent anywhere;
//   2. no key at all is a SKIP, not a failure (lib/skip.mjs), so the CI run
//      that has no secret still goes green on everything else;
//   3. the key is never printed — not in errors, not in debug output. Stripe
//      error bodies are echoed, request bodies are not.
//
// Source of the key: staging Secret Manager, into gitignored tests/.env —
//   CLOUDSDK_CONFIG=$HOME/.gcloud/corneroom gcloud secrets versions access latest \
//     --secret=STRIPE_SECRET_KEY --project=corneroom-82fbb
// Staging is the Stripe SANDBOX account (acct_1U96QH…), so this is a test-mode
// key by construction; guard 1 enforces it rather than trusting that.
//
// Test-mode evidence tokens (https://docs.stripe.com/testing#disputes):
//   winning_evidence          → dispute closes `won`
//   losing_evidence           → dispute closes `lost`
//   escalate_inquiry_evidence → an inquiry (warning_needs_response) becomes a
//                               real chargeback (needs_response)
// Submitting evidence fires `charge.dispute.closed`, which is the webhook
// payment-service's `resolveDisputeOutcome` / `resolvePayoutsForDispute` react
// to — i.e. this is the real production path, not a shortcut around it.
import { config } from './env.mjs';
import { skip } from './skip.mjs';

const STRIPE_API = 'https://api.stripe.com/v1';

// The key is read through env.mjs's loader, so tests/.env works exactly like
// it does for the gateway credentials.
export const stripeSecretKey = () => process.env.STRIPE_SECRET_KEY || '';

// Call at the top of any case that needs secret-key access.
// - no key            → the case SKIPS (CI has none by design)
// - key that is live  → hard failure, before a single byte is sent to Stripe
export function requireStripeSecret() {
  const key = stripeSecretKey();
  if (!key) {
    skip(
      'STRIPE_SECRET_KEY not set — dispute resolution needs the STAGING Stripe sandbox secret key ' +
        '(see tests/.env.example and the header of lib/stripe-dispute.mjs)'
    );
  }
  if (!key.startsWith('sk_test_')) {
    throw new Error(
      'REFUSING TO RUN: STRIPE_SECRET_KEY is not a test-mode key (expected an sk_test_ prefix). ' +
        'This suite must never touch a live Stripe account.'
    );
  }
  // Belt and braces: a secret key is only ever valid against the sandbox, but a
  // misconfigured GW_URL would mean driving prod bookings with it.
  if (config.gwUrl.includes('api.corneroom.com') || config.gwUrl.includes('production')) {
    throw new Error(`REFUSING TO RUN: GW_URL points at production (${config.gwUrl}). This flow is staging-only.`);
  }
  return key;
}

async function stripeCall(method, path, form) {
  const key = requireStripeSecret();
  const res = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${key}:`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });
  const json = await res.json().catch(() => ({}));
  if (json.error) {
    // Echo Stripe's error, never the request (which carries nothing secret
    // today, but this is the line that keeps it that way).
    throw new Error(`Stripe ${method} ${path} failed: ${json.error.message || JSON.stringify(json.error)}`);
  }
  return json;
}

// The dispute Stripe raised against a PaymentIntent, or null if it has not
// landed yet (it is raised a few seconds after capture — poll for it).
// `payment_intent` is a documented filter on GET /v1/disputes.
export async function findDisputeForIntent(paymentIntentId) {
  const json = await stripeCall('GET', `/disputes?payment_intent=${encodeURIComponent(paymentIntentId)}&limit=5`);
  return (json.data || [])[0] || null;
}

export async function getDispute(disputeId) {
  return stripeCall('GET', `/disputes/${encodeURIComponent(disputeId)}`);
}

// Submit a test-mode evidence token. `submit=true` is what actually closes the
// dispute (and fires charge.dispute.closed).
async function submitEvidence(disputeId, token) {
  return stripeCall(
    'POST',
    `/disputes/${encodeURIComponent(disputeId)}`,
    `evidence[uncategorized_text]=${token}&submit=true`
  );
}

// Closes the dispute in the HOST's favour (`status: won`): the charge stands.
export const closeDisputeWon = (disputeId) => submitEvidence(disputeId, 'winning_evidence');

// Closes the dispute in the GUEST's favour (`status: lost`): the card network
// has already taken the money back — this is a chargeback, not a refund.
export const closeDisputeLost = (disputeId) => submitEvidence(disputeId, 'losing_evidence');

// Turns an inquiry (warning_needs_response) into a real chargeback. Not used by
// the resolution flow today — `tok_createDispute` raises a chargeback directly —
// but it is the other half of the documented test surface and belongs here
// rather than being re-derived when an inquiry case is added.
export const escalateInquiry = (disputeId) => submitEvidence(disputeId, 'escalate_inquiry_evidence');
