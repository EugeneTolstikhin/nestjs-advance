import { CartService } from './cart.service';

describe('Cart pricing and catalog changes', () => {
    let service: CartService;
    let carts: any, products: any, media: any;
    beforeEach(() => {
        carts = { get: vi.fn().mockResolvedValue({ items: { product: 3 } }), add: vi.fn() };
        products = { findBy: vi.fn().mockResolvedValue([{ id: 'product', name: 'Book', price: 0.1 }]), existsBy: vi.fn().mockResolvedValue(true) };
        media = { find: vi.fn().mockResolvedValue([]) };
        service = new CartService(carts, products, media);
    });
    it('calculates totals in integer cents using current server prices', async () => {
        const first = await service.get('buyer');
        expect(first.total).toBe(0.3); expect(first.items[0].lineTotal).toBe(0.3);
        products.findBy.mockResolvedValue([{ id: 'product', name: 'Book', price: 1.25 }]);
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
        products.findBy.mockResolvedValue([{ id: 'product', name: 'Book', price }]);
        expect((await service.get('buyer')).items[0].available).toBe(false);
    });
    it('returns a new empty cart without querying catalog tables', async () => {
        carts.get.mockResolvedValue(null);
        expect(await service.get('buyer')).toMatchObject({ items: [], total: 0, itemCount: 0 });
        expect(products.findBy).not.toHaveBeenCalled(); expect(media.find).not.toHaveBeenCalled();
    });
    it('rejects additions of missing products before changing the stored cart', async () => {
        products.existsBy.mockResolvedValue(false);
        await expect(service.add('buyer', 'deleted')).rejects.toMatchObject({ status: 404 });
        expect(carts.add).not.toHaveBeenCalled();
    });
});
