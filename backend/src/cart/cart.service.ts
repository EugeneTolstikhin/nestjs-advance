import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Products } from '../products/products.entity';
import { ProductMedia } from '../products/media/product-media.entity';
import { CartRepository, CART_MAX_PRODUCTS, CART_MAX_QUANTITY } from './cart.repository';
import type { StoredCart } from './cart.repository';

@Injectable()
export class CartService {
    constructor(private readonly carts: CartRepository,
        @InjectRepository(Products) private readonly products: Repository<Products>,
        @InjectRepository(ProductMedia) private readonly media: Repository<ProductMedia>) {}

    async get(userId: string) { return this.view(await this.carts.get(userId)); }
    async add(userId: string, id: string) {
        if (!await this.products.existsBy({ id })) throw new NotFoundException('This product is no longer available');
        return this.view(await this.carts.add(userId, id));
    }
    async change(userId: string, id: string, delta: -1 | 1) {
        return delta === 1 ? this.add(userId, id) : this.view(await this.carts.decrease(userId, id));
    }
    async remove(userId: string, id: string) {
        await this.carts.remove(userId, id);
        return this.get(userId);
    }
    private async view(cart: StoredCart | null) {
        const entries = Object.entries(cart?.items ?? {});
        const ids = entries.map(([id]) => id);
        const products = ids.length ? await this.products.findBy({ id: In(ids) }) : [];
        const media = ids.length ? await this.media.find({ where: { productId: In(ids), status: 'ready' }, order: { position: 'ASC' } }) : [];
        let totalCents = 0;
        const items = entries.map(([productId, quantity]) => {
            const product = products.find(item => item.id === productId);
            const cents = product ? Math.round(Number(product.price) * 100) : NaN;
            // Bound calculations so quantities and grand totals stay in safe integer cents.
            const available = !!product && Number.isSafeInteger(cents) && cents >= 0 &&
                cents <= Math.floor(Number.MAX_SAFE_INTEGER / (CART_MAX_PRODUCTS * CART_MAX_QUANTITY));
            const cover = media.find(item => item.productId === productId);
            const lineCents = available ? cents * quantity : 0;
            totalCents += lineCents;
            return { productId, name: product?.name ?? 'Unavailable product', quantity, available,
                unitPrice: available ? cents / 100 : null, lineTotal: available ? lineCents / 100 : null,
                thumbnail: available && cover ? `/media/files/${cover.id}${cover.kind === 'video' ? '/poster' : ''}` : null };
        });
        return { items, itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
            total: totalCents / 100, unavailableCount: items.filter(item => !item.available).length,
            maxQuantity: CART_MAX_QUANTITY, updatedAt: cart?.updatedAt ?? null };
    }
}
