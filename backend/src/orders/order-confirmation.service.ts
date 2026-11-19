import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { OrderPresentationService } from './order-presentation.service';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import hbs from 'hbs';
import { readFileSync } from 'node:fs';
import { isEmail } from 'class-validator';
import { ProductsService } from '../products/products.service';
import { CheckoutSession } from '../checkout/checkout-session.entity';
import { UsersRepository } from '../auth/users.repository';
import { JobQueue } from '../jobs/job-queue';
import { DeliveryProviderFactory } from './delivery-provider';
import { InvoiceRendererFactory } from './invoice-renderer';
import { EmailProviderFactory } from '../user-interaction/email/email-provider';
import { isFinalDeliveryStatus } from './order-confirmation.types';
import type {
  OrderNotification,
  TrackingEvent,
} from './order-confirmation.types';

@Injectable()
export class OrderConfirmationService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private scanning = false;
  private closed = false;
  private readonly logger = new Logger(OrderConfirmationService.name);
  private readonly directory = resolve(
    process.env.INVOICE_STORAGE_DIR ??
      join(__dirname, '../../storage/private/invoices'),
  );
  private readonly template = hbs.handlebars.compile(
    readFileSync(join(__dirname, '../views/emails/order.hbs'), 'utf8'),
  );
  private readonly shopOrigin =
    process.env.SHOP_ORIGIN ?? 'http://localhost:3000';
  constructor(
    private readonly products: ProductsService,
    private readonly users: UsersRepository,
    private readonly jobs: JobQueue,
    private readonly delivery: DeliveryProviderFactory,
    private readonly invoices: InvoiceRendererFactory,
    private readonly email: EmailProviderFactory,
    private readonly presentation: OrderPresentationService,
  ) {
    if (new URL(this.shopOrigin).origin !== this.shopOrigin)
      throw new Error('SHOP_ORIGIN must be an origin');
  }
  async onModuleInit() {
    if (
      !this.delivery.enabled ||
      process.env.ORDER_CONFIRMATION_ENABLED === 'false'
    )
      return;
    await this.jobs.register('invoice-generation', (data) =>
      this.generateInvoice(data.checkoutId, data.sellerOrderId),
    );
    await this.jobs.register('delivery-sync', (data) =>
      this.syncDelivery(data.checkoutId),
    );
    await this.jobs.register('order-email', (data) =>
      this.sendEmail(data.checkoutId, data.notificationId),
    );
    this.timer = setInterval(() => {
      void this.dispatch();
    }, 2000);
    this.timer.unref();
    void this.dispatch();
  }
  onModuleDestroy() {
    this.closed = true;
    clearInterval(this.timer);
  }
  private read(id: string) {
    return this.products.withStockTransaction((manager) =>
      manager.findOneBy(CheckoutSession, { id }),
    );
  }
  private async initialize(id: string) {
    const stored = await this.read(id);
    if (
      !stored?.order ||
      stored.order.status !== 'paid' ||
      stored.order.confirmation
    )
      return;
    const user = await this.users.findById(stored.buyerId);
    const recipient =
      user?.email && user.emailVerifiedAt && isEmail(user.email)
        ? user.email
        : null;
    await this.products.withStockTransaction(async (manager) => {
      const current = await manager.findOneBy(CheckoutSession, { id });
      if (
        !current?.order ||
        current.order.status !== 'paid' ||
        current.order.confirmation
      )
        return;
      current.order.confirmation = {
        recipient,
        nextCheckAt: 0,
        notifications: [],
        invoices: current.order.sellerOrders.map((seller) => ({
          sellerOrderId: seller.id,
          number: `DEMO-${seller.id.toUpperCase()}`,
          status: 'pending',
        })),
        shipments: current.order.sellerOrders.map((seller) => ({
          sellerOrderId: seller.id,
          provider: this.delivery.provider,
          reference: seller.id,
          trackingNumber: null,
          status: 'pending',
          version: 0,
          events: [],
        })),
      };
      await manager.save(CheckoutSession, current);
    });
  }
  private notification(
    sellerOrderId: string,
    event: TrackingEvent,
    kind: 'confirmation' | 'delivery',
    recipient: string | null,
  ): OrderNotification {
    return {
      id: createHash('sha256')
        .update(`${sellerOrderId}:${event.sequence}`)
        .digest('hex'),
      sellerOrderId,
      sequence: event.sequence,
      kind,
      event,
      status: recipient ? 'pending' : 'skipped',
    };
  }
  async dispatch() {
    if (this.closed || this.scanning || !this.delivery.enabled) return;
    this.scanning = true;
    try {
      const rows = await this.products.withStockTransaction((manager) =>
        manager
          .createQueryBuilder(CheckoutSession, 'c')
          .where(
            "c.status = 'completed' AND (json_extract(c.order, '$.confirmation.nextCheckAt') IS NULL OR json_extract(c.order, '$.confirmation.nextCheckAt') <= :now)",
            { now: Date.now() },
          )
          .take(100)
          .getMany(),
      );
      for (const row of rows) {
        await this.initialize(row.id);
        const work = await this.products.withStockTransaction(
          async (manager) => {
            const current = await manager.findOneBy(CheckoutSession, {
              id: row.id,
            });
            const state = current?.order?.confirmation;
            if (!current?.order || !state) return null;
            for (const invoice of state.invoices) {
              const shipment = state.shipments.find(
                (value) => value.sellerOrderId === invoice.sellerOrderId,
              );
              if (
                invoice.status === 'ready' &&
                shipment?.events[0] &&
                !state.notifications.some(
                  (value) =>
                    value.sellerOrderId === invoice.sellerOrderId &&
                    value.kind === 'confirmation',
                )
              )
                state.notifications.push(
                  this.notification(
                    invoice.sellerOrderId,
                    shipment.events[0],
                    'confirmation',
                    state.recipient,
                  ),
                );
            }
            const pendingInvoices = state.invoices
              .filter((value) => value.status === 'pending')
              .map((value) => value.sellerOrderId);
            const sync = state.shipments.some(
              (value) => !isFinalDeliveryStatus(value.status),
            );
            const messages = state.notifications
              .filter(
                (value) =>
                  value.status === 'pending' &&
                  (value.leaseUntil ?? 0) <= Date.now(),
              )
              .map((value) => value.id);
            state.nextCheckAt =
              pendingInvoices.length ||
              sync ||
              messages.length ||
              state.notifications.some((value) => value.status === 'pending')
                ? Date.now() + 3000
                : Number.MAX_SAFE_INTEGER;
            await manager.save(CheckoutSession, current);
            return { pendingInvoices, sync, messages };
          },
        );
        if (!work) continue;
        for (const sellerOrderId of work.pendingInvoices)
          await this.jobs.add(
            'invoice-generation',
            { checkoutId: row.id, sellerOrderId },
            `invoice-${sellerOrderId}`,
          );
        if (work.sync)
          await this.jobs.add(
            'delivery-sync',
            { checkoutId: row.id },
            `delivery-${row.id}-${Math.floor(Date.now() / 3000)}`,
          );
        for (const notificationId of work.messages)
          await this.jobs.add(
            'order-email',
            { checkoutId: row.id, notificationId },
            `order-mail-${notificationId}`,
          );
      }
    } catch {
      this.logger.warn(
        'Order confirmation work remains in SQL; background services will retry',
      );
    } finally {
      this.scanning = false;
    }
  }
  private file(sellerOrderId: string) {
    if (!/^[a-f0-9-]{36}$/i.test(sellerOrderId))
      throw new NotFoundException('Invoice not found');
    return join(this.directory, `${sellerOrderId}.pdf`);
  }
  async generateInvoice(id: string, sellerOrderId: string) {
    const session = await this.read(id);
    const order = session?.order;
    const invoice = order?.confirmation?.invoices.find(
      (value) => value.sellerOrderId === sellerOrderId,
    );
    const sellerOrder = order?.sellerOrders.find(
      (value) => value.id === sellerOrderId,
    );
    if (
      !order ||
      order.status !== 'paid' ||
      !invoice ||
      !sellerOrder ||
      invoice.status === 'ready'
    )
      return;
    await mkdir(this.directory, { recursive: true });
    const file = this.file(sellerOrderId);
    let exists = false;
    try {
      const content = await readFile(file);
      exists =
        content.subarray(0, 5).toString() === '%PDF-' &&
        content.subarray(-32).toString().includes('%%EOF');
    } catch {}
    if (!exists) {
      const content = await this.invoices
        .create()
        .render({ number: invoice.number, order, sellerOrder });
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, content, { mode: 0o600 });
      await rename(temporary, file);
    }
    await this.products.withStockTransaction(async (manager) => {
      const current = await manager.findOneBy(CheckoutSession, { id });
      const state = current?.order?.confirmation;
      const stored = state?.invoices.find(
        (value) => value.sellerOrderId === sellerOrderId,
      );
      if (current && state && stored) {
        stored.status = 'ready';
        state.nextCheckAt = 0;
        await manager.save(CheckoutSession, current);
      }
    });
  }
  async syncDelivery(id: string) {
    const session = await this.read(id);
    const order = session?.order;
    if (!order || order.status !== 'paid' || !order.confirmation) return;
    for (const shipment of order.confirmation.shipments) {
      if (isFinalDeliveryStatus(shipment.status)) continue;
      const provider = this.delivery.create(shipment.provider);
      const result = shipment.trackingNumber
        ? await provider.get(shipment.reference)
        : await provider.create({
            reference: shipment.reference,
            method: order.shipping.method,
            country: order.delivery.country,
          });
      if (
        result.reference !== shipment.reference ||
        result.method !== order.shipping.method ||
        result.country !== order.delivery.country ||
        (shipment.trackingNumber &&
          shipment.trackingNumber !== result.trackingNumber)
      )
        throw new ConflictException('Shipment does not match the order');
      await this.products.withStockTransaction(async (manager) => {
        const current = await manager.findOneBy(CheckoutSession, { id });
        const state = current?.order?.confirmation;
        const stored = state?.shipments.find(
          (value) => value.sellerOrderId === shipment.sellerOrderId,
        );
        if (
          !current?.order ||
          !state ||
          !stored ||
          result.version < stored.version
        )
          return;
        if (
          stored.events.some(
            (event, index) =>
              event.sequence !== result.events[index]?.sequence ||
              event.status !== result.events[index]?.status ||
              event.occurredAt !== result.events[index]?.occurredAt,
          )
        )
          throw new ConflictException('Tracking history changed');
        for (const event of result.events.filter(
          (value) => value.sequence > stored.version && value.sequence > 1,
        ))
          if (
            !state.notifications.some(
              (value) =>
                value.sellerOrderId === stored.sellerOrderId &&
                value.sequence === event.sequence,
            )
          )
            state.notifications.push(
              this.notification(
                stored.sellerOrderId,
                event,
                'delivery',
                state.recipient,
              ),
            );
        stored.trackingNumber = result.trackingNumber;
        stored.status = result.status;
        stored.version = result.version;
        stored.events = result.events;
        current.order.sellerOrders.find(
          (value) => value.id === shipment.sellerOrderId,
        )!.fulfillment = result.status;
        state.nextCheckAt = 0;
        await manager.save(CheckoutSession, current);
      });
    }
  }
  async sendEmail(id: string, notificationId: string) {
    const lease = randomUUID();
    const claimed = await this.products.withStockTransaction(
      async (manager) => {
        const current = await manager.findOneBy(CheckoutSession, { id });
        const order = current?.order;
        const state = order?.confirmation;
        const notice = state?.notifications.find(
          (value) => value.id === notificationId,
        );
        if (
          !current ||
          !order ||
          order.status !== 'paid' ||
          !state?.recipient ||
          !notice ||
          notice.status !== 'pending' ||
          (notice.leaseUntil ?? 0) > Date.now()
        )
          return null;
        if (
          notice.kind === 'delivery' &&
          !state.notifications.some(
            (value) =>
              value.sellerOrderId === notice.sellerOrderId &&
              value.kind === 'confirmation' &&
              ['sent', 'logged'].includes(value.status),
          )
        )
          return null;
        if (
          state.notifications.some(
            (value) =>
              value.sellerOrderId === notice.sellerOrderId &&
              value.sequence < notice.sequence &&
              value.status === 'pending',
          )
        )
          return null;
        const invoice = state.invoices.find(
          (value) => value.sellerOrderId === notice.sellerOrderId,
        );
        if (!invoice || invoice.status !== 'ready') return null;
        notice.lease = lease;
        notice.leaseUntil = Date.now() + 60000;
        await manager.save(CheckoutSession, current);
        return current;
      },
    );
    if (!claimed?.order?.confirmation) return;
    try {
      const order = claimed.order;
      const state = order.confirmation!;
      const notice = state.notifications.find(
        (value) => value.id === notificationId,
      )!;
      const invoice = state.invoices.find(
        (value) => value.sellerOrderId === notice.sellerOrderId,
      )!;
      const shipment = state.shipments.find(
        (value) => value.sellerOrderId === notice.sellerOrderId,
      )!;
      const label = notice.event.status.replaceAll('_', ' ');
      const subject =
        notice.kind === 'confirmation'
          ? 'Your Nest Shop order confirmation and demo invoice'
          : `Nest Shop delivery update: ${label}`;
      const url = `${this.shopOrigin}/orders/${id}`;
      await this.email.create().send({
        id: notice.id,
        to: state.recipient!,
        subject,
        text: `${subject}\nOrder: ${order.id}\nTracking: ${shipment.trackingNumber}\nStatus: ${label}\n${url}`,
        html: this.template({
          confirmation: notice.kind === 'confirmation',
          orderId: order.id,
          number: invoice.number,
          trackingNumber: shipment.trackingNumber,
          status: label,
          occurredAt: new Date(notice.event.occurredAt).toISOString(),
          url,
        }),
        attachments:
          notice.kind === 'confirmation'
            ? [
                {
                  filename: `${invoice.number}.pdf`,
                  content: await readFile(this.file(notice.sellerOrderId)),
                  contentType: 'application/pdf',
                },
              ]
            : [],
      });
      await this.products.withStockTransaction(async (manager) => {
        const current = await manager.findOneBy(CheckoutSession, { id });
        const stored = current?.order?.confirmation?.notifications.find(
          (value) => value.id === notificationId,
        );
        if (current && stored?.lease === lease) {
          stored.status = this.email.mode === 'LOG' ? 'logged' : 'sent';
          stored.sentAt = Date.now();
          stored.lease = null;
          stored.leaseUntil = 0;
          current.order!.confirmation!.nextCheckAt = 0;
          await manager.save(CheckoutSession, current);
        }
      });
    } catch {
      await this.products.withStockTransaction(async (manager) => {
        const current = await manager.findOneBy(CheckoutSession, { id });
        const notice = current?.order?.confirmation?.notifications.find(
          (value) => value.id === notificationId,
        );
        if (current && notice?.lease === lease) {
          notice.lease = null;
          notice.leaseUntil = 0;
          await manager.save(CheckoutSession, current);
        }
      });
      throw new Error('Order email delivery will retry');
    }
  }
  async owned(buyerId: string, id: string) {
    const session = await this.products.withStockTransaction((manager) =>
      manager.findOneBy(CheckoutSession, { id, buyerId }),
    );
    if (!session?.order || session.order.status !== 'paid')
      throw new NotFoundException('Confirmed order not found');
    return session;
  }
  async history(buyerId: string) {
    const sessions = await this.products.withStockTransaction((manager) =>
      manager.find(CheckoutSession, {
        where: { buyerId, status: 'completed' },
        order: { createdAt: 'DESC' },
        take: 100,
      }),
    );
    return this.presentation.describe(sessions);
  }
  async view(buyerId: string, id: string) {
    const session = await this.owned(buyerId, id);
    const order = session.order!;
    const state = order.confirmation;
    const display = (await this.presentation.describe([session]))[0];
    return {
      orderNumber: display.orderNumber,
      placedAt: display.placedAt,
      id: session.id,
      orderId: order.id,
      totalCents: order.totalCents,
      currency: order.currency,
      delivery: order.delivery,
      recipient: state?.recipient ?? null,
      emailConfigured: this.email.mode !== 'LOG',
      preparing: !state,
      sellers: order.sellerOrders.map((seller) => ({
        id: seller.id,
        sellerName: display.sellers.find((value) => value.id === seller.id)!
          .sellerName,
        items: display.sellers.find((value) => value.id === seller.id)!.items,
        canReturn: seller.fulfillment === 'delivered',
        totalCents: seller.totalCents,
        invoice:
          state?.invoices.find((value) => value.sellerOrderId === seller.id) ??
          null,
        shipment:
          state?.shipments.find((value) => value.sellerOrderId === seller.id) ??
          null,
        notifications:
          state?.notifications
            .filter((value) => value.sellerOrderId === seller.id)
            .map((value) => ({
              id: value.id,
              status: value.status,
              event: value.event,
              kind: value.kind,
            })) ?? [],
      })),
    };
  }
  async invoiceFile(buyerId: string, id: string, sellerOrderId: string) {
    const session = await this.owned(buyerId, id);
    const invoice = session.order?.confirmation?.invoices.find(
      (value) =>
        value.sellerOrderId === sellerOrderId && value.status === 'ready',
    );
    if (!invoice)
      throw new NotFoundException('Invoice is still being prepared');
    return {
      path: this.file(sellerOrderId),
      filename: `${invoice.number}.pdf`,
    };
  }
}
