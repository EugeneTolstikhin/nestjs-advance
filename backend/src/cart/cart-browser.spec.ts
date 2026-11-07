import { clientScript } from '../../test/client-script';
import { Window } from 'happy-dom';

const script = clientScript('cart');
const id = '16927ce4-d7a2-4bca-925f-4b884d6087ac';
const empty = { items: [], itemCount: 0, total: 0, unavailableCount: 0, maxQuantity: 99 };
const cart = (quantity = 1, name = 'Book') => ({ ...empty, items: [{ productId: id, quantity, name, available: true,
    unitPrice: 0.1, lineTotal: quantity / 10 }], itemCount: quantity, total: quantity / 10 });

describe('Shopping cart browser behavior', () => {
    let window: Window;
    let fetchMock: ReturnType<typeof vi.fn>;
    const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
    beforeEach(() => {
        window = new Window({ url: 'http://localhost:3000/cart', settings: {
            enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true,
        } });
        fetchMock = vi.fn().mockResolvedValue(response(empty)); window.fetch = fetchMock;
    });
    afterEach(async () => { window.dispatchEvent(new window.Event('pagehide')); await window.happyDOM.abort(); window.close(); });
    function start(buyer = true) {
        window.document.body.innerHTML = buyer ? `<section id="shopping-cart"><p id="cart-status" role="status"></p>
            <div id="cart-empty" tabindex="-1">Your shopping cart is empty</div>
            <ul id="cart-items"></ul><section id="cart-summary"><p id="cart-item-count"></p><span id="cart-total"></span>
            <p id="cart-unavailable"></p></section></section>`
            : `<article class="product"><h2>Book</h2><div class="product-actions"><button data-add-to-cart="${id}">Add to cart</button><a href="/cart" data-view-cart hidden>View cart</a></div><p data-cart-notice role="status"></p></article>`;
        window.eval(script);
    }
    const click = (selector: string) => (window.document.querySelector(selector) as any).click();
    it.each([401, 403])('explains catalog add restrictions for HTTP %s', async status => {
        fetchMock.mockResolvedValue(response({ message: 'Access denied' }, status)); start(false);
        click('[data-add-to-cart]');
        await vi.waitFor(() => expect(window.document.querySelector('[data-cart-notice] a')).not.toBeNull());
        expect(window.document.querySelector('[data-cart-notice]')!.textContent).toContain(status === 401 ? 'Log in' : 'buyer profile');
        expect(window.document.querySelector('[data-cart-notice] a')!.getAttribute('href')).toBe(status === 401 ? '/auth/login' : '/account');
        expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'same-origin', method: 'POST', body: '{}' });
    });
    it('adds from the catalog and links to the saved cart', async () => {
        fetchMock.mockResolvedValue(response(cart())); start(false); click('[data-add-to-cart]');
        await vi.waitFor(() => expect(window.document.querySelector('[data-cart-notice]')!.textContent).toContain('Book added'));
        const link = window.document.querySelector('[data-view-cart]') as any;
        expect(link.getAttribute('href')).toBe('/cart');
        expect(link.hidden).toBe(false);
        expect(link.parentElement.className).toBe('product-actions');
        expect(window.document.querySelector('[data-cart-notice] a')).toBeNull();
    });
    it('shows an empty cart and refreshes when another device has added an item', async () => {
        start(); await vi.waitFor(() => expect(window.document.getElementById('cart-summary')!.hidden).toBe(true));
        fetchMock.mockResolvedValue(response(cart())); window.dispatchEvent(new window.Event('focus'));
        await vi.waitFor(() => expect(window.document.querySelectorAll('[data-cart-item]')).toHaveLength(1));
        expect(window.document.getElementById('cart-empty')!.hidden).toBe(true);
        expect(window.document.getElementById('cart-total')!.textContent).toBe('0.10€');
        expect(window.document.querySelector('.cart-item-details')!.textContent).toContain('Unit price: 0.10€');
        expect(window.document.querySelector('.cart-item-details')!.textContent).toContain('Subtotal: 0.10€');
    });
    it('renders product names as text and removes the last item with keyboard focus preserved', async () => {
        fetchMock.mockResolvedValue(response(cart(1, '<img src=x onerror=alert(1)>'))); start();
        await vi.waitFor(() => expect(window.document.querySelector('[data-cart-action="remove"]')).not.toBeNull());
        expect(window.document.querySelector('.cart-item h2')!.textContent).toContain('<img');
        expect(window.document.querySelectorAll('img')).toHaveLength(0);
        fetchMock.mockResolvedValue(response(empty));
        const remove = window.document.querySelector('[data-cart-action="remove"]') as any; remove.focus(); remove.click();
        await vi.waitFor(() => expect(window.document.querySelectorAll('[data-cart-item]')).toHaveLength(0));
        expect(window.document.getElementById('cart-empty')!.hidden).toBe(false);
        expect(window.document.activeElement!.id).toBe('cart-empty');
        expect(fetchMock.mock.calls.at(-1)![1].method).toBe('DELETE');
    });
    it('ignores a stale refresh response which arrives after a quantity update', async () => {
        fetchMock.mockResolvedValue(response(cart())); start();
        await vi.waitFor(() => expect(window.document.querySelector('[data-cart-action="increase"]')).not.toBeNull());
        let resolveOld!: (value: unknown) => void;
        fetchMock.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
        window.dispatchEvent(new window.Event('focus'));
        fetchMock.mockResolvedValue(response(cart(2))); click('[data-cart-action="increase"]');
        await vi.waitFor(() => expect(window.document.querySelector('.cart-quantity')!.textContent).toBe('2'));
        resolveOld(response(cart(1)));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(window.document.querySelector('.cart-quantity')!.textContent).toBe('2');
        expect(window.document.getElementById('cart-total')!.textContent).toBe('0.20€');
        expect(fetchMock.mock.calls.at(-1)![1].body).toBe('{"delta":1}');
    });
    it('updates quantities without replacing rows, images, controls or the success message', async () => {
        const withImage = (quantity: number) => {
            const view = cart(quantity);
            return { ...view, items: view.items.map(item => ({ ...item, thumbnail: '/media/book.jpg' })) };
        };
        fetchMock.mockResolvedValue(response(withImage(1))); start();
        await vi.waitFor(() => expect(window.document.querySelector('.cart-image')).not.toBeNull());
        const row = window.document.querySelector('[data-cart-item]');
        const image = window.document.querySelector('.cart-image');
        const increase = window.document.querySelector('[data-cart-action="increase"]') as any;
        increase.focus();
        fetchMock.mockResolvedValue(response(withImage(2))); increase.click();
        const status = window.document.getElementById('cart-status')!;
        await vi.waitFor(() => expect(status.textContent).toBe('Cart quantity updated.'));
        const message = status.firstChild;
        let finish!: (value: unknown) => void;
        fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        increase.click();
        expect(status.textContent).toBe('Cart quantity updated.');
        expect(window.document.getElementById('shopping-cart')!.getAttribute('aria-busy')).toBe('true');
        expect(increase.disabled).toBe(true);
        finish(response(withImage(3)));
        await vi.waitFor(() => expect(window.document.querySelector('.cart-quantity')!.textContent).toBe('3'));
        expect(status.firstChild).toBe(message);
        expect(window.document.querySelector('[data-cart-item]')).toBe(row);
        expect(window.document.querySelector('.cart-image')).toBe(image);
        expect(window.document.querySelector('[data-cart-action="increase"]')).toBe(increase);
        expect(window.document.activeElement).toBe(increase);
        expect(window.document.getElementById('cart-total')!.textContent).toBe('0.30€');
        expect(increase.disabled).toBe(false);
    });
    it('clears private cart contents if the session expires', async () => {
        fetchMock.mockResolvedValue(response(cart())); start();
        await vi.waitFor(() => expect(window.document.querySelectorAll('[data-cart-item]')).toHaveLength(1));
        fetchMock.mockResolvedValue(response({ message: 'Expired' }, 401)); window.dispatchEvent(new window.Event('focus'));
        await vi.waitFor(() => expect(window.document.querySelectorAll('[data-cart-item]')).toHaveLength(0));
        expect(window.document.getElementById('cart-summary')!.hidden).toBe(true);
        expect(window.document.getElementById('cart-status')!.textContent).toContain('Log in');
    });
});
