import { readFileSync } from 'node:fs';
import { Window, type HTMLInputElement as HappyInput } from 'happy-dom';
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
    window.document.body.innerHTML = readFileSync(
      'src/views/checkout.hbs',
      'utf8',
    )
      .replace(/<script[^>]*>[\s\S]*?<\/script>/g, '')
      .replace(/<link[^>]*>/g, '');
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
    expect(element('checkout-delivery-step').getAttribute('aria-current')).toBe(
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
  const delivery = {
    fullName: 'Buyer One',
    email: 'buyer@example.test',
    addressLine1: 'Street 12',
    postalCode: '10115',
    city: 'Berlin',
    country: 'DE',
  };
  const options = [
    {
      method: 'standard',
      label: 'Standard delivery',
      estimatedDelivery: '3–5 days',
      shipments: [{ sellerId: 'seller', feeCents: 499 }],
      shippingCents: 499,
    },
  ];
  function fillAddress() {
    for (const [name, value] of Object.entries(delivery)) {
      const input = window.document.querySelector(
        `[name="${name}"]`,
      ) as HappyInput;
      input.value = value;
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    }
  }
  function submit(id: string) {
    window.document
      .getElementById(id)!
      .dispatchEvent(
        new window.Event('submit', { bubbles: true, cancelable: true }),
      );
  }
  it('submits delivery with Enter/native submit, then shipping, and shows the server review without starting payment', async () => {
    fetchMock.mockResolvedValue(
      response({
        ...preview(),
        checkout: { ...reservation(), step: 'delivery' },
      }),
    );
    await start();
    expect(element('checkout-delivery').hidden).toBe(false);
    fillAddress();
    fetchMock.mockResolvedValueOnce(
      response({
        ...reservation(),
        step: 'shipping',
        revision: 2,
        delivery,
        shippingOptions: options,
      }),
    );
    submit('checkout-delivery-form');
    await vi.waitFor(() =>
      expect(element('checkout-shipping').hidden).toBe(false),
    );
    let call = fetchMock.mock.calls.find(([path]) =>
      path.endsWith('/delivery'),
    )!;
    expect(JSON.parse(call[1].body)).toEqual({ ...delivery, revision: 1 });
    expect(window.document.activeElement?.id).toBe('checkout-shipping-title');
    expect(element('checkout-shipping-options').textContent).toContain('4.99');
    (window.document.querySelector('[name="method"]') as HappyInput).checked =
      true;
    fetchMock.mockResolvedValueOnce(
      response({
        ...reservation(),
        step: 'review',
        revision: 3,
        delivery,
        shippingOptions: options,
        shipping: options[0],
        totalCents: 749,
      }),
    );
    submit('checkout-shipping-form');
    await vi.waitFor(() =>
      expect(element('checkout-final-review').hidden).toBe(false),
    );
    call = fetchMock.mock.calls.find(([path]) => path.endsWith('/shipping'))!;
    expect(JSON.parse(call[1].body)).toEqual({
      method: 'standard',
      revision: 2,
    });
    expect(element('checkout-review-total').textContent).toContain('7.49');
    expect(element('checkout-delivery-summary').textContent).toContain(
      delivery.email,
    );
    expect(window.document.activeElement?.id).toBe(
      'checkout-final-review-title',
    );
    expect(
      fetchMock.mock.calls.some(([path]) => /payment|confirm/.test(path)),
    ).toBe(false);
  });
  it('keeps an unsaved address and keyboard focus during polling, and preserves input on validation errors', async () => {
    const data = {
      ...preview(),
      checkout: { ...reservation(), step: 'delivery' },
    };
    fetchMock.mockResolvedValue(response(data));
    await start();
    fillAddress();
    const input = window.document.querySelector('[name="city"]') as HappyInput;
    input.value = 'Hamburg';
    input.focus();
    window.dispatchEvent(new window.Event('focus'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(input.value).toBe('Hamburg');
    expect(window.document.activeElement?.getAttribute('name')).toBe('city');
    fetchMock.mockResolvedValueOnce(
      response({ message: 'Invalid delivery address' }, 400),
    );
    submit('checkout-delivery-form');
    await vi.waitFor(() =>
      expect(element('checkout-status').textContent).toContain(
        'Invalid delivery',
      ),
    );
    expect(input.value).toBe('Hamburg');
    expect(element('checkout-delivery').hidden).toBe(false);
  });
  it('requires at least one contact, supports phone-only checkout, and prevents duplicate submits', async () => {
    fetchMock.mockResolvedValue(
      response({
        ...preview(),
        checkout: { ...reservation(), step: 'delivery' },
      }),
    );
    await start();
    fillAddress();
    const email = window.document.querySelector('[name="email"]') as HappyInput;
    email.value = '';
    submit('checkout-delivery-form');
    expect(
      fetchMock.mock.calls.filter(([path]) => path.endsWith('/delivery')),
    ).toHaveLength(0);
    const phone = window.document.querySelector('[name="phone"]') as HappyInput;
    phone.value = '+4917612345678';
    phone.dispatchEvent(new window.Event('input', { bubbles: true }));
    fetchMock.mockResolvedValueOnce(
      response({
        ...reservation(),
        revision: 2,
        step: 'shipping',
        delivery: { ...delivery, email: undefined, phone: phone.value },
        shippingOptions: options,
      }),
    );
    submit('checkout-delivery-form');
    submit('checkout-delivery-form');
    await vi.waitFor(() =>
      expect(element('checkout-shipping').hidden).toBe(false),
    );
    const calls = fetchMock.mock.calls.filter(([path]) =>
      path.endsWith('/delivery'),
    );
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0][1].body).email).toBeUndefined();
    expect(JSON.parse(calls[0][1].body).phone).toBe('+4917612345678');
  });
  it('resumes review, safely renders delivery text, navigates back and clears private form data on logout', async () => {
    const saved = {
      ...reservation(),
      revision: 3,
      step: 'review',
      delivery: { ...delivery, fullName: '<img src=x>' },
      shipping: options[0],
      shippingOptions: options,
      totalCents: 749,
    };
    fetchMock.mockResolvedValue(response({ ...preview(), checkout: saved }));
    await start();
    expect(element('checkout-final-review').hidden).toBe(false);
    expect(
      element('checkout-delivery-summary').querySelector('img'),
    ).toBeNull();
    fetchMock.mockResolvedValueOnce(
      response({ ...saved, step: 'shipping', revision: 4 }),
    );
    (
      element('checkout-final-review').querySelector(
        '[data-checkout-back]',
      ) as HTMLElement
    ).click();
    await vi.waitFor(() =>
      expect(element('checkout-shipping').hidden).toBe(false),
    );
    const call = fetchMock.mock.calls.find(([path]) => path.endsWith('/back'))!;
    expect(JSON.parse(call[1].body)).toEqual({ revision: 3 });
    fetchMock.mockResolvedValue(response({ message: 'Unauthorized' }, 401));
    window.dispatchEvent(new window.Event('focus'));
    await vi.waitFor(() =>
      expect(element('checkout-reservation').hidden).toBe(true),
    );
    expect(element('checkout-delivery-summary').textContent).toBe('');
    expect(
      (window.document.querySelector('[name="fullName"]') as HappyInput).value,
    ).toBe('');
  });
});
