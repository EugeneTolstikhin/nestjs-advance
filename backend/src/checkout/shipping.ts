// Local demo tariff, not a carrier integration. All sellers ship separately.
// Replace this quote function with a provider adapter when carrier rates exist.
import type { CheckoutLine } from './checkout-session.entity';
export interface DeliveryDetails {
  fullName: string;
  email?: string;
  phone?: string;
  addressLine1: string;
  addressLine2?: string;
  postalCode: string;
  city: string;
  country: 'DE';
}
export interface ShippingQuote {
  method: 'standard' | 'express';
  label: string;
  estimatedDelivery: string;
  shipments: { sellerId: string; feeCents: number }[];
  shippingCents: number;
}
export function shippingOptions(
  items: CheckoutLine[],
  country: string,
): ShippingQuote[] {
  if (country !== 'DE') return [];
  const sellers = [...new Set(items.map((item) => item.sellerId))].sort();
  return (
    [
      {
        method: 'standard',
        label: 'Standard delivery',
        estimatedDelivery: '3–5 business days (demo estimate)',
        feeCents: 499,
      },
      {
        method: 'express',
        label: 'Express delivery',
        estimatedDelivery: '1–2 business days (demo estimate)',
        feeCents: 999,
      },
    ] as const
  ).map(({ feeCents, ...option }) => ({
    ...option,
    shipments: sellers.map((sellerId) => ({ sellerId, feeCents })),
    shippingCents: sellers.length * feeCents,
  }));
}
