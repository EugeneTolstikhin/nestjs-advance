// Provider-owned HTTP contract. No imports from the merchant application.
export type ProviderStatus =
  "pending" | "succeeded" | "failed" | "cancelled" | "expired";
export interface PaymentRequest {
  reference: string;
  amountCents: number;
  currency: string;
  expiresAt: number;
  returnUrl: string;
  method?: string;
}
export interface ProviderPayment extends PaymentRequest {
  status: ProviderStatus;
  paymentUrl: string;
}
