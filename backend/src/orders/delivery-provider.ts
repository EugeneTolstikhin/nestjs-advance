import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { DeliveryStatus, TrackingEvent } from './order-confirmation.types';
export interface ShipmentRequest {
  reference: string;
  method: string;
  country: string;
  direction?: 'outbound' | 'return';
  relatedReference?: string;
}
export interface ProviderShipment extends ShipmentRequest {
  trackingNumber: string;
  status: DeliveryStatus;
  version: number;
  events: TrackingEvent[];
}
export interface CarrierClaim {
  reference: string;
  shipmentReference: string;
  status: 'open' | 'investigating' | 'approved' | 'rejected';
  resolution: string;
}
export interface ClaimRequest {
  reference: string;
  shipmentReference: string;
  notes: string;
}
export interface DeliveryProvider {
  create(request: ShipmentRequest): Promise<ProviderShipment>;
  get(reference: string): Promise<ProviderShipment>;
  createClaim?(request: ClaimRequest): Promise<CarrierClaim>;
  getClaim?(reference: string): Promise<CarrierClaim>;
}
const statuses = [
  'label_created',
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'delivery_failed',
  'returning_to_sender',
  'returned_to_sender',
  'cancelled',
];
class SimulatorDeliveryProvider implements DeliveryProvider {
  constructor(
    private readonly origin: string,
    private readonly secret: string,
  ) {}
  private async request(
    path: string,
    body?: ShipmentRequest,
  ): Promise<ProviderShipment> {
    const response = await fetch(this.origin + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${this.secret}`,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    if (!response.ok)
      throw new ServiceUnavailableException('Delivery provider is unavailable');
    const data: ProviderShipment = await response.json();
    if (
      !/^NS-[A-F0-9]{16}$/.test(data.trackingNumber) ||
      !Number.isSafeInteger(data.version) ||
      data.version < 1 ||
      !Array.isArray(data.events) ||
      data.events.length !== data.version ||
      data.events.length > 10000 ||
      !statuses.includes(data.status) ||
      data.events.some(
        (event, index) =>
          event.sequence !== index + 1 ||
          !statuses.includes(event.status) ||
          !Number.isSafeInteger(event.occurredAt),
      ) ||
      data.events.at(-1)?.status !== data.status
    )
      throw new ServiceUnavailableException(
        'Invalid delivery provider response',
      );
    return data;
  }
  private async claim(
    path: string,
    body?: ClaimRequest,
  ): Promise<CarrierClaim> {
    const response = await fetch(this.origin + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${this.secret}`,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    if (!response.ok)
      throw new ServiceUnavailableException(
        'Carrier claim service unavailable',
      );
    const result: CarrierClaim = await response.json();
    if (
      !['open', 'investigating', 'approved', 'rejected'].includes(
        result.status,
      ) ||
      typeof result.resolution !== 'string'
    ) {
      throw new ServiceUnavailableException('Invalid carrier claim response');
    }
    return result;
  }
  createClaim(request: ClaimRequest) {
    return this.claim('/api/claims', request);
  }
  getClaim(reference: string) {
    return this.claim(`/api/claims/${encodeURIComponent(reference)}`);
  }
  create(request: ShipmentRequest) {
    return this.request('/api/shipments', request);
  }
  get(reference: string) {
    return this.request(`/api/shipments/${encodeURIComponent(reference)}`);
  }
}
@Injectable()
export class DeliveryProviderFactory {
  readonly provider: string;
  private readonly adapters = new Map<string, DeliveryProvider>();
  get enabled() {
    return this.adapters.size > 0;
  }
  constructor() {
    this.provider = process.env.DELIVERY_PROVIDER ?? 'disabled';
    const builders: Record<string, () => DeliveryProvider> = {
      simulated: () => {
        if (process.env.NODE_ENV === 'production')
          throw new Error('Simulated delivery is development-only');
        const origin =
          process.env.DELIVERY_SIMULATOR_URL ?? 'http://localhost:4500';
        const url = new URL(origin);
        if (
          url.origin !== origin ||
          url.protocol !== 'http:' ||
          !['localhost', '127.0.0.1'].includes(url.hostname)
        )
          throw new Error('Delivery simulator must be a local HTTP origin');
        const secret = process.env.DELIVERY_SIMULATOR_SECRET;
        if (!secret || secret.length < 32)
          throw new Error('Configure DELIVERY_SIMULATOR_SECRET');
        return new SimulatorDeliveryProvider(origin, secret);
      },
    };
    if (this.provider !== 'disabled') {
      if (!Object.hasOwn(builders, this.provider))
        throw new Error('Unknown delivery provider');
      this.adapters.set(this.provider, builders[this.provider]());
    }
  }
  create(provider = this.provider) {
    const adapter = this.adapters.get(provider);
    if (!adapter)
      throw new ServiceUnavailableException(
        'Delivery provider is not configured',
      );
    return adapter;
  }
}
