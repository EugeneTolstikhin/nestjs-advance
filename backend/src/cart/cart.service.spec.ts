import { CartService } from './cart.service';

describe('Cart pricing and catalog changes', () => {
    let service: CartService;
    let carts: any, products: any, media: any;
    beforeEach(() => {
        carts = { get: vi.fn().mockResolvedValue({ items: { product: 3 } }), add: vi.fn() };
        products = { findBy: vi.fn().mockResolvedValue([{ id: 'product', name: 'Book', price: 0.1, stock: 10 }]), findOneBy: vi.fn().mockResolvedValue({ id: 'product', stock: 10 }) };
        media = { find: vi.fn().mockResolvedValue([]) };
        service = new CartService(carts, products, media);
    });
    it('calculates totals in integer cents using current server prices', async () => {
        const first = await service.get('buyer');
        expect(first.total).toBe(0.3); expect(first.items[0].lineTotal).toBe(0.3);
        products.findBy.mockResolvedValue([{ id: 'product', name: 'Book', price: 1.25, stock: 10 }]);
        expect((await service.get('buyer')).total).toBe(3.75);
        expect(carts.get).toHaveBeenCalledWith('buyer');
    });
    it('keeps deleted products removable and excludes them from totals', async () => {
        products.findBy.mockResolvedValue([]);
        const cart = await service.get('buyer');
        expect(cart.items[0]).toMatchObject({ productId: 'product', quantity: 3, available: false, unitPrice: null, lineTotal: null });
        expect(cart.unavailableCount).toBe(1); expect(cart.total).toBe(0);
    });
    it.each([NaN, Infinity, -1, Number.MAX_SAFE_INTEGER])('does not offer unsafe catalog price %s', async price => {
        products.findBy.mockResolvedValue([{ id: 'product', name: 'Book', price, stock: 10 }]);
        expect((await service.get('buyer')).items[0].available).toBe(false);
    });
    it('returns a new empty cart without querying catalog tables', async () => {
        carts.get.mockResolvedValue(null);
        expect(await service.get('buyer')).toMatchObject({ items: [], total: 0, itemCount: 0 });
        expect(products.findBy).not.toHaveBeenCalled(); expect(media.find).not.toHaveBeenCalled();
    });
    it('rejects additions of missing products before changing the stored cart', async () => {
        products.findOneBy.mockResolvedValue(null);
        await expect(service.add('buyer', 'deleted')).rejects.toMatchObject({ status: 404 });
        expect(carts.add).not.toHaveBeenCalled();
    });
    it('rejects out-of-stock additions and uses stock as the atomic per-cart limit', async () => {
        products.findOneBy.mockResolvedValue({ id: 'product', stock: 0 });
        await expect(service.add('buyer', 'product')).rejects.toMatchObject({ status: 409 });
        expect(carts.add).not.toHaveBeenCalled();
        products.findOneBy.mockResolvedValue({ id: 'product', stock: 2 });
        carts.add.mockResolvedValue({ items: { product: 2 } });
        await service.add('buyer', 'product');
        expect(carts.add).toHaveBeenCalledWith('buyer', 'product', 2);
    });
    it('keeps a saved quantity visible and warns if current stock is lower', async () => {
        products.findBy.mockResolvedValue([{ id: 'product', name: 'Book', price: 1, stock: 2 }]);
        const cart = await service.get('buyer');
        expect(cart.items[0]).toMatchObject({ quantity: 3, stock: 2, canIncrease: false });
        expect(cart.items[0].stockMessage).toContain('Reduce the quantity');
        products.findBy.mockResolvedValue([{ id: 'product', name: 'Book', price: 1, stock: 0 }]);
        expect((await service.get('buyer')).items[0]).toMatchObject({ available: false, canIncrease: false, lineTotal: null });
    });
});
