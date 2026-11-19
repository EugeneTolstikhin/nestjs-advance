import { Injectable, Module } from '@nestjs/common';
import { In } from 'typeorm';
import { AuthModule } from '../auth/auth.module';
import { UsersRepository } from '../auth/users.repository';
import { CheckoutSession } from '../checkout/checkout-session.entity';
import { ProductsModule } from '../products/products.module';
import { ProductsService } from '../products/products.service';
import { ProductMedia } from '../products/media/product-media.entity';

export function orderReference(id: string, createdAt: number): string {
  const date = new Date(createdAt)
    .toISOString()
    .slice(2, 10)
    .replaceAll('-', '');
  return `NS-${date}-${id.replaceAll('-', '').slice(0, 8).toUpperCase()}`;
}

/** Enrich paid snapshots with display names and available catalog thumbnails. */
@Injectable()
export class OrderPresentationService {
  constructor(
    private readonly products: ProductsService,
    private readonly users: UsersRepository,
  ) {}
  async describe(sessions: CheckoutSession[]) {
    const productIds = [
      ...new Set(
        sessions.flatMap(
          (session) => session.order?.items.map((item) => item.productId) ?? [],
        ),
      ),
    ];
    const sellerIds = [
      ...new Set(
        sessions.flatMap(
          (session) =>
            session.order?.sellerOrders.map((seller) => seller.sellerId) ?? [],
        ),
      ),
    ];
    const [media, names] = await Promise.all([
      productIds.length
        ? this.products.withStockTransaction((manager) =>
            manager.find(ProductMedia, {
              where: { productId: In(productIds), status: 'ready' },
              order: { position: 'ASC', id: 'ASC' },
            }),
          )
        : [],
      Promise.all(
        sellerIds.map(async (id) => {
          const user = await this.users.findById(id);
          return [
            id,
            user?.sellerProfile?.companyName?.trim() ||
              [user?.firstName, user?.lastName].filter(Boolean).join(' ') ||
              'Seller',
          ] as const;
        }),
      ),
    ]);
    const sellerNames = new Map(names);
    return sessions
      .filter((session) => session.order?.status === 'paid')
      .map((session) => {
        const order = session.order!;
        return {
          id: session.id,
          orderNumber: orderReference(order.id, order.createdAt),
          placedAt: order.paidAt ?? order.createdAt,
          dateLabel: new Intl.DateTimeFormat('en-GB', {
            dateStyle: 'long',
          }).format(order.paidAt ?? order.createdAt),
          totalCents: order.totalCents,
          totalFormatted: new Intl.NumberFormat('en-IE', {
            style: 'currency',
            currency: order.currency,
          }).format(order.totalCents / 100),
          sellers: order.sellerOrders.map((seller) => ({
            id: seller.id,
            sellerName: sellerNames.get(seller.sellerId) ?? 'Seller',
            fulfillment: seller.fulfillment,
            statusLabel:
              seller.fulfillment === 'unfulfilled'
                ? 'Preparing shipment'
                : seller.fulfillment.replaceAll('_', ' '),
            canReturn: seller.fulfillment === 'delivered',
            items: seller.items.map((item) => {
              const cover = media.find(
                (value) => value.productId === item.productId,
              );
              return {
                ...item,
                thumbnail: cover
                  ? `/media/files/${cover.id}${cover.kind === 'video' ? '/poster' : ''}`
                  : null,
                lineTotalFormatted: new Intl.NumberFormat('en-IE', {
                  style: 'currency',
                  currency: order.currency,
                }).format(item.lineTotalCents / 100),
              };
            }),
          })),
        };
      });
  }
}
@Module({
  imports: [AuthModule, ProductsModule],
  providers: [OrderPresentationService],
  exports: [OrderPresentationService],
})
export class OrderPresentationModule {}
