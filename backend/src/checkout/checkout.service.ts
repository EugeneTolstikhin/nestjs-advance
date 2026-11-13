import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { In, LessThanOrEqual, type EntityManager } from 'typeorm';
import { createActor, type SnapshotFrom } from 'xstate';
import {
  CartRepository,
  CART_MAX_PRODUCTS,
  CART_MAX_QUANTITY,
  type StoredCart,
} from '../cart/cart.repository';
import { ProductsService } from '../products/products.service';
import { Products } from '../products/products.entity';
import {
  CheckoutSession,
  StockReservation,
  type CheckoutLine,
} from './checkout-session.entity';
import { checkoutMachine, type CheckoutEvent } from './checkout.machine';
import { reservedQuantities } from './stock-availability';
import { DeliveryDetailsDto, SelectShippingDto } from './checkout-details.dto';
import { shippingOptions, type DeliveryDetails } from './shipping';
import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';

export const RESERVATION_MS = 15 * 60_000;
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);
  constructor(
    private readonly carts: CartRepository,
    private readonly products: ProductsService,
  ) {}

  async preview(buyerId: string) {
    const cart = await this.carts.get(buyerId);
    return this.products.withStockTransaction(async (manager) => {
      await this.expire(manager);
      const active = await manager.findOneBy(CheckoutSession, {
        activeBuyerId: buyerId,
      });
      const quote = await this.quote(manager, cart, active?.id);
      return {
        serverNow: Date.now(),
        quote,
        checkout: active ? this.view(active) : null,
      };
    });
  }

  async reserve(buyerId: string, quoteHash: string) {
    const cart = await this.carts.get(buyerId);
    const result = await this.products.withStockTransaction((manager) =>
      this.reserveCart(manager, buyerId, quoteHash, cart),
    );
    this.logger.log(`Checkout ${result.id}: reservation confirmed`);
    return result;
  }

  private async reserveCart(
    manager: EntityManager,
    buyerId: string,
    quoteHash: string,
    cart: StoredCart | null,
  ) {
    const now = Date.now();
    await this.expire(manager, now);
    const active = await manager.findOneBy(CheckoutSession, {
      activeBuyerId: buyerId,
    });
    if (active) {
      if (active.quoteHash !== quoteHash)
        throw new ConflictException(
          'You already have a reservation. Release it before checking out a different cart.',
        );
      return this.view(active); // Idempotent retries never extend the fixed deadline.
    }
    const quote = await this.quote(manager, cart);
    if (quote.issues.length)
      throw new ConflictException({
        message: 'Your cart needs attention before items can be reserved.',
        issues: quote.issues,
      });
    if (quote.quoteHash !== quoteHash)
      throw new ConflictException(
        'Your cart or prices changed. Refresh and review the updated items before reserving.',
      );
    const session = manager.create(CheckoutSession, {
      id: randomUUID(),
      buyerId,
      activeBuyerId: buyerId,
      status: 'reserved',
      expiresAt: now + RESERVATION_MS,
      createdAt: now,
      revision: 1,
      machineVersion: 1,
      cartRevision: cart?.revision ?? 0,
      quoteHash,
      cartHash: quote.cartHash,
      items: quote.items,
      subtotalCents: quote.subtotalCents,
      currency: 'EUR',
    });
    const actor = createActor(checkoutMachine, {
      input: { checkoutId: session.id, buyerId },
      logger: () => {},
    }).start();
    try {
      actor.send({ type: 'START' });
      actor.send({ type: 'CART_VALIDATED' });
      session.machineSnapshot = JSON.parse(
        JSON.stringify(actor.getPersistedSnapshot()),
      );
      await manager.save(CheckoutSession, session);
      // The shared SQLite write transaction includes every reservation line.
      // Availability was checked in this transaction; no partial hold can commit.
      await manager.insert(
        StockReservation,
        quote.items.map((item) => ({
          checkoutId: session.id,
          productId: item.productId,
          quantity: item.quantity,
        })),
      );
      actor.send({ type: 'STOCK_RESERVED' });
      session.machineSnapshot = JSON.parse(
        JSON.stringify(actor.getPersistedSnapshot()),
      );
      await manager.save(CheckoutSession, session);
    } finally {
      actor.stop();
    }
    return this.view(session);
  }

  async retry(
    buyerId: string,
    id: string,
    revision: number,
    quoteHash: string,
  ) {
    const cart = await this.carts.get(buyerId);
    return this.products.withStockTransaction(async (manager) => {
      await this.expire(manager);
      const previous = await this.owned(manager, buyerId, id);
      if (
        !previous.payment ||
        !['failed', 'cancelled', 'expired'].includes(previous.payment.status) ||
        !['cancelled', 'expired'].includes(previous.status) ||
        previous.order?.status === 'paid'
      )
        throw new ConflictException(
          'Wait for a confirmed decline, cancellation or expiry before trying another payment.',
        );
      // A lost response or another device must resume the same replacement checkout.
      if (previous.payment.retryCheckoutId)
        return this.view(
          await this.owned(manager, buyerId, previous.payment.retryCheckoutId),
        );
      if (previous.revision !== revision)
        throw new ConflictException(
          'Checkout changed. Refresh before retrying.',
        );
      if (await manager.findOneBy(CheckoutSession, { activeBuyerId: buyerId }))
        throw new ConflictException(
          'You already have an active checkout. Resume it before starting another.',
        );
      const reserved = await this.reserveCart(
        manager,
        buyerId,
        quoteHash,
        cart,
      );
      const next = await this.owned(manager, buyerId, reserved.id);
      // Preserve saved delivery choices, but recompute shipping for the current
      // cart/sellers/rates and return to review. No payment is started here.
      if (previous.delivery) {
        next.delivery = previous.delivery;
        this.transition(next, [{ type: 'DELIVERY_ACCEPTED' }]);
        const shipping =
          previous.shipping &&
          shippingOptions(next.items, next.delivery.country).find(
            (option) => option.method === previous.shipping!.method,
          );
        if (shipping) {
          next.shipping = shipping;
          this.transition(next, [{ type: 'SHIPPING_SELECTED' }]);
        }
      }
      previous.payment.retryCheckoutId = next.id;
      previous.revision++;
      await manager.save(CheckoutSession, [previous, next]);
      return this.view(next);
    });
  }

  async get(buyerId: string, id: string) {
    return this.products.withStockTransaction(async (manager) => {
      await this.expire(manager);
      return this.view(await this.owned(manager, buyerId, id));
    });
  }

  async cancel(buyerId: string, id: string, revision: number) {
    return this.products.withStockTransaction(async (manager) => {
      await this.expire(manager);
      const session = await this.owned(manager, buyerId, id);
      if (session.status !== 'reserved') return this.view(session);
      if (
        session.payment &&
        ['pending', 'unknown'].includes(session.payment.status)
      ) {
        if (session.revision !== revision)
          throw new ConflictException('Refresh checkout before cancelling.');
        session.payment.cancelRequested = true;
        session.payment.nextCheckAt = Date.now();
        session.revision++;
        await manager.save(CheckoutSession, session);
        return this.view(session);
      }
      if (session.revision !== revision)
        throw new ConflictException(
          'This checkout changed. Refresh before cancelling.',
        );
      this.transition(session, [
        { type: 'CANCEL' },
        { type: 'RESERVATION_RELEASED' },
      ]);
      session.status = 'cancelled';
      session.activeBuyerId = null;
      session.revision++;
      await manager.delete(StockReservation, { checkoutId: id });
      await manager.save(CheckoutSession, session);
      return this.view(session);
    });
  }

  async saveDelivery(buyerId: string, id: string, body: DeliveryDetailsDto) {
    // Validate again at the service boundary, including internal/non-HTTP callers.
    const normalized = Object.fromEntries(
      Object.entries(body).map(([key, value]) => [
        key,
        typeof value === 'string' ? value.trim() : value,
      ]),
    );
    const dto = plainToInstance(DeliveryDetailsDto, normalized);
    if (
      validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).length
    )
      throw new BadRequestException(
        'Provide a name, a complete German delivery address and at least one valid email or phone number.',
      );
    return this.updateDetails(buyerId, id, dto.revision, (session) => {
      if (session.machineSnapshot.value !== 'delivery')
        throw new ConflictException(
          'Return to delivery details before editing the address.',
        );
      const { revision: _revision, ...delivery } = dto;
      session.delivery = delivery as DeliveryDetails;
      session.shipping = null; // Address changes invalidate any previously selected tariff.
      this.transition(session, [{ type: 'DELIVERY_ACCEPTED' }]);
    });
  }

  async selectShipping(buyerId: string, id: string, body: SelectShippingDto) {
    return this.updateDetails(buyerId, id, body.revision, (session) => {
      if (session.machineSnapshot.value !== 'shipping' || !session.delivery)
        throw new ConflictException(
          'Save delivery details before selecting shipping.',
        );
      const selected = shippingOptions(
        session.items,
        session.delivery.country,
      ).find((option) => option.method === body.method);
      if (!selected)
        throw new BadRequestException('Choose an available shipping method.');
      session.shipping = selected;
      this.transition(session, [{ type: 'SHIPPING_SELECTED' }]);
    });
  }

  async back(buyerId: string, id: string, revision: number) {
    return this.updateDetails(buyerId, id, revision, (session) => {
      this.transition(session, [{ type: 'BACK' }]);
    });
  }

  private async updateDetails(
    buyerId: string,
    id: string,
    revision: number,
    change: (session: CheckoutSession) => void,
  ) {
    // Commit expiry cleanup even when the requested edit must subsequently fail.
    const result = await this.products.withStockTransaction(async (manager) => {
      await this.expire(manager);
      const session = await this.owned(manager, buyerId, id);
      if (session.status !== 'reserved') return null;
      if (session.revision !== revision)
        throw new ConflictException(
          'Checkout changed on another device. Refresh and review before continuing.',
        );
      change(session);
      session.revision++;
      await manager.save(CheckoutSession, session);
      return this.view(session);
    });
    if (!result)
      throw new ConflictException(
        'This reservation expired or was released. Return to your cart.',
      );
    return result;
  }

  private async owned(manager: EntityManager, buyerId: string, id: string) {
    const session = await manager.findOneBy(CheckoutSession, { id, buyerId });
    if (!session) throw new NotFoundException('Checkout not found');
    return session;
  }

  transition(session: CheckoutSession, events: CheckoutEvent[]) {
    if (session.machineVersion !== 1)
      throw new ConflictException('Unsupported checkout version');
    const actor = createActor(checkoutMachine, {
      input: { checkoutId: session.id, buyerId: session.buyerId },
      snapshot: session.machineSnapshot as unknown as SnapshotFrom<
        typeof checkoutMachine
      >,
      logger: () => {},
    }).start();
    try {
      for (const event of events) {
        if (!actor.getSnapshot().can(event))
          throw new ConflictException(
            'This checkout transition is not available',
          );
        actor.send(event);
      }
      session.machineSnapshot = JSON.parse(
        JSON.stringify(actor.getPersistedSnapshot()),
      );
    } finally {
      actor.stop();
    }
  }

  private async expire(manager: EntityManager, now = Date.now()) {
    const sessions = await manager.find(CheckoutSession, {
      where: { status: 'reserved', expiresAt: LessThanOrEqual(now) },
    });
    for (const session of sessions) {
      // An uncertain provider result pins stock until authenticated reconciliation.
      if (
        session.payment &&
        ['pending', 'unknown'].includes(session.payment.status)
      )
        continue;
      this.transition(session, [{ type: 'RESERVATION_EXPIRED' }]);
      session.status = 'expired';
      session.activeBuyerId = null;
      session.revision++;
      await manager.delete(StockReservation, { checkoutId: session.id });
      await manager.save(CheckoutSession, session);
    }
  }

  private async quote(
    manager: EntityManager,
    cart: StoredCart | null,
    exceptCheckout?: string,
  ) {
    const entries = Object.entries(cart?.items ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    const issues: { productId?: string; message: string }[] = [];
    const items: CheckoutLine[] = [];
    if (!entries.length)
      issues.push({ message: 'Your cart is empty. Add some products first.' });
    if (entries.length > CART_MAX_PRODUCTS)
      issues.push({ message: 'Your cart has too many different products.' });
    const ids = entries.map(([id]) => id);
    const products = ids.length
      ? await manager.findBy(Products, { id: In(ids) })
      : [];
    const reserved = await reservedQuantities(
      manager,
      ids,
      Date.now(),
      exceptCheckout,
    );
    let subtotalCents = 0;
    for (const [productId, quantity] of entries) {
      const product = products.find((item) => item.id === productId);
      if (!product) {
        issues.push({
          productId,
          message: 'A product was removed. Remove it from your cart.',
        });
        continue;
      }
      if (
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > CART_MAX_QUANTITY
      ) {
        issues.push({
          productId,
          message: `${product.name}: invalid quantity.`,
        });
        continue;
      }
      if (!product.sellerId) {
        issues.push({
          productId,
          message: `${product.name}: a seller must be assigned before checkout.`,
        });
        continue;
      }
      const available = Math.max(
        0,
        product.stock - (reserved.get(productId) ?? 0),
      );
      if (available < quantity)
        issues.push({
          productId,
          message: `${product.name}: only ${available} units are currently available. Reduce the quantity or try again later.`,
        });
      const cents = Math.round(Number(product.price) * 100);
      if (
        !Number.isSafeInteger(cents) ||
        cents < 0 ||
        cents >
          Math.floor(
            Number.MAX_SAFE_INTEGER / (CART_MAX_PRODUCTS * CART_MAX_QUANTITY),
          )
      ) {
        issues.push({
          productId,
          message: `${product.name}: the price is unavailable.`,
        });
        continue;
      }
      const lineTotalCents = cents * quantity;
      subtotalCents += lineTotalCents;
      items.push({
        productId,
        sellerId: product.sellerId,
        name: product.name,
        quantity,
        unitPriceCents: cents,
        lineTotalCents,
      });
    }
    const cartHash = hash(entries);
    return {
      items,
      issues,
      subtotalCents,
      currency: 'EUR',
      cartHash,
      quoteHash: hash({ cartHash, currency: 'EUR', items }),
      canReserve: issues.length === 0,
    };
  }

  view(session: CheckoutSession) {
    return {
      serverNow: Date.now(),
      id: session.id,
      status: session.status,
      expiresAt: session.expiresAt,
      revision: session.revision,
      items: session.items,
      subtotalCents: session.subtotalCents,
      currency: session.currency,
      step: session.machineSnapshot.value,
      phase:
        session.status === 'completed'
          ? 'completed'
          : session.payment
            ? 'payment'
            : 'checkout',
      paymentStatus: session.payment?.status ?? 'not_started',
      fulfillmentStatus:
        session.order?.status === 'paid' ? 'unfulfilled' : 'not_started',
      payment: session.payment
        ? {
            id: session.payment.id,
            status: session.payment.status,
            lastFailure: session.payment.lastFailure ?? null,
            retryCheckoutId: session.payment.retryCheckoutId,
            paymentUrl: session.payment.paymentUrl,
            cancelRequested: session.payment.cancelRequested,
            optionId: session.payment.optionId,
            optionLabel: session.payment.optionLabel,
            simulated: session.payment.simulated ?? true,
          }
        : null,
      order: session.order
        ? {
            id: session.order.id,
            status: session.order.status,
            sellerOrders: session.order.sellerOrders,
            cleanup: session.order.cleanup,
          }
        : null,
      delivery: session.delivery ?? null,
      shipping: session.shipping ?? null,
      shippingOptions: session.delivery
        ? shippingOptions(session.items, session.delivery.country)
        : [],
      shippingCents: session.shipping?.shippingCents ?? null,
      totalCents: session.shipping
        ? session.subtotalCents + session.shipping.shippingCents
        : null,
    };
  }
}
