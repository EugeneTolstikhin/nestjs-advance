import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type {
  ProviderShipment,
  CarrierClaim,
} from '../orders/delivery-provider';

export type ReturnStatus =
  | 'requested'
  | 'approved'
  | 'rejected'
  | 'awaiting_shipment'
  | 'in_transit'
  | 'received'
  | 'under_review'
  | 'resolved';
export interface ReturnItem {
  productId: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  reason: string;
}
export interface InspectionItem {
  productId: string;
  received: number;
  sellable: number;
  restock: number;
  refund: number;
}
export interface ReturnMessage {
  id: string;
  at: number;
  author: 'buyer' | 'seller' | 'system';
  text: string;
}
export interface ReturnNotice {
  id: string;
  audience: 'buyer' | 'seller';
  text: string;
  status: 'pending' | 'sent' | 'logged' | 'skipped';
  lease?: string;
  leaseUntil?: number;
}
export interface ReturnData {
  items: ReturnItem[];
  history: ReturnMessage[];
  notifications: ReturnNotice[];
  provider: string;
  shipment: ProviderShipment | null;
  originalReference: string;
  inspection: {
    items: InspectionItem[];
    notes: string;
    discrepancy: boolean;
  } | null;
  buyerIssue: boolean;
  discrepancyResolved: boolean;
  shippingCents: number;
  shippingRefundCents: number;
  claim: { notes: string; result: CarrierClaim | null } | null;
  evidence: { id: string; author: 'buyer' | 'seller'; at: number }[];
  refund: {
    amountCents: number;
    status: 'pending' | 'succeeded' | 'failed';
    reference: string;
  } | null;
}

@Entity('order_returns')
@Index('IDX_return_buyer', ['buyerId'])
@Index('IDX_return_seller', ['sellerId'])
@Index('IDX_return_order', ['checkoutId', 'sellerOrderId'])
export class OrderReturn {
  @PrimaryColumn('text') id: string;
  @Column('text') checkoutId: string;
  @Column('text') sellerOrderId: string;
  @Column('text') buyerId: string;
  @Column('text') sellerId: string;
  @Column('text') kind: 'failed_delivery' | 'buyer_request';
  @Index('UQ_return_automatic', { unique: true })
  @Column('text', { nullable: true })
  automaticReference: string | null;
  @Column('text') status: ReturnStatus;
  @Column('integer', { default: 1 }) revision: number;
  @Column('integer') createdAt: number;
  @Column('integer', { default: 0 }) nextCheckAt: number;
  @Column('simple-json') data: ReturnData;
}
