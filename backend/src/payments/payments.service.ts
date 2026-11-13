import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  CheckoutSession,
  StockReservation,
} from '../checkout/checkout-session.entity';
import { CheckoutService } from '../checkout/checkout.service';
import { ProductsService } from '../products/products.service';
import { Products } from '../products/products.entity';
import { CartRepository } from '../cart/cart.repository';
import { JobQueue } from '../jobs/job-queue';
import {
  PaymentProviderFactory,
  type ProviderPayment,
} from './payment-provider';

@Injectable()
export class PaymentsService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private scanning = false;
  private closed = false;
  private readonly logger = new Logger(PaymentsService.name);
  constructor(
    private readonly products: ProductsService,
    private readonly checkout: CheckoutService,
    private readonly factory: PaymentProviderFactory,
    private readonly jobs: JobQueue,
    private readonly carts: CartRepository,
  ) {}
  async onModuleInit() {
    if (!this.factory.enabled) return;
    await this.jobs.register('payment-processing', (data) =>
      this.process(data.checkoutId),
    );
    this.timer = setInterval(() => {
      void this.dispatch();
    }, 1000);
    this.timer.unref();
    void this.dispatch();
  }
  onModuleDestroy() {
    this.closed = true;
    clearInterval(this.timer);
  }

  async start(
    buyerId: string,
    id: string,
    revision: number,
    optionId = 'card',
  ) {
    const result = await this.products.withStockTransaction(async (manager) => {
      const session = await manager.findOneBy(CheckoutSession, { id, buyerId });
      if (!session) throw new NotFoundException('Checkout not found');
      // A repeated confirm resumes the same attempt, never creates another charge.
      if (session.payment) {
        if (session.payment.optionId && session.payment.optionId !== optionId)
          throw new ConflictException(
            'A payment has already started with another method. Resume or cancel that payment first.',
          );
        return this.checkout.view(session);
      }
      const option = this.factory.option(optionId);
      const adapter = this.factory.create(option.provider);
      if (
        session.status !== 'reserved' ||
        session.expiresAt <= Date.now() ||
        session.machineSnapshot.value !== 'review' ||
        !session.delivery ||
        !session.shipping
      )
        throw new ConflictException(
          'Complete checkout review with an active reservation before payment.',
        );
      if (session.revision !== revision)
        throw new ConflictException(
          'Checkout changed. Refresh and review before payment.',
        );
      for (const item of session.items) {
        const current = await manager.findOneBy(Products, {
          id: item.productId,
        });
        if (
          !current ||
          current.sellerId !== item.sellerId ||
          Math.round(Number(current.price) * 100) !== item.unitPriceCents
        )
          throw new ConflictException(
            'A product or price changed. Release this reservation and review your cart again.',
          );
      }
      const totalCents = session.subtotalCents + session.shipping.shippingCents;
      if (!Number.isSafeInteger(totalCents) || totalCents < 0)
        throw new ConflictException('Invalid checkout total');
      session.order = {
        id: randomUUID(),
        status: 'pending',
        createdAt: Date.now(),
        paidAt: null,
        items: session.items,
        delivery: session.delivery,
        shipping: session.shipping,
        totalCents,
        currency: session.currency,
        sellerOrders: session.shipping.shipments.map((shipment) => {
          const items = session.items.filter(
            (item) => item.sellerId === shipment.sellerId,
          );
          return {
            id: randomUUID(),
            sellerId: shipment.sellerId,
            items,
            shippingCents: shipment.feeCents,
            totalCents:
              items.reduce((sum, item) => sum + item.lineTotalCents, 0) +
              shipment.feeCents,
            fulfillment: 'unfulfilled',
          };
        }),
        cleanup: 'pending',
      };
      const attemptId = randomUUID();
      session.payment = {
        id: attemptId,
        provider: option.provider,
        method: option.method,
        optionId: option.id,
        optionLabel: option.label,
        simulated: adapter.simulated,
        status: 'pending',
        amountCents: totalCents,
        currency: session.currency,
        paymentUrl: null,
        returnUrl: `${this.factory.shopOrigin}/checkout?session=${session.id}`,
        cancelRequested: false,
        nextCheckAt: Date.now(),
      };
      this.checkout.transition(session, [
        { type: 'CONFIRM' },
        { type: 'PAYMENT_PREPARED', attemptId },
      ]);
      session.revision++;
      await manager.save(CheckoutSession, session);
      return this.checkout.view(session);
    });
    // The persisted payment record is the outbox. Redis failure cannot lose the command.
    void this.dispatch();
    return result;
  }

  async dispatch() {
    if (this.scanning || this.closed || !this.factory.enabled) return;
    this.scanning = true;
    try {
      const due = await this.products.withStockTransaction(async (manager) => {
        const sessions = await manager
          .createQueryBuilder(CheckoutSession, 'c')
          .where(
            "(json_extract(c.payment, '$.status') IN ('pending', 'unknown') AND json_extract(c.payment, '$.nextCheckAt') <= :now) OR (json_extract(c.order, '$.status') = 'paid' AND json_extract(c.order, '$.cleanup') = 'pending')",
            { now: Date.now() },
          )
          .take(100)
          .getMany();
        return sessions.map((session) => ({
          id: session.id,
          jobId: `payment-${session.payment!.id}-${Math.floor(session.payment!.nextCheckAt / 1000)}`,
        }));
      });
      for (const session of due)
        await this.jobs.add(
          'payment-processing',
          { checkoutId: session.id },
          session.jobId,
        );
    } catch {
      this.logger.warn(
        'Payment work remains queued in SQL; retrying when background services are available',
      );
    } finally {
      this.scanning = false;
    }
  }

  async process(id: string) {
    const session = await this.products.withStockTransaction((manager) =>
      manager.findOneBy(CheckoutSession, { id }),
    );
    if (!session?.payment || !session.order) return;
    const payment = session.payment;
    if (session.order.status === 'paid') {
      await this.cleanup(session);
      return;
    }
    if (!['pending', 'unknown'].includes(payment.status)) return;
    let stage: 'provider' | 'finalization' = 'provider';
    try {
      const provider = this.factory.create(payment.provider ?? 'simulated');
      const created = await provider.create({
        reference: payment.id,
        amountCents: payment.amountCents,
        currency: payment.currency,
        expiresAt: session.expiresAt,
        returnUrl: payment.returnUrl,
        ...(payment.method ? { method: payment.method } : {}),
      });
      const result = payment.cancelRequested
        ? await provider.cancel(payment.id)
        : created.status === 'pending'
          ? await provider.get(payment.id)
          : created;
      stage = 'finalization';
      await this.apply(id, payment.id, result);
    } catch {
      await this.products.withStockTransaction(async (manager) => {
        const current = await manager.findOneBy(CheckoutSession, { id });
        if (
          !current?.payment ||
          current.payment.id !== payment.id ||
          !['pending', 'unknown'].includes(current.payment.status)
        )
          return;
        if (current.machineSnapshot.value === 'paymentPending')
          this.checkout.transition(current, [
            { type: 'PAYMENT_OUTCOME_UNKNOWN', attemptId: payment.id },
          ]);
        if (current.payment.lastFailure !== stage)
          this.logger.warn(
            `Checkout ${id}: ${stage === 'provider' ? 'provider verification unavailable' : 'local order finalization failed'}; reconciliation will retry`,
          );
        current.payment.lastFailure = stage;
        current.payment.status = 'unknown';
        current.payment.nextCheckAt = Date.now() + 5000;
        await manager.save(CheckoutSession, current);
      });
      return;
    }
    const saved = await this.products.withStockTransaction((manager) =>
      manager.findOneBy(CheckoutSession, { id }),
    );
    if (saved?.order?.status === 'paid') await this.cleanup(saved);
  }

  private async apply(id: string, attemptId: string, result: ProviderPayment) {
    await this.products.withStockTransaction(async (manager) => {
      const session = await manager.findOneBy(CheckoutSession, { id });
      if (
        !session?.payment ||
        session.payment.id !== attemptId ||
        !['pending', 'unknown'].includes(session.payment.status) ||
        !session.order
      )
        return;
      const payment = session.payment;
      if (
        result.reference !== attemptId ||
        result.amountCents !== payment.amountCents ||
        result.currency !== payment.currency ||
        result.expiresAt !== session.expiresAt ||
        result.returnUrl !== payment.returnUrl ||
        result.method !== payment.method
      )
        throw new ConflictException(
          'Provider payment does not match this order',
        );
      payment.lastFailure = null;
      payment.paymentUrl = result.paymentUrl;
      payment.nextCheckAt = Date.now() + 2000;
      if (result.status === 'pending') {
        // A verified pending result restores the hosted-page link after an outage.
        payment.status = 'pending';
        await manager.save(CheckoutSession, session);
        return;
      }
      if (result.status === 'succeeded') {
        const held = await manager.findBy(StockReservation, { checkoutId: id });
        if (
          held.length !== session.items.length ||
          session.items.some(
            (item) =>
              !held.some(
                (row) =>
                  row.productId === item.productId &&
                  row.quantity === item.quantity,
              ),
          )
        )
          throw new ConflictException('Reservation requires reconciliation');
        await manager.delete(StockReservation, { checkoutId: id });
        await this.products.deductStock(session.items, manager);
        this.checkout.transition(session, [
          { type: 'PAYMENT_SUCCEEDED', attemptId },
          { type: 'ORDER_FINALIZED' },
        ]);
        session.order.status = 'paid';
        session.order.paidAt = Date.now();
        session.status = 'completed';
      } else {
        if (session.machineSnapshot.value === 'paymentPending')
          this.checkout.transition(session, [{ type: 'CHECK_PAYMENT_STATUS' }]);
        this.checkout.transition(session, [
          {
            type:
              result.status === 'failed'
                ? 'PAYMENT_FAILED'
                : result.status === 'expired'
                  ? 'PAYMENT_EXPIRED'
                  : 'PAYMENT_CANCELLED',
            attemptId,
          },
        ]);
        if (result.status === 'failed')
          this.checkout.transition(session, [{ type: 'CANCEL' }]);
        this.checkout.transition(session, [{ type: 'RESERVATION_RELEASED' }]);
        await manager.delete(StockReservation, { checkoutId: id });
        session.order.status =
          result.status === 'expired' ? 'expired' : 'cancelled';
        session.status = result.status === 'expired' ? 'expired' : 'cancelled';
      }
      payment.status = result.status;
      session.activeBuyerId = null;
      session.revision++;
      await manager.save(CheckoutSession, session);
    });
  }
  private async cleanup(session: CheckoutSession) {
    // Mongo cannot share SQLite's transaction. A durable, retryable cleanup effect
    // uses a cart revision so new edits on another device are never removed.
    if (session.cartRevision != null)
      await this.carts.clearPurchasedIfUnchanged(
        session.buyerId,
        session.items,
        session.cartRevision,
      );
    await this.products.withStockTransaction(async (manager) => {
      const current = await manager.findOneBy(CheckoutSession, {
        id: session.id,
      });
      if (current?.order?.status === 'paid') {
        current.order.cleanup = 'cleared_or_preserved';
        await manager.save(CheckoutSession, current);
      }
    });
  }
}
