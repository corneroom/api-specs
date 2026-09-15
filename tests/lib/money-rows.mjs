// Exactly-one selectors for the money collections, shared by both dispute
// flows.
//
// WHY THESE EXIST RATHER THAN `rows[0]`
// The Firestore helpers in lib/firestore.mjs return ARRAYS on purpose: a
// `refund_requests` row is keyed `<bookingId>_cancel` and a `payouts` row is
// one-per-booking, so a second row for the same booking is a real bug. Reaching
// for `rows[0]` on an unordered query hides exactly that bug — and picks an
// arbitrary row while doing it. These selectors assert the cardinality instead,
// so a duplicate fails loudly and names the ids it found.
import { getRefundRequestsByBookingId, getPayoutsByBookingId, getTransactionsByBookingId } from './firestore.mjs';

const ids = (rows) => JSON.stringify(rows.map((r) => r.id));

// The one refund_request for a booking.
//
// `expectId` is the id the flow recorded when it first saw the row. When it is
// supplied the selector also proves the row it is about to assert on is THE SAME
// ROW — not a different request that happens to be the only one now.
export async function theRefundRequest(bookingId, { expectId } = {}) {
  const rows = await getRefundRequestsByBookingId(bookingId);
  if (rows.length !== 1) {
    throw new Error(`expected exactly ONE refund_request for booking ${bookingId}, got ${rows.length}: ${ids(rows)}`);
  }
  const [row] = rows;
  if (expectId && row.id !== expectId) {
    throw new Error(`refund_request for booking ${bookingId} is now '${row.id}' but the flow recorded '${expectId}'`);
  }
  return row;
}

// The one payout for a booking, or null before the completion sweep has made it.
export async function thePayout(bookingId) {
  const rows = await getPayoutsByBookingId(bookingId);
  if (rows.length > 1) {
    throw new Error(`expected at most ONE payout for booking ${bookingId}, got ${rows.length}: ${ids(rows)}`);
  }
  return rows[0] || null;
}

// The one refund ledger row in Firestore. This is where `refund_id`
// (`chargeback:<disputeId>`) lands — `closeHeldRow` writes it on the LEDGER
// row, not on the refund_request — and the gateway does not expose it.
export async function theRefundLedgerRow(bookingId) {
  const rows = (await getTransactionsByBookingId(bookingId)).filter((t) => t.type === 'refund');
  if (rows.length !== 1) {
    throw new Error(`expected exactly ONE refund transaction for booking ${bookingId}, got ${rows.length}: ${ids(rows)}`);
  }
  return rows[0];
}
