import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type ProviderStatus =
  'pending' | 'succeeded' | 'failed' | 'cancelled' | 'expired';
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
export interface PaymentProvider {
  readonly simulated: boolean;
  supports(method: string): boolean;
  create(request: PaymentRequest): Promise<ProviderPayment>;
  get(reference: string): Promise<ProviderPayment>;
  cancel(reference: string): Promise<ProviderPayment>;
}

class SimulatorProvider implements PaymentProvider {
  readonly simulated = true;
  supports(method: string) {
    return /^[a-z][a-z0-9_]{1,39}$/.test(method);
  }
  constructor(
    private readonly url: string,
    private readonly key: string,
  ) {}
  private async request(
    path: string,
    body?: unknown,
  ): Promise<ProviderPayment> {
    const response = await fetch(`${this.url}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${this.key}`,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    if (!response.ok)
      throw new ServiceUnavailableException('Payment simulator is unavailable');
    const result: ProviderPayment = await response.json();
    if (
      !['pending', 'succeeded', 'failed', 'cancelled', 'expired'].includes(
        result.status,
      ) ||
      !Number.isSafeInteger(result.amountCents) ||
      result.currency !== 'EUR' ||
      new URL(result.paymentUrl).origin !== new URL(this.url).origin
    )
      throw new ServiceUnavailableException(
        'Invalid payment provider response',
      );
    return result;
  }
  create(request: PaymentRequest) {
    return this.request('/api/payments', request);
  }
  get(reference: string) {
    return this.request(`/api/payments/${encodeURIComponent(reference)}`);
  }
  cancel(reference: string) {
    return this.request(
      `/api/payments/${encodeURIComponent(reference)}/cancel`,
      {},
    );
  }
}

export interface PaymentOption {
  id: string;
  label: string;
  description: string;
  provider: string;
  method: string;
  enabled: boolean;
}

@Injectable()
export class PaymentProviderFactory {
  // Existing attempts use the provider saved with the intent, even when an option
  // is later hidden. Do not remove an adapter until its outstanding work settles.
  private readonly adapters = new Map<string, PaymentProvider>();
  private readonly configured: PaymentOption[];
  readonly shopOrigin: string;
  get enabled() {
    return this.adapters.size > 0;
  }
  constructor() {
    this.shopOrigin = process.env.SHOP_ORIGIN ?? 'http://localhost:3000';
    if (new URL(this.shopOrigin).origin !== this.shopOrigin)
      throw new Error('SHOP_ORIGIN must be an origin');
    const builders: Record<string, () => PaymentProvider> = {
      simulated: () => {
        if (process.env.NODE_ENV === 'production')
          throw new Error('Simulated payments are development-only');
        const url =
          process.env.PAYMENT_SIMULATOR_URL ?? 'http://localhost:4400';
        const parsed = new URL(url);
        if (
          !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
          parsed.origin !== url ||
          parsed.protocol !== 'http:'
        )
          throw new Error('Payment simulator must be a local HTTP origin');
        const key = process.env.PAYMENT_SIMULATOR_SECRET;
        if (!key || key.length < 32)
          throw new Error(
            'Set PAYMENT_SIMULATOR_SECRET to at least 32 random characters',
          );
        return new SimulatorProvider(url, key);
      },
      // Register another provider adapter here; checkout/jobs stay provider-agnostic.
    };
    const providers = (
      process.env.PAYMENT_PROVIDERS ??
      process.env.PAYMENT_PROVIDER ??
      'disabled'
    )
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value && value !== 'disabled');
    for (const provider of providers) {
      const builder = Object.hasOwn(builders, provider)
        ? builders[provider]
        : undefined;
      if (!builder) throw new Error(`Unknown payment provider: ${provider}`);
      this.adapters.set(provider, builder());
    }
    const config: unknown = JSON.parse(
      readFileSync(
        process.env.PAYMENT_OPTIONS_FILE ??
          join(__dirname, 'payment-options.json'),
        'utf8',
      ),
    );
    const ids = new Set<string>();
    const identifier = (value: unknown) =>
      typeof value === 'string' && /^[a-z][a-z0-9_]{1,39}$/.test(value);
    if (!Array.isArray(config))
      throw new Error('Payment options must be an array');
    for (const option of config) {
      if (
        !option ||
        !identifier(option.id) ||
        !identifier(option.provider) ||
        !identifier(option.method) ||
        typeof option.label !== 'string' ||
        !option.label.trim() ||
        option.label.length > 80 ||
        typeof option.description !== 'string' ||
        option.description.length > 250 ||
        typeof option.enabled !== 'boolean' ||
        ids.has(option.id)
      )
        throw new Error('Invalid or duplicate payment option');
      ids.add(option.id);
      const adapter = this.adapters.get(option.provider);
      if (option.enabled && adapter && !adapter.supports(option.method))
        throw new Error(
          'Provider does not support the configured payment method',
        );
    }
    this.configured = config;
  }
  options() {
    return this.configured
      .filter((option) => option.enabled && this.adapters.has(option.provider))
      .map((option) => ({
        id: option.id,
        label: option.label,
        description: option.description,
        simulated: this.adapters.get(option.provider)!.simulated,
      }));
  }
  option(id: string): PaymentOption {
    const option = this.configured.find(
      (option) =>
        option.id === id &&
        option.enabled &&
        this.adapters.has(option.provider),
    );
    if (!option)
      throw new BadRequestException('Choose an available payment option.');
    return option;
  }
  create(provider = 'simulated'): PaymentProvider {
    const adapter = this.adapters.get(provider);
    if (!adapter)
      throw new ServiceUnavailableException(
        'The payment provider is not configured.',
      );
    return adapter;
  }
}
