import { Check, Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type { DeliveryDetails, ShippingQuote } from './shipping';

export interface CheckoutLine {
  productId: string;
  sellerId: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

@Entity('checkout_sessions')
@Index('IDX_checkout_expiry', ['status', 'expiresAt'])
@Check('CHK_checkout_status', "status IN ('reserved', 'cancelled', 'expired')")
export class CheckoutSession {
  @PrimaryColumn('text')
  id: string;
  
  @Index('IDX_checkout_buyer')
  @Column('text')
  buyerId: string;

  // A fixed deadline and one active session per buyer prevent duplicate holds.
  @Index('UQ_checkout_active_buyer', { unique: true })
  @Column('text', { nullable: true })
  activeBuyerId: string | null;

  @Column('text')
  status: 'reserved' | 'cancelled' | 'expired';

  @Column('integer')
  expiresAt: number;

  @Column('integer')
  createdAt: number;

  @Column('integer', { default: 1 })
  revision: number;

  @Column('integer', { default: 1 })
  machineVersion: number;

  @Column('simple-json')
  machineSnapshot: Record<string, unknown>;

  @Column('text')
  quoteHash: string;

  @Column('text')
  cartHash: string;

  @Column('simple-json')
  items: CheckoutLine[];

  @Column('integer')
  subtotalCents: number;

  @Column('text', { default: 'EUR' })
  currency: string;

  @Column('simple-json', { nullable: true })
  delivery: DeliveryDetails | null;

  @Column('simple-json', { nullable: true })
  shipping: ShippingQuote | null;
}

@Entity('stock_reservations')
@Check(
  'CHK_reservation_quantity',
  "typeof(quantity) = 'integer' AND quantity > 0 AND quantity <= 99",
)
export class StockReservation {
  @PrimaryColumn('text')
  checkoutId: string;

  @Index('IDX_reservation_product')
  @PrimaryColumn('text')
  productId: string;

  @Column('integer')
  quantity: number;
}
