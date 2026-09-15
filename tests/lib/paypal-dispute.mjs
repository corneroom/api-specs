// PayPal SANDBOX dispute client — deciding a dispute a human already filed.
//
// ── WHY THE SUITE CAN ONLY DO HALF OF THIS ─────────────────────────────────
// PayPal has no create-dispute path we can use and no way to pay on the
// buyer's behalf:
//   · Paying requires the BUYER to open `approval_url`
//     (`sandbox.paypal.com/checkoutnow`) and log in — payment-service's
//     `internal/service/paypal_service.go` ~356-374 returns that link and there
//     is no API to approve an order for someone else. The vault (`vault_id`)
//     reuse path does not escape it either: our own comment at
//     `paypal_service.go:278-281` says a vaulted buyer-initiated charge "may
//     still return an approval link (true off-session/no-redirect needs
//     Reference Transactions)".
//   · Filing is a buyer action in the sandbox Resolution Center. `POST
//     /v1/customer/disputes` exists only under a limited-release programme.
// So a human does exactly two things — pay, then "Report a Problem" — and
// everything after that is automated here. That is the agreed option 3.
//
// ── WHAT IS OBSERVED, NOT ASSUMED (staging sandbox, 2026-09-15) ────────────
// Checked against the real sandbox account before writing any of this:
//   · The token's scope list includes `disputes/read-seller`,
//     `disputes/update-seller`, `disputes/read-buyer` and even
//     `disputes/create` — Dispute Management IS enabled on the app.
//   · `GET /v1/customer/disputes` (the LIST) returns `links: ['self']` only —
//     the action links live on the per-dispute GET. So this module always reads
//     the detail before deciding anything.
//   · A live INQUIRY dispute awaiting the seller (`status:
//     WAITING_FOR_SELLER_RESPONSE`, `dispute_state: REQUIRED_ACTION`) offers
//     exactly: `accept_claim`, `provide_evidence`, `send_message`, `escalate`,
//     `make_offer`. `adjudicate` is NOT offered at INQUIRY — it appears only
//     once the dispute is UNDER_REVIEW, which is what `escalate` is for.
//   · The link `rel`s use UNDERSCORES (`accept_claim`, `send_message`) while
//     the URL paths use hyphens (`/accept-claim`). Everything below follows the
//     `href` PayPal gives rather than building paths, so that mismatch cannot
//     bite.
//   · `disputed_transactions[0].reference_id` is ABSENT on real sandbox
//     disputes; `seller_transaction_id` (the capture id) is present. That is
//     exactly why payment-service matches a PayPal dispute by capture id
//     fallback (`payment.go` ~5352-5360).
//
// GUARDS: the base URL is a constant and is asserted to be the sandbox host —
// there is no env override, because "point the dispute adjudicator at live" has
// no legitimate use. Credentials come from `tests/.env` (gitignored) and are
// never printed; PayPal error bodies are echoed, request bodies are not.
// `config` is imported for its module side effect as much as its value: env.mjs
// is what loads gitignored tests/.env, so without this import the credentials
// below are invisible whenever this module is used outside a flow that already
// imported env.mjs.
import { config, assertStagingGateway } from './env.mjs';
import { skip } from './skip.mjs';
import { poll } from './poll.mjs';

// Not configurable, deliberately. payment-service picks sandbox-vs-live the
// same way — by environment, not by an overridable setting
// (`internal/server.go:290` `resolvePayPalAPIBase`).
const SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';

if (new URL(SANDBOX_BASE).host !== 'api-m.sandbox.paypal.com') {
  throw new Error('REFUSING TO LOAD: PayPal base URL is not the sandbox host');
}

export const paypalCreds = () => ({
  clientId: process.env.PAYPAL_CLIENT_ID || '',
  secret: process.env.PAYPAL_CLIENT_SECRET || '',
});

