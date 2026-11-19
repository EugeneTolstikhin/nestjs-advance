import { Window } from 'happy-dom';
import { clientScript } from '../../test/client-script';
const script = clientScript('returns');
const record = () => ({
  id: 'return-id',
  checkoutId: 'checkout',
  sellerOrderId: 'seller',
  kind: 'buyer_request',
  status: 'requested',
  revision: 2,
  canReview: false,
  items: [
    {
      productId: 'product',
      name: '<img src=x onerror=alert(1)>',
      quantity: 1,
      unitPriceCents: 100,
      reason: 'Wrong size',
    },
  ],
  history: [],
  shipment: null,
  inspection: null,
  buyerIssue: false,
  claim: null,
  evidence: [],
  refund: null,
  shippingCents: 499,
});
describe('Return browser UI', () => {
  let window: Window, fetchMock: ReturnType<typeof vi.fn>;
  const response = (data: unknown, status = 200) => ({
    ok: status < 400,
    status,
    json: async () => data,
  });
  beforeEach(() => {
    window = new Window({
      url: 'http://localhost:3000/returns/return-id',
      settings: {
        enableJavaScriptEvaluation: true,
        suppressInsecureJavaScriptEnvironmentWarning: true,
      },
    });
    window.document.body.innerHTML =
      '<main id="returns-page" data-return-id="return-id"><p id="returns-status"></p><button id="returns-refresh">Refresh</button><div id="returns-content"></div></main>';
    fetchMock = vi.fn().mockResolvedValue(response(record()));
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
        window.document.querySelector('#returns-content')!.textContent,
      ).toContain('Wrong size'),
    );
  }
  it('renders private return text safely and shows seller approval controls only to a reviewer', async () => {
    await start();
    expect(window.document.querySelector('#returns-content img')).toBeNull();
    expect(window.document.body.textContent).not.toContain('Approve return');
    const next = record();
    next.canReview = true;
    fetchMock.mockResolvedValue(response(next));
    window.document.getElementById('returns-refresh')!.click();
    await vi.waitFor(() =>
      expect(window.document.body.textContent).toContain('Approve return'),
    );
  });
  it('submits seller decisions with the current revision and prevents duplicate clicks', async () => {
    const next = record();
    next.canReview = true;
    fetchMock.mockResolvedValue(response(next));
    await start();
    const form = [...window.document.querySelectorAll('form')].find((item) =>
      item.textContent.includes('Approve return'),
    )!;
    fetchMock.mockImplementation((path, options) =>
      options?.method === 'POST'
        ? new Promise(() => {})
        : Promise.resolve(response(next)),
    );
    form.dispatchEvent(new window.Event('submit', { cancelable: true }));
    form.dispatchEvent(new window.Event('submit', { cancelable: true }));
    const calls = fetchMock.mock.calls.filter(
      ([, options]) => options?.method === 'POST',
    );
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0][1].body)).toMatchObject({
      action: 'approve',
      revision: 2,
    });
    expect(calls[0][1].credentials).toBe('same-origin');
  });
  it('clears return details on expired access and page departure', async () => {
    await start();
    fetchMock.mockResolvedValue(
      response({ message: 'Log in to view returns' }, 401),
    );
    window.document.getElementById('returns-refresh')!.click();
    await vi.waitFor(() =>
      expect(
        window.document.getElementById('returns-content')!.textContent,
      ).toBe(''),
    );
    window.dispatchEvent(new window.Event('pagehide'));
    expect(window.document.getElementById('returns-status')!.textContent).toBe(
      '',
    );
  });
});
