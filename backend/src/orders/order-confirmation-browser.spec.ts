import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { clientScript } from '../../test/client-script';

const script = clientScript('order-confirmation');
const data = () => ({
  orderId: 'paid-order',
  totalCents: 1499,
  preparing: false,
  recipient: 'buyer@example.test',
  emailConfigured: true,
  sellers: [
    {
      id: 'seller-order',
      totalCents: 1499,
      items: [
        {
          name: '<img src=x onerror=alert(1)>',
          quantity: 1,
          lineTotalCents: 1000,
        },
      ],
      invoice: { number: 'DEMO-SELLER', status: 'ready' },
      shipment: {
        trackingNumber: 'NS-123',
        status: 'in_transit',
        events: [{ sequence: 1, status: 'in_transit', occurredAt: Date.now() }],
      },
      notifications: [
        {
          kind: 'confirmation',
          status: 'sent',
          event: { status: 'label_created' },
        },
      ],
    },
  ],
});
describe('Order confirmation browser', () => {
  let window: Window, fetchMock: ReturnType<typeof vi.fn>;
  const response = (body: unknown, status = 200) => ({
    ok: status < 400,
    status,
    json: async () => body,
  });
  beforeEach(() => {
    window = new Window({
      url: 'http://localhost:3000/orders/checkout',
      settings: {
        enableJavaScriptEvaluation: true,
        suppressInsecureJavaScriptEnvironmentWarning: true,
      },
    });
    window.document.body.innerHTML = readFileSync(
      'src/views/order-confirmation.hbs',
      'utf8',
    )
      .replace(/<script[^>]*>[\s\S]*?<\/script>/g, '')
      .replace(/<link[^>]*>/g, '')
      .replace('{{checkoutId}}', 'checkout');
    fetchMock = vi.fn().mockResolvedValue(response(data()));
    window.fetch = fetchMock as unknown as Window['fetch'];
  });
  afterEach(async () => {
    window.dispatchEvent(new window.Event('pagehide'));
    await window.happyDOM.abort();
    window.close();
  });
  async function start() {
    window.eval(script);
    await vi.waitFor(() =>
      expect(
        window.document.getElementById('order-sellers')!.textContent,
      ).toContain('NS-123'),
    );
  }
  it('renders safe text, tracking history, delivery state and private invoice actions', async () => {
    await start();
    const root = window.document.getElementById('order-sellers')!;
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('<img');
    expect(root.textContent).toContain('in transit');
    expect(root.textContent).toContain('Invoice email: sent');
    expect(root.querySelector('a')!.getAttribute('href')).toBe(
      '/orders/checkout/invoices/seller-order',
    );
    expect(root.querySelectorAll('a')[1].getAttribute('href')).toBe(
      '/orders/checkout/invoices/seller-order?inline=1',
    );
    expect(fetchMock.mock.calls[0][1]).toEqual({
      credentials: 'same-origin',
      cache: 'no-store',
    });
  });
  it('updates on focus without replacing unchanged invoice actions', async () => {
    await start();
    const link = window.document.querySelector('#order-sellers a');
    window.dispatchEvent(new window.Event('focus'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.document.querySelector('#order-sellers a')).toBe(link);
    const next = data();
    next.sellers[0].shipment.status = 'delivered';
    fetchMock.mockResolvedValue(response(next));
    window.dispatchEvent(new window.Event('focus'));
    await vi.waitFor(() =>
      expect(
        window.document.getElementById('order-sellers')!.textContent,
      ).toContain('Status: delivered'),
    );
  });
  it('clears private information on session expiry and pagehide', async () => {
    await start();
    fetchMock.mockResolvedValue(response({}, 401));
    window.dispatchEvent(new window.Event('focus'));
    await vi.waitFor(() =>
      expect(
        window.document.getElementById('order-status')!.textContent,
      ).toContain('Log in'),
    );
    for (const id of ['order-sellers', 'order-reference', 'order-total'])
      expect(window.document.getElementById(id)!.textContent).toBe('');
    window.dispatchEvent(new window.Event('pagehide'));
    expect(window.document.getElementById('order-status')!.textContent).toBe(
      '',
    );
  });
});
