import { createActor, type ActorRefFrom } from 'xstate';
import { checkoutMachine, type CheckoutEvent } from './checkout.machine';

type CheckoutActor = ActorRefFrom<typeof checkoutMachine>;
const actors: CheckoutActor[] = [];
function fixture() {
  const logs: Record<string, unknown>[] = [];
  const actor = createActor(checkoutMachine, {
    input: { checkoutId: 'checkout-test', buyerId: 'private-buyer-id' },
    logger: (record) => logs.push(record),
  }).start();
  actors.push(actor);
  return { actor, logs };
}
function send(actor: CheckoutActor, events: CheckoutEvent[]) {
  events.forEach((event) => actor.send(event));
}
const toReview: CheckoutEvent[] = [
  { type: 'START' },
  { type: 'CART_VALIDATED' },
  { type: 'DELIVERY_ACCEPTED' },
  { type: 'SHIPPING_SELECTED' },
];
function pending(actor: CheckoutActor, attemptId = 'attempt-1') {
  send(actor, [
    ...toReview,
    { type: 'CONFIRM' },
    { type: 'PAYMENT_PREPARED', attemptId },
  ]);
}
afterEach(() => {
  actors.splice(0).forEach((actor) => actor.stop());
});

describe('Checkout state-machine skeleton', () => {
  it('reaches completion only after payment verification and order finalization', () => {
    const { actor, logs } = fixture();
    pending(actor);
    actor.send({ type: 'PAYMENT_SUCCEEDED', attemptId: 'attempt-1' });
    expect(actor.getSnapshot().value).toBe('finalizingOrder');
    expect(actor.getSnapshot().status).toBe('active');
    actor.send({ type: 'ORDER_FINALIZED' });
    expect(actor.getSnapshot().value).toBe('completed');
    expect(actor.getSnapshot().status).toBe('done');
    expect(logs.map((log) => log.state)).toEqual([
      'idle',
      'validatingCart',
      'delivery',
      'shipping',
      'review',
      'preparingPayment',
      'paymentPending',
      'finalizingOrder',
      'completed',
    ]);
  });
  it('cannot skip validation, delivery, review or payment preparation', () => {
    const { actor } = fixture();
    for (const event of [
      { type: 'CONFIRM' },
      { type: 'PAYMENT_SUCCEEDED', attemptId: 'attempt-1' },
      { type: 'ORDER_FINALIZED' },
    ] as CheckoutEvent[]) {
      expect(actor.getSnapshot().can(event)).toBe(false);
      actor.send(event);
      expect(actor.getSnapshot().value).toBe('idle');
    }
    actor.send({ type: 'START' });
    actor.send({ type: 'SHIPPING_SELECTED' });
    expect(actor.getSnapshot().value).toBe('validatingCart');
  });
  it('requires cart corrections to be validated again', () => {
    const { actor } = fixture();
    send(actor, [
      { type: 'START' },
      { type: 'CART_REJECTED', problem: 'stock_changed' },
    ]);
    expect(actor.getSnapshot().context.problem).toBe('stock_changed');
    actor.send({ type: 'CONFIRM' });
    expect(actor.getSnapshot().value).toBe('needsCartChanges');
    actor.send({ type: 'RETRY' });
    expect(actor.getSnapshot().value).toBe('validatingCart');
    expect(actor.getSnapshot().context.problem).toBeNull();
  });
  it('supports going back before confirmation and rejects cart changes found during preparation', () => {
    const { actor } = fixture();
    send(actor, toReview);
    actor.send({ type: 'BACK' });
    expect(actor.getSnapshot().value).toBe('shipping');
    actor.send({ type: 'BACK' });
    expect(actor.getSnapshot().value).toBe('delivery');
    send(actor, [
      { type: 'DELIVERY_ACCEPTED' },
      { type: 'SHIPPING_SELECTED' },
      { type: 'CONFIRM' },
      { type: 'PREPARATION_REJECTED', problem: 'price_changed' },
    ]);
    expect(actor.getSnapshot().value).toBe('needsCartChanges');
    expect(actor.getSnapshot().context.problem).toBe('price_changed');
  });
  it('ignores duplicate confirmation and stale payment results from an earlier attempt', () => {
    const { actor, logs } = fixture();
    pending(actor);
    actor.send({ type: 'CONFIRM' });
    actor.send({ type: 'PAYMENT_SUCCEEDED', attemptId: 'old-attempt' });
    expect(actor.getSnapshot().value).toBe('paymentPending');
    expect(logs.filter((log) => log.state === 'preparingPayment')).toHaveLength(
      1,
    );
  });
  it('releases failed-attempt reservations before a new review/payment attempt', () => {
    const { actor } = fixture();
    pending(actor);
    send(actor, [
      { type: 'PAYMENT_FAILED', attemptId: 'attempt-1' },
      { type: 'RETRY' },
    ]);
    expect(actor.getSnapshot().value).toBe('releasingReservation');
    actor.send({ type: 'CONFIRM' });
    expect(actor.getSnapshot().value).toBe('releasingReservation');
    actor.send({ type: 'RESERVATION_RELEASED' });
    expect(actor.getSnapshot().value).toBe('validatingCart');
    send(actor, [
      ...toReview.slice(1),
      { type: 'CONFIRM' },
      { type: 'PAYMENT_PREPARED', attemptId: 'attempt-2' },
    ]);
    actor.send({ type: 'PAYMENT_SUCCEEDED', attemptId: 'attempt-1' });
    expect(actor.getSnapshot().value).toBe('paymentPending');
    actor.send({ type: 'PAYMENT_SUCCEEDED', attemptId: 'attempt-2' });
    expect(actor.getSnapshot().value).toBe('finalizingOrder');
  });
  it('allows safe cancellation before preparation but not an unconfirmed cancellation afterward', () => {
    const early = fixture().actor;
    send(early, [...toReview, { type: 'CANCEL' }]);
    expect(early.getSnapshot().value).toBe('cancelled');
    const actor = fixture().actor;
    send(actor, [...toReview, { type: 'CONFIRM' }, { type: 'CANCEL' }]);
    expect(actor.getSnapshot().value).toBe('preparingPayment');
  });
  it('waits for provider cancellation and reservation release before becoming cancelled', () => {
    const { actor } = fixture();
    pending(actor);
    actor.send({ type: 'CANCEL' });
    expect(actor.getSnapshot().value).toBe('cancellingPayment');
    actor.send({ type: 'PAYMENT_CANCELLED', attemptId: 'old-attempt' });
    expect(actor.getSnapshot().value).toBe('cancellingPayment');
    actor.send({ type: 'PAYMENT_CANCELLED', attemptId: 'attempt-1' });
    expect(actor.getSnapshot().value).toBe('releasingReservation');
    actor.send({ type: 'RESERVATION_RELEASED' });
    expect(actor.getSnapshot().value).toBe('cancelled');
  });
  it('honors verified success racing with a cancellation request', () => {
    const { actor, logs } = fixture();
    pending(actor);
    send(actor, [
      { type: 'CANCEL' },
      { type: 'PAYMENT_SUCCEEDED', attemptId: 'attempt-1' },
    ]);
    expect(actor.getSnapshot().value).toBe('finalizingOrder');
    expect(logs.some((log) => log.state === 'releasingReservation')).toBe(
      false,
    );
  });
  it('keeps unknown outcomes unresolved until a provider result is verified', () => {
    const { actor } = fixture();
    pending(actor);
    send(actor, [
      { type: 'PAYMENT_OUTCOME_UNKNOWN', attemptId: 'attempt-1' },
      { type: 'RECONCILIATION_FAILED' },
      { type: 'CANCEL' },
    ]);
    expect(actor.getSnapshot().value).toBe('reconciliationFailed');
    actor.send({ type: 'RETRY' });
    expect(actor.getSnapshot().value).toBe('reconciling');
    actor.send({ type: 'PAYMENT_SUCCEEDED', attemptId: 'attempt-1' });
    expect(actor.getSnapshot().value).toBe('finalizingOrder');
  });
  it('expires only after provider confirmation and successful reservation release', () => {
    const { actor } = fixture();
    pending(actor);
    actor.send({ type: 'PAYMENT_EXPIRED', attemptId: 'attempt-1' });
    expect(actor.getSnapshot().value).toBe('paymentPending');
    send(actor, [
      { type: 'CHECK_PAYMENT_STATUS' },
      { type: 'PAYMENT_EXPIRED', attemptId: 'attempt-1' },
      { type: 'RESERVATION_RELEASE_FAILED' },
    ]);
    expect(actor.getSnapshot().value).toBe('reservationReleaseFailed');
    send(actor, [{ type: 'RETRY' }, { type: 'RESERVATION_RELEASED' }]);
    expect(actor.getSnapshot().value).toBe('expired');
  });
  it('reconciles uncertain preparation but releases reservations after definitive preparation failure', () => {
    const uncertain = fixture().actor;
    send(uncertain, [
      ...toReview,
      { type: 'CONFIRM' },
      { type: 'PREPARATION_OUTCOME_UNKNOWN', attemptId: 'attempt-1' },
    ]);
    expect(uncertain.getSnapshot().value).toBe('reconciling');
    const failed = fixture().actor;
    send(failed, [
      ...toReview,
      { type: 'CONFIRM' },
      { type: 'PREPARATION_FAILED' },
      { type: 'CANCEL' },
    ]);
    expect(failed.getSnapshot().value).toBe('releasingReservation');
  });
  it('does not cancel a paid order when finalization fails and can retry finalization', () => {
    const { actor } = fixture();
    pending(actor);
    send(actor, [
      { type: 'PAYMENT_SUCCEEDED', attemptId: 'attempt-1' },
      { type: 'ORDER_FINALIZATION_FAILED' },
      { type: 'CANCEL' },
    ]);
    expect(actor.getSnapshot().value).toBe('finalizationFailed');
    send(actor, [{ type: 'RETRY' }, { type: 'ORDER_FINALIZED' }]);
    expect(actor.getSnapshot().value).toBe('completed');
  });
  it('does not repeat finalization logs for duplicated success notifications', () => {
    const { actor, logs } = fixture();
    pending(actor);
    send(actor, [
      { type: 'PAYMENT_SUCCEEDED', attemptId: 'attempt-1' },
      { type: 'PAYMENT_SUCCEEDED', attemptId: 'attempt-1' },
      { type: 'ORDER_FINALIZED' },
      { type: 'ORDER_FINALIZED' },
    ]);
    expect(logs.filter((log) => log.state === 'finalizingOrder')).toHaveLength(
      1,
    );
    expect(logs.filter((log) => log.state === 'completed')).toHaveLength(1);
  });
  it('can serialize and restore the model without replaying completed entry actions', () => {
    const original = fixture().actor;
    pending(original);
    const snapshot = JSON.parse(
      JSON.stringify(original.getPersistedSnapshot()),
    );
    original.stop();
    const logs: unknown[] = [];
    const restored = createActor(checkoutMachine, {
      input: { checkoutId: 'checkout-test', buyerId: 'private-buyer-id' },
      snapshot,
      logger: (record) => logs.push(record),
    }).start();
    actors.push(restored);
    expect(restored.getSnapshot().value).toBe('paymentPending');
    expect(logs).toHaveLength(0);
    restored.send({ type: 'PAYMENT_SUCCEEDED', attemptId: 'attempt-1' });
    expect(restored.getSnapshot().value).toBe('finalizingOrder');
  });
  it('logs only identifiers, step names and planned operations, without buyer details', () => {
    const { actor, logs } = fixture();
    pending(actor);
    expect(logs.every((log) => log.mode === 'skeleton')).toBe(true);
    expect(JSON.stringify(logs)).not.toContain('private-buyer-id');
    expect(logs.find((log) => log.state === 'preparingPayment')).toMatchObject({
      plannedOperation: 'createPendingOrderReserveStockAndPreparePayment',
    });
  });
});