// Call at the top of any case that decides a dispute.
export function requirePayPalCreds() {
  const { clientId, secret } = paypalCreds();
  if (!clientId || !secret) {
    skip(
      'PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set — deciding a sandbox dispute needs the STAGING PayPal ' +
        'sandbox app credentials (see tests/.env.example and the header of lib/paypal-dispute.mjs)'
    );
  }
  // The flow that uses this cancels or completes a real booking through the
  // gateway, so the gateway must be the staging one even though the PayPal host
  // itself is pinned to the sandbox. Allow-listed, not deny-listed.
  assertStagingGateway('the PayPal dispute flow');
  return { clientId, secret };
}

let cachedToken = null;

async function accessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) return cachedToken.value;
  const { clientId, secret } = requirePayPalCreds();
  const res = await fetch(`${SANDBOX_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${clientId}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const json = await res.json().catch(() => ({}));
  if (!json.access_token) {
    // `error_description` is PayPal's own text — safe to surface, and it is what
    // distinguishes bad credentials from a disabled feature.
    throw new Error(`PayPal sandbox OAuth failed (${res.status}): ${json.error_description || json.error || 'no access_token'}`);
  }
  cachedToken = { value: json.access_token, expiresAt: Date.now() + (json.expires_in || 300) * 1000 };
  return cachedToken.value;
}

async function ppFetch(method, pathOrHref, body) {
  const url = pathOrHref.startsWith('http') ? pathOrHref : `${SANDBOX_BASE}${pathOrHref}`;
  // Re-assert on every call: a HATEOAS href comes from PayPal's response, so
  // this is the line that stops a redirected/poisoned link reaching live.
  if (new URL(url).host !== 'api-m.sandbox.paypal.com') {
    throw new Error(`REFUSING: PayPal call to non-sandbox host ${new URL(url).host}`);
  }
  const token = await accessToken();
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (res.status >= 400) {
    // Verbatim, including `details` — a "Dispute Management not enabled" or a
    // "not allowed in this state" answer is an owner/state fact, not something
    // to paraphrase.
    throw new Error(`PayPal ${method} ${new URL(url).pathname} → ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

// ─── reads ──────────────────────────────────────────────────────────────────

export const getDispute = (disputeId) => ppFetch('GET', `/v1/customer/disputes/${encodeURIComponent(disputeId)}`);

// Disputes filed against one capture. The LIST view omits action links and
// (in practice) some transaction fields, so callers that need either should
// re-read the detail via getDispute().
//
// Observed behaviour of the `disputed_transaction_id` filter (staging sandbox,
// 2026-09-15), because it is not what the docs imply:
//   · a real capture WITH a dispute   → 200, items = [that dispute]
//     (verified: 19995441U0906873F → PP-R-OVI-10186870)
//   · a real capture with NO dispute  → 200, items = []
//     (verified: 9GY96405EC579332F)
//   · an id PayPal does not recognise → 400 INVALID_REQUEST, not an empty page
//     (verified: 'NOSUCHCAPTURE123')
// The third case is reported as "no disputes" rather than thrown, because every
// caller is asking "is there a dispute on this capture?" and an unrecognised id
// answers that question — no. The raw error is attached for diagnosis rather
// than swallowed.
export async function findDisputesForCapture(captureId) {
  try {
    const json = await ppFetch(
      'GET',
      `/v1/customer/disputes?disputed_transaction_id=${encodeURIComponent(captureId)}&page_size=20`
    );
    return json.items || [];
  } catch (e) {
    // Narrow on purpose: ONLY the "PayPal does not recognise this
    // disputed_transaction_id" shape is treated as "no disputes". Any other
    // INVALID_REQUEST (a malformed page_size, a schema change) is a real error
    // and must not be laundered into an empty result.
    const isUnknownTransactionId =
      /INVALID_REQUEST/.test(e.message) && /disputed_transaction_id|INVALID_REQUEST"\}\]/.test(e.message);
    if (isUnknownTransactionId) {
      const empty = [];
      empty.unrecognisedId = e.message;
      return empty;
    }
    throw e;
  }
}

const linkFor = (dispute, rel) => (dispute.links || []).find((l) => l.rel === rel);
export const disputeActions = (dispute) => (dispute.links || []).map((l) => l.rel).filter((r) => r !== 'self');

// ─── the decision ───────────────────────────────────────────────────────────

// Terminal outcome code, or null while the dispute is still open.
export const outcomeCode = (dispute) => dispute?.dispute_outcome?.outcome_code || null;

const TERMINAL_STATES = ['RESOLVED'];
export const isTerminal = (dispute) => TERMINAL_STATES.includes(dispute.dispute_state) || !!outcomeCode(dispute);

// Give the buyer the win, deterministically, WITHOUT needing the dispute to
// reach UNDER_REVIEW: accepting the claim closes it in the buyer's favour and
// PayPal refunds them. This is the documented merchant action (scope
// `disputes/update-seller`) and it is NOT sandbox-only, so it is the reliable
// buyer-win path. Resulting outcome_code is ACCEPTED (or
// RESOLVED_BUYER_FAVOUR); payment-service maps BOTH to "lost"
// (`paypalDisputeOutcomeStatus`).
async function acceptClaim(dispute) {
  const link = linkFor(dispute, 'accept_claim');
  if (!link) {
    throw new Error(
      `PayPal offers no accept_claim on dispute ${dispute.dispute_id} ` +
        `(status=${dispute.status}, state=${dispute.dispute_state}, stage=${dispute.dispute_life_cycle_stage}; ` +
        `available: ${disputeActions(dispute).join(', ') || 'none'})`
    );
  }
  // Only `note` is sent. `accept_claim_type` defaults to a plain refund, and
  // guessing an enum value here would be inventing API surface.
  return ppFetch('POST', link.href, { note: 'Corneroom gateway suite: accepting claim to drive a buyer-win outcome.' });
}

// Adjudication (the sandbox-only "decide it for me" call) requires the dispute
// to be UNDER_REVIEW, which an INQUIRY reaches via escalate. Both steps are
// driven off the links PayPal actually offers.
async function adjudicate(disputeId, adjudicationOutcome) {
  let dispute = await getDispute(disputeId);

  if (!linkFor(dispute, 'adjudicate')) {
    const escalate = linkFor(dispute, 'escalate');
    if (!escalate) {
      throw new Error(
        `dispute ${disputeId} offers neither adjudicate nor escalate ` +
          `(status=${dispute.status}, state=${dispute.dispute_state}, stage=${dispute.dispute_life_cycle_stage}; ` +
          `available: ${disputeActions(dispute).join(', ') || 'none'})`
      );
    }
    try {
      await ppFetch('POST', escalate.href, {
        note: 'Corneroom gateway suite: escalating to a claim so the outcome can be adjudicated.',
      });
    } catch (e) {
      // Some sandbox inquiries refuse escalation until the seller has replied
      // at least once. Answer, then escalate again — and if THAT fails, the
      // error is surfaced verbatim rather than worked around.
      const sendMessage = linkFor(dispute, 'send_message');
      if (!sendMessage) throw e;
      await ppFetch('POST', sendMessage.href, {
        message: 'Corneroom gateway suite: automated seller response so this dispute can be escalated.',
      });
      await ppFetch('POST', escalate.href, {
        note: 'Corneroom gateway suite: escalating to a claim so the outcome can be adjudicated.',
      });
    }

    dispute = await poll(
      async () => {
        const d = await getDispute(disputeId);
        return { done: !!linkFor(d, 'adjudicate'), value: d };
      },
      {
        timeoutMs: 120000,
        intervalMs: 6000,
        desc: `dispute ${disputeId} to become adjudicable (UNDER_REVIEW) after escalation`,
      }
    );
  }

  // Spelling trap, and it is load-bearing: the REQUEST enum is BUYER_FAVOR /
  // SELLER_FAVOR (no U), while the resulting dispute_outcome.outcome_code is
  // RESOLVED_BUYER_FAVOUR / RESOLVED_SELLER_FAVOUR (with U) — which is what
  // payment-service's `paypalDisputeOutcomeStatus` matches on. A no-U seller
  // win would fall through its `default` branch and be treated as LOST.
  if (!['BUYER_FAVOR', 'SELLER_FAVOR'].includes(adjudicationOutcome)) {
    throw new Error(`invalid adjudication_outcome ${adjudicationOutcome}`);
  }
  return ppFetch('POST', linkFor(dispute, 'adjudicate').href, { adjudication_outcome: adjudicationOutcome });
}

// Drive `disputeId` to a terminal outcome.
//   'buyer'  → accept_claim if offered (deterministic, not sandbox-only),
//              otherwise adjudicate BUYER_FAVOR
//   'seller' → escalate (if needed) then adjudicate SELLER_FAVOR — there is no
//              non-adjudication way to force a seller win
// Returns the dispute once PayPal reports it terminal, so the caller can assert
// on the real `outcome_code`.
//
// `expectedCaptureId` is REQUIRED and is re-verified here, against the dispute
// detail this function reads for itself. Deciding a dispute is irreversible and
// the sandbox account holds other people's disputes, so ownership must not be
// something a caller can forget, check too late, or check and then ignore —
// the test runner deliberately continues past a failed case, so a caller-side
// assertion alone does NOT stop the next case calling this. The guard belongs
// in the primitive.
export async function decideDispute(disputeId, winner, { expectedCaptureId } = {}) {
  if (!['buyer', 'seller'].includes(winner)) throw new Error(`winner must be 'buyer' or 'seller', got '${winner}'`);
  if (!expectedCaptureId) {
    throw new Error(
      `decideDispute(${disputeId}) requires expectedCaptureId — refusing to close a dispute without proving it ` +
        'belongs to the capture under test'
    );
  }
  const before = await getDispute(disputeId);
  const captures = (before.disputed_transactions || []).map((t) => t.seller_transaction_id);
  if (!captures.includes(expectedCaptureId)) {
    throw new Error(
      `REFUSING to decide dispute ${disputeId}: it is filed against capture(s) ${JSON.stringify(captures)}, not the ` +
        `expected ${expectedCaptureId}. Closing it would be an irreversible action on a dispute that is not the one ` +
        'under test.'
    );
  }
  if (isTerminal(before)) {
    throw new Error(
      `dispute ${disputeId} is already terminal (outcome_code=${outcomeCode(before)}) — it cannot be decided again; ` +
        'file a fresh dispute on a fresh booking for this run'
    );
  }

  if (winner === 'buyer' && linkFor(before, 'accept_claim')) {
    await acceptClaim(before);
  } else {
    await adjudicate(disputeId, winner === 'buyer' ? 'BUYER_FAVOR' : 'SELLER_FAVOR');
  }

  return poll(
    async () => {
      const d = await getDispute(disputeId);
      return { done: isTerminal(d), value: d };
    },
    { timeoutMs: 180000, intervalMs: 6000, desc: `dispute ${disputeId} to reach a terminal outcome` }
  );
}

// PayPal outcome_code → the internal status payment-service normalizes it to
// (`paypalDisputeOutcomeStatus` in payment-service internal/service/payment_dispute.go).
// Mirrored here so the test asserts the mapping rather than restating one side
// of it: if the service's buckets change, this table is the thing to update.
export function expectedInternalStatus(code) {
  switch (code) {
    case 'RESOLVED_SELLER_FAVOUR':
    case 'CANCELED_BY_BUYER':
    case 'DENIED':
      return 'won';
    case 'RESOLVED_WITH_PAYOUT':
    case 'RESOLVED_BUYER_FAVOUR':
    case 'ACCEPTED':
      return 'lost';
    case 'NONE':
      return null; // skipped by the service — no money conclusion either way
    default:
      return 'lost'; // unknown code: the service fails closed
  }
}
