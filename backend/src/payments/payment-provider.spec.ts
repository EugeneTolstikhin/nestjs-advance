import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PaymentProviderFactory } from './payment-provider';

describe('Payment provider factory and configurable options', () => {
  let directory: string;
  const option = (id: string, enabled = true) => ({
    id,
    label: id,
    description: 'A development option',
    provider: 'simulated',
    method: id,
    enabled,
  });
  function configure(options: unknown) {
    writeFileSync(join(directory, 'options.json'), JSON.stringify(options));
  }
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'payment-options-'));
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('PAYMENT_PROVIDERS', 'simulated');
    vi.stubEnv('SHOP_ORIGIN', 'http://localhost:3000');
    vi.stubEnv('PAYMENT_SIMULATOR_URL', 'http://localhost:4400');
    vi.stubEnv(
      'PAYMENT_SIMULATOR_SECRET',
      'test-secret-with-at-least-32-characters',
    );
    vi.stubEnv('PAYMENT_OPTIONS_FILE', join(directory, 'options.json'));
    configure([option('card'), option('paypal'), option('bank_transfer')]);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });
  it('returns only public choices and routes multiple methods to the same provider', () => {
    const factory = new PaymentProviderFactory();
    expect(factory.options().map((value) => value.id)).toEqual([
      'card',
      'paypal',
      'bank_transfer',
    ]);
    expect(factory.options()[0]).toEqual({
      id: 'card',
      label: 'card',
      description: 'A development option',
      simulated: true,
    });
    expect(factory.option('paypal').method).toBe('paypal');
    expect(factory.create(factory.option('paypal').provider)).toBe(
      factory.create(factory.option('card').provider),
    );
  });
  it('adds, removes and disables methods through configuration without removing the adapter for existing attempts', () => {
    configure([option('new_wallet'), option('paypal', false)]);
    const factory = new PaymentProviderFactory();
    expect(factory.options().map((value) => value.id)).toEqual(['new_wallet']);
    expect(() => factory.option('paypal')).toThrow('available payment option');
    expect(() => factory.option('card')).toThrow('available payment option');
    expect(factory.create('simulated')).toBeDefined();
    expect(factory.create('simulated').supports('new_wallet')).toBe(true);
  });
  it('hides options for unconfigured providers and rejects unknown adapter registrations', () => {
    vi.stubEnv('PAYMENT_PROVIDERS', 'disabled');
    expect(new PaymentProviderFactory().options()).toEqual([]);
    vi.stubEnv('PAYMENT_PROVIDERS', 'nonexistent');
    expect(() => new PaymentProviderFactory()).toThrow(
      'Unknown payment provider',
    );
  });
  it('rejects duplicate or malformed configuration at startup', () => {
    for (const config of [
      [option('card'), option('card')],
      [{ ...option('card'), enabled: 'yes' }],
      [option('../escape')],
      {},
    ]) {
      configure(config);
      expect(() => new PaymentProviderFactory()).toThrow();
    }
  });
});
