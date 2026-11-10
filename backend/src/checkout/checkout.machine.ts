import { assign, setup } from 'xstate';

export interface CheckoutInput {
  checkoutId: string;
  buyerId: string;
}
export type CheckoutProblem =
  | 'empty_cart'
  | 'product_unavailable'
  | 'stock_changed'
  | 'price_changed'
  | 'seller_unassigned';
export interface CheckoutContext extends CheckoutInput {
  paymentAttemptId: string | null;
  releaseOutcome: 'retry' | 'cancelled' | 'expired' | 'cartChanges' | null;
  problem: CheckoutProblem | null;
}

// Outcome events will come from trusted server services/workers. They are not a
// public API contract: a browser must never assert that payment succeeded.
export type CheckoutEvent =
  | { type: 'START' }
  | { type: 'CART_VALIDATED' }
  | { type: 'CART_REJECTED'; problem: CheckoutProblem }
  | { type: 'STOCK_RESERVED' }
  | { type: 'RESERVATION_REJECTED'; problem: CheckoutProblem }
  | { type: 'RESERVATION_EXPIRED' }
  | { type: 'DELIVERY_ACCEPTED' }
  | { type: 'SHIPPING_SELECTED' }
  | { type: 'BACK' }
  | { type: 'CONFIRM' }
  | { type: 'RETRY' }
  | { type: 'CANCEL' }
  | { type: 'PREPARATION_REJECTED'; problem: CheckoutProblem }
  | { type: 'PREPARATION_FAILED' }
  | { type: 'PREPARATION_OUTCOME_UNKNOWN'; attemptId: string }
  | { type: 'PAYMENT_PREPARED'; attemptId: string }
  | { type: 'PAYMENT_SUCCEEDED'; attemptId: string }
  | { type: 'PAYMENT_FAILED'; attemptId: string }
  | { type: 'PAYMENT_CANCELLED'; attemptId: string }
  | { type: 'PAYMENT_EXPIRED'; attemptId: string }
  | { type: 'PAYMENT_OUTCOME_UNKNOWN'; attemptId: string }
  | { type: 'CHECK_PAYMENT_STATUS' }
  | { type: 'RECONCILIATION_FAILED' }
  | { type: 'CANCELLATION_FAILED' }
  | { type: 'RESERVATION_RELEASED' }
  | { type: 'RESERVATION_RELEASE_FAILED' }
  | { type: 'ORDER_FINALIZED' }
  | { type: 'ORDER_FINALIZATION_FAILED' };

const checkout = setup({
  types: {
    context: {} as CheckoutContext,
    input: {} as CheckoutInput,
    events: {} as CheckoutEvent,
  },
  guards: {
    currentAttempt: ({ context, event }) =>
      'attemptId' in event &&
      context.paymentAttemptId !== null &&
      event.attemptId === context.paymentAttemptId,
    releaseForCartChanges: ({ context }) =>
      context.releaseOutcome === 'cartChanges',
    releaseForRetry: ({ context }) => context.releaseOutcome === 'retry',
    releaseForExpiry: ({ context }) => context.releaseOutcome === 'expired',
  },
  actions: {
    rememberAttempt: assign({
      paymentAttemptId: ({ event }) =>
        'attemptId' in event ? event.attemptId : null,
    }),
    rememberProblem: assign({
      problem: ({ event }) => ('problem' in event ? event.problem : null),
    }),
    resetAttempt: assign({
      paymentAttemptId: null,
      releaseOutcome: null,
      problem: null,
    }),
    releaseToCartChanges: assign({ releaseOutcome: 'cartChanges' }),
    releaseToRetry: assign({ releaseOutcome: 'retry' }),
    releaseToCancel: assign({ releaseOutcome: 'cancelled' }),
    releaseToExpire: assign({ releaseOutcome: 'expired' }),
  },
});

// This milestone deliberately has no provider/DB/queue effects. Logs name the
// future operation, so neither entering a state nor running the demo spends money.
const step = (state: string, plannedOperation?: string) =>
  checkout.log(({ context, event }) => ({
    workflow: 'checkout',
    mode: 'model',
    checkoutId: context.checkoutId,
    state,
    event: event.type,
    ...(plannedOperation ? { plannedOperation } : {}),
  }));
const paid = { guard: 'currentAttempt', target: 'finalizingOrder' } as const;
const rejected = { guard: 'currentAttempt', target: 'paymentFailed' } as const;
const cancelled = {
  guard: 'currentAttempt',
  target: 'releasingReservation',
  actions: 'releaseToCancel',
} as const;
const expired = {
  guard: 'currentAttempt',
  target: 'releasingReservation',
  actions: 'releaseToExpire',
} as const;

