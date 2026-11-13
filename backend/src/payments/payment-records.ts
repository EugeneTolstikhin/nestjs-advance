import type { CheckoutLine } from '../checkout/checkout-session.entity';
import type { DeliveryDetails, ShippingQuote } from '../checkout/shipping';
export interface PaymentRecord {
  id: string;
  provider?: string;
  method?: string;
  optionId?: string;
  optionLabel?: string;
  simulated?: boolean;
  status:
    'pending' | 'unknown' | 'succeeded' | 'failed' | 'cancelled' | 'expired';
  amountCents: number;
  currency: string;
  paymentUrl: string | null;
  returnUrl: string;
  cancelRequested: boolean;
  nextCheckAt: number;
  retryCheckoutId?: string;
  lastFailure?: 'provider' | 'finalization' | null;
}
export interface OrderRecord {
  id: string;
  status: 'pending' | 'paid' | 'cancelled' | 'expired';
  createdAt: number;
  paidAt: number | null;
  items: CheckoutLine[];
  delivery: DeliveryDetails;
  shipping: ShippingQuote;
  totalCents: number;
  currency: string;
  sellerOrders: {
    id: string;
    sellerId: string;
    items: CheckoutLine[];
    shippingCents: number;
    totalCents: number;
    fulfillment: 'unfulfilled';
  }[];
  cleanup: 'pending' | 'cleared_or_preserved';
}
