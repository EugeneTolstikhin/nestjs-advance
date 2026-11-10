import { createActor } from 'xstate';
import { checkoutMachine, type CheckoutEvent } from './checkout.machine';

// Deterministic, synthetic server outcomes. No real buyer, payment or order exists.
const prefix: CheckoutEvent[] = [
  { type: 'START' },
  { type: 'CART_VALIDATED' },
  { type: 'DELIVERY_ACCEPTED' },
  { type: 'SHIPPING_SELECTED' },
  { type: 'CONFIRM' },
  { type: 'PAYMENT_PREPARED', attemptId: 'demo-attempt-1' },
];
const scenarios: Record<string, CheckoutEvent[]> = {
  success: [
    ...prefix,
    { type: 'PAYMENT_SUCCEEDED', attemptId: 'demo-attempt-1' },
    { type: 'ORDER_FINALIZED' },
  ],
  retry: [
    ...prefix,
    { type: 'PAYMENT_FAILED', attemptId: 'demo-attempt-1' },
    { type: 'RETRY' },
    { type: 'RESERVATION_RELEASED' },
    { type: 'CART_VALIDATED' },
    { type: 'DELIVERY_ACCEPTED' },
    { type: 'SHIPPING_SELECTED' },
    { type: 'CONFIRM' },
    { type: 'PAYMENT_PREPARED', attemptId: 'demo-attempt-2' },
    { type: 'PAYMENT_SUCCEEDED', attemptId: 'demo-attempt-1' }, // Stale result: ignored.
    { type: 'PAYMENT_SUCCEEDED', attemptId: 'demo-attempt-2' },
    { type: 'ORDER_FINALIZED' },
  ],
  cancel: [
    ...prefix,
    { type: 'CANCEL' },
    { type: 'PAYMENT_CANCELLED', attemptId: 'demo-attempt-1' },
    { type: 'RESERVATION_RELEASED' },
  ],
  expiry: [
    ...prefix,
    { type: 'CHECK_PAYMENT_STATUS' },
    { type: 'PAYMENT_EXPIRED', attemptId: 'demo-attempt-1' },
    { type: 'RESERVATION_RELEASED' },
  ],
  reconciliation: [
    ...prefix,
    { type: 'PAYMENT_OUTCOME_UNKNOWN', attemptId: 'demo-attempt-1' },
    { type: 'RECONCILIATION_FAILED' },
    { type: 'RETRY' },
    { type: 'PAYMENT_SUCCEEDED', attemptId: 'demo-attempt-1' },
    { type: 'ORDER_FINALIZED' },
  ],
};

const name = process.argv[2] ?? 'success';
const events = scenarios[name];
if (!events) {
  console.error(
    `Unknown scenario. Choose: ${Object.keys(scenarios).join(', ')}`,
  );
  process.exitCode = 1;
} else {
  console.log(
    'CHECKOUT SKELETON DEMO: all outcomes are simulated; no business effects run.',
  );
  const actor = createActor(checkoutMachine, {
    input: { checkoutId: 'demo-checkout', buyerId: 'demo-buyer' },
    logger: (record) => console.log(JSON.stringify(record)),
  }).start();
  for (const event of events) {
    console.log(
      JSON.stringify({
        send: event.type,
        accepted: actor.getSnapshot().can(event),
      }),
    );
    actor.send(event);
  }
  console.log(`Result: ${String(actor.getSnapshot().value)}`);
  actor.stop();
}
