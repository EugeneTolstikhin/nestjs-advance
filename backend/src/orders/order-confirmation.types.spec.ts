import { isFinalDeliveryStatus } from './order-confirmation.types';

describe('Delivery completion', () => {
  it.each(['returned_to_sender', 'delivered', 'cancelled'])(
    'stops polling for %s',
    (status) => {
      expect(isFinalDeliveryStatus(status)).toBe(true);
    },
  );
  it.each([
    'pending',
    'label_created',
    'picked_up',
    'in_transit',
    'out_for_delivery',
    'delivery_failed',
    'returning_to_sender',
  ])('continues polling for %s', (status) => {
    expect(isFinalDeliveryStatus(status)).toBe(false);
  });
});