export const checkoutMachine = checkout.createMachine({
  id: 'checkout',
  initial: 'idle',
  context: ({ input }) => ({
    ...input,
    paymentAttemptId: null,
    releaseOutcome: null,
    problem: null,
  }),
  states: {
    idle: {
      entry: step('idle'),
      on: { START: 'validatingCart', CANCEL: 'cancelled' },
    },
    validatingCart: {
      entry: ['resetAttempt', step('validatingCart', 'validateCart')],
      on: {
        CART_VALIDATED: 'reservingStock',
        CART_REJECTED: {
          target: 'needsCartChanges',
          actions: 'rememberProblem',
        },
        CANCEL: 'cancelled',
      },
    },
    needsCartChanges: {
      entry: step('needsCartChanges'),
      on: { RETRY: 'validatingCart', CANCEL: 'cancelled' },
    },
    reservingStock: {
      entry: step('reservingStock', 'reserveValidatedCartStock'),
      on: {
        STOCK_RESERVED: 'delivery',
        RESERVATION_REJECTED: {
          target: 'needsCartChanges',
          actions: 'rememberProblem',
        },
      },
    },
    delivery: {
      entry: step('delivery', 'validateDeliveryAddress'),
      on: {
        DELIVERY_ACCEPTED: 'shipping',
        CANCEL: { target: 'releasingReservation', actions: 'releaseToCancel' },
        RESERVATION_EXPIRED: 'expired',
      },
    },
    shipping: {
      entry: step('shipping', 'quoteShippingBySeller'),
      on: {
        SHIPPING_SELECTED: 'review',
        BACK: 'delivery',
        CANCEL: { target: 'releasingReservation', actions: 'releaseToCancel' },
        RESERVATION_EXPIRED: 'expired',
      },
    },
    review: {
      entry: step('review', 'presentServerCalculatedQuote'),
      on: {
        CONFIRM: 'preparingPayment',
        BACK: 'shipping',
        CANCEL: { target: 'releasingReservation', actions: 'releaseToCancel' },
        RESERVATION_EXPIRED: 'expired',
      },
    },
    preparingPayment: {
      entry: step(
        'preparingPayment',
        'revalidateReservationCreatePendingOrderAndPreparePayment',
      ),
      on: {
        PAYMENT_PREPARED: {
          target: 'paymentPending',
          actions: 'rememberAttempt',
        },
        // A cart reservation already exists: release it before returning to cart corrections.
        PREPARATION_REJECTED: {
          target: 'releasingReservation',
          actions: ['rememberProblem', 'releaseToCartChanges'],
        },
        PREPARATION_FAILED: 'preparationFailed',
        // A provider request may have succeeded despite a network failure.
        PREPARATION_OUTCOME_UNKNOWN: {
          target: 'reconciling',
          actions: 'rememberAttempt',
        },
      },
    },
    preparationFailed: {
      entry: step('preparationFailed'),
      on: {
        RETRY: { target: 'releasingReservation', actions: 'releaseToRetry' },
        CANCEL: { target: 'releasingReservation', actions: 'releaseToCancel' },
      },
    },
    paymentPending: {
      entry: step('paymentPending', 'awaitVerifiedPaymentOutcome'),
      on: {
        PAYMENT_SUCCEEDED: paid,
        PAYMENT_FAILED: rejected,
        PAYMENT_OUTCOME_UNKNOWN: {
          guard: 'currentAttempt',
          target: 'reconciling',
        },
        CANCEL: 'cancellingPayment',
        CHECK_PAYMENT_STATUS: 'reconciling',
      },
    },
    paymentFailed: {
      entry: step('paymentFailed'),
      on: {
        RETRY: { target: 'releasingReservation', actions: 'releaseToRetry' },
        CANCEL: { target: 'releasingReservation', actions: 'releaseToCancel' },
      },
    },
    cancellingPayment: {
      entry: step('cancellingPayment', 'requestProviderCancellation'),
      on: {
        PAYMENT_CANCELLED: cancelled,
        PAYMENT_FAILED: cancelled,
        PAYMENT_SUCCEEDED: paid,
        CANCELLATION_FAILED: 'reconciling',
        PAYMENT_OUTCOME_UNKNOWN: {
          guard: 'currentAttempt',
          target: 'reconciling',
        },
      },
    },
    reconciling: {
      entry: step('reconciling', 'queryProviderUsingPersistedAttemptReference'),
      on: {
        PAYMENT_SUCCEEDED: paid,
        PAYMENT_FAILED: rejected,
        PAYMENT_CANCELLED: cancelled,
        PAYMENT_EXPIRED: expired,
        RECONCILIATION_FAILED: 'reconciliationFailed',
      },
    },
    reconciliationFailed: {
      entry: step('reconciliationFailed'),
      on: { RETRY: 'reconciling' },
    },
    releasingReservation: {
      entry: step('releasingReservation', 'releaseReservationIfHeld'),
      on: {
        RESERVATION_RELEASED: [
          { guard: 'releaseForCartChanges', target: 'needsCartChanges' },
          { guard: 'releaseForRetry', target: 'validatingCart' },
          { guard: 'releaseForExpiry', target: 'expired' },
          { target: 'cancelled' },
        ],
        RESERVATION_RELEASE_FAILED: 'reservationReleaseFailed',
      },
    },
    reservationReleaseFailed: {
      entry: step('reservationReleaseFailed'),
      on: { RETRY: 'releasingReservation' },
    },
    finalizingOrder: {
      entry: step(
        'finalizingOrder',
        'atomicallyFinalizeOrderAndStockWithOutbox',
      ),
      on: {
        ORDER_FINALIZED: 'completed',
        ORDER_FINALIZATION_FAILED: 'finalizationFailed',
      },
    },
    finalizationFailed: {
      entry: step('finalizationFailed'),
      on: { RETRY: 'finalizingOrder' },
    },
    completed: {
      type: 'final',
      entry: step('completed', 'futureInvoiceWorkflowAndCartCleanupEligible'),
    },
    cancelled: { type: 'final', entry: step('cancelled') },
    expired: { type: 'final', entry: step('expired') },
  },
});
