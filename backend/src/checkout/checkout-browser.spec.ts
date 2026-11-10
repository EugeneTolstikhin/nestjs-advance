import { Window } from 'happy-dom';
import { clientScript } from '../../test/client-script';
const script = clientScript('checkout');
const line = {
  productId: 'product',
  name: 'Book',
  quantity: 2,
  unitPriceCents: 125,
  lineTotalCents: 250,
};
const preview = () => ({
  serverNow: Date.now(),
  quote: {
    quoteHash: 'a'.repeat(64),
    canReserve: true,
    items: [line],
    subtotalCents: 250,
    issues: [] as { message: string }[],
  },
  checkout: null,
});
const reservation = () => ({
  id: 'checkout',
  status: 'reserved',
  revision: 1,
  expiresAt: Date.now() + 900_000,
  serverNow: Date.now(),
  items: [line],
  subtotalCents: 250,
});
describe('Checkout browser UI', () => {
  let window: Window, fetchMock: ReturnType<typeof vi.fn>;
  const response = (body: unknown, status = 200) => ({
    ok: status < 400,
    status,
    json: async () => body,
  });
  const element = (id: string) =>
    window.document.getElementById(id)! as unknown as HTMLElement;
  beforeEach(() => {
    window = new Window({
      url: 'http://localhost:3000/checkout',
      settings: {
        enableJavaScriptEvaluation: true,
        suppressInsecureJavaScriptEnvironmentWarning: true,
      },
    });
    fetchMock = vi.fn().mockResolvedValue(response(preview()));
    window.fetch = fetchMock as unknown as Window['fetch'];
    window.document.body.innerHTML = `<main id="checkout-page"><li id="checkout-review-step"></li><li id="checkout-reserve-step"></li>
      <p id="checkout-status" role="status"></p><ul id="checkout-issues"></ul><section id="checkout-summary"><h2 id="checkout-summary-title" tabindex="-1">Review items</h2><ul id="checkout-items"></ul><strong id="checkout-total"></strong><button id="checkout-reserve">Reserve</button></section>
      <section id="checkout-reservation"><h2 id="checkout-reservation-title" tabindex="-1">Reserved</h2><strong id="checkout-countdown"></strong><button id="checkout-release">Release</button></section><button id="checkout-refresh">Refresh</button></main>`;
  });
  afterEach(async () => {
    window.dispatchEvent(new window.Event('pagehide'));
    await window.happyDOM.abort();
    window.close();
  });
  async function start() {
    window.eval(script);
    await vi.waitFor(() =>
      expect(element('checkout-total').textContent).toContain('2.50'),
    );
  }
  it('renders server prices and treats product names as text, without reserving on page load', async () => {
    const data = preview();
    data.quote.items = [{ ...line, name: '<img src=x onerror=alert(1)>' }];
    fetchMock.mockResolvedValue(response(data));
    await start();
    expect(element('checkout-items').textContent).toContain('<img');
    expect(element('checkout-items').querySelector('img')).toBeNull();
    expect(element('checkout-reserve').hidden).toBe(false);
    expect(fetchMock.mock.calls.every(([, options]) => !options.method)).toBe(
      true,
    );
  });
  it('submits only the quote hash and prevents duplicate reservation clicks', async () => {
    await start();
    fetchMock.mockResolvedValue(response(reservation()));
    element('checkout-reserve').click();
    element('checkout-reserve').click();
    await vi.waitFor(() =>
      expect(element('checkout-reservation').hidden).toBe(false),
    );
    const calls = fetchMock.mock.calls.filter(
      ([, options]) => options.method === 'POST',
    );
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0][1].body)).toEqual({ quoteHash: 'a'.repeat(64) });
    expect(calls[0][1].credentials).toBe('same-origin');
    expect(element('checkout-reserve').hidden).toBe(true);
    expect(element('checkout-countdown').textContent).toMatch(/^1[45]:/);
  });
  it('resumes a saved reservation without creating another hold', async () => {
    fetchMock.mockResolvedValue(
      response({ ...preview(), checkout: reservation() }),
    );
    await start();
    expect(element('checkout-reservation').hidden).toBe(false);
    expect(element('checkout-reserve').hidden).toBe(true);
    expect(element('checkout-reserve-step').getAttribute('aria-current')).toBe(
      'step',
    );
    expect(fetchMock.mock.calls).toHaveLength(1);
  });
  it('shows changed stock after a conflict instead of keeping an outdated reserve button', async () => {
    await start();
    const data = preview();
    data.quote.canReserve = false;
    data.quote.issues = [{ message: 'Only 0 units available.' }];
    fetchMock
      .mockResolvedValueOnce(response({ message: 'Your cart changed.' }, 409))
      .mockResolvedValue(response(data));
    element('checkout-reserve').click();
    await vi.waitFor(() =>
      expect(element('checkout-issues').textContent).toContain('0 units'),
    );
    expect(element('checkout-reserve').hidden).toBe(true);
    expect(element('checkout-status').textContent).toBe('Your cart changed.');
  });
  it('releases using the reservation revision and shows the unchanged cart quote afterward', async () => {
    fetchMock.mockResolvedValue(
      response({ ...preview(), checkout: reservation() }),
    );
    await start();
    fetchMock
      .mockResolvedValueOnce(
        response({ ...reservation(), status: 'cancelled', revision: 2 }),
      )
      .mockResolvedValue(response(preview()));
    element('checkout-release').click();
    await vi.waitFor(() =>
      expect(element('checkout-reserve').hidden).toBe(false),
    );
    const call = fetchMock.mock.calls.find(
      ([, options]) => options.method === 'DELETE',
    );
    expect(call![0]).toBe('/checkout/checkout');
    expect(JSON.parse(call![1].body)).toEqual({ revision: 1 });
    expect(element('checkout-items').textContent).toContain('Book');
  });
  it('ignores a stale preview arriving after a successful reservation', async () => {
    await start();
    let old!: (value: unknown) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          old = resolve;
        }),
    );
    window.dispatchEvent(new window.Event('focus'));
    fetchMock.mockResolvedValue(response(reservation()));
    element('checkout-reserve').click();
    await vi.waitFor(() =>
      expect(element('checkout-reservation').hidden).toBe(false),
    );
    old(response(preview()));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(element('checkout-reservation').hidden).toBe(false);
    expect(element('checkout-reserve').hidden).toBe(true);
  });
  it('keeps a failed cancellation visible after refreshing reservation status', async () => {
    fetchMock.mockResolvedValue(
      response({ ...preview(), checkout: reservation() }),
    );
    await start();
    fetchMock
      .mockResolvedValueOnce(
        response({ message: 'Release failed. Please retry.' }, 500),
      )
      .mockResolvedValue(response({ ...preview(), checkout: reservation() }));
    element('checkout-release').click();
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([path]) => path === '/checkout/data'),
      ).toHaveLength(2),
    );
    expect(element('checkout-reservation').hidden).toBe(false);
    expect(element('checkout-status').textContent).toBe(
      'Release failed. Please retry.',
    );
  });
  it('clears private checkout contents when the session expires and when leaving the page', async () => {
    await start();
    fetchMock.mockResolvedValue(response({ message: 'Unauthorized' }, 401));
    window.dispatchEvent(new window.Event('focus'));
    await vi.waitFor(() =>
      expect(element('checkout-summary').hidden).toBe(true),
    );
    expect(element('checkout-items').textContent).toBe('');
    expect(element('checkout-status').textContent).toContain('Log in');
    window.dispatchEvent(new window.Event('pagehide'));
    expect(element('checkout-reservation').hidden).toBe(true);
  });
});
