// Generic poll-with-timeout for asserting on state that updates asynchronously
// (Pub/Sub-driven side effects — e.g. reward-service reacting to a
// booking_confirmed/booking_cancelled event usually lands within a few
// seconds, but is never instant). Call `fn` every `intervalMs` until it
// returns `{ done: true, value }`, or throw once `timeoutMs` elapses.
export async function poll(fn, { timeoutMs = 30000, intervalMs = 3000, desc = 'condition' } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (last.done) return last.value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${desc}; last seen: ${JSON.stringify(last?.value)}`);
}
