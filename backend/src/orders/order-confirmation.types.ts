export type DeliveryStatus =
  | 'label_created'
  | 'picked_up'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'delivery_failed'
  | 'returning_to_sender'
  | 'returned_to_sender'
  | 'cancelled';
export interface TrackingEvent {
  sequence: number;
  status: DeliveryStatus;
  occurredAt: number;
}
export interface Shipment {
  sellerOrderId: string;
  provider: string;
  reference: string;
  trackingNumber: string | null;
  status: DeliveryStatus | 'pending';
  version: number;
  events: TrackingEvent[];
}
export interface Invoice {
  sellerOrderId: string;
  number: string;
  status: 'pending' | 'ready';
}
export interface OrderNotification {
  id: string;
  sellerOrderId: string;
  sequence: number;
  kind: 'confirmation' | 'delivery';
  status: 'pending' | 'sent' | 'logged' | 'skipped';
  event: TrackingEvent;
  lease?: string | null;
  leaseUntil?: number;
  sentAt?: number;
}
export interface OrderConfirmation {
  recipient: string | null;
  invoices: Invoice[];
  shipments: Shipment[];
  notifications: OrderNotification[];
  nextCheckAt: number;
}

/** Fulfillment has finished; payment/refund decisions remain separate. */
export function isFinalDeliveryStatus(status: string): boolean {
  return ['delivered', 'cancelled', 'returned_to_sender'].includes(status);
}
