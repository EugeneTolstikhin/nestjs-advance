import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, In } from 'typeorm';
import hbs from 'hbs';
import { isEmail } from 'class-validator';
import { OrderPresentationService } from '../orders/order-presentation.service';
import { ProductsService } from '../products/products.service';
import { Products } from '../products/products.entity';
import { CheckoutSession } from '../checkout/checkout-session.entity';
import { UsersRepository } from '../auth/users.repository';
import { JobQueue } from '../jobs/job-queue';
import {
  DeliveryProviderFactory,
  ProviderShipment,
} from '../orders/delivery-provider';
import { PaymentProviderFactory } from '../payments/payment-provider';
import { EmailProviderFactory } from '../user-interaction/email/email-provider';
import { AuthenticatedUser } from '../auth/utils/auth-request';
import { TypeOfUser } from '../auth/auth.dto';
import { OrderReturn } from './return.entity';
import {
  CreateReturnDto,
  ReturnActionDto,
  InspectionLineDto,
} from './return.dto';

@Injectable()
export class ReturnsService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private scanning = false;
  private cursor = '';
  private closed = false;
  private readonly logger = new Logger(ReturnsService.name);
  constructor(
    private readonly db: DataSource,
    private readonly products: ProductsService,
    private readonly users: UsersRepository,
    private readonly jobs: JobQueue,
    private readonly delivery: DeliveryProviderFactory,
    private readonly payments: PaymentProviderFactory,
    private readonly email: EmailProviderFactory,
    private readonly presentation: OrderPresentationService,
  ) {}

  async onModuleInit() {
    if (
      process.env.RETURNS_ENABLED === 'false' ||
      !this.db.hasMetadata(OrderReturn)
    )
      return;
    await this.jobs.register('return-processing', (data) =>
      this.process(data.id),
    );
    await this.jobs.register('return-email', (data) =>
      this.sendEmail(data.id, data.noticeId),
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
  private event(
    record: OrderReturn,
    text: string,
    author: 'buyer' | 'seller' | 'system' = 'system',
  ) {
    record.data.history.push({
      id: randomUUID(),
      at: Date.now(),
      author,
      text,
    });
    for (const audience of ['buyer', 'seller'] as const) {
      record.data.notifications.push({
        id: randomUUID(),
        audience,
        text,
        status: 'pending',
      });
    }
    record.revision++;
    record.nextCheckAt = 0;
  }
  private async paid(manager: EntityManager, id: string) {
    const session = await manager.findOneBy(CheckoutSession, { id });
    if (!session?.order || session.order.status !== 'paid')
      throw new NotFoundException('Paid order not found');
    return session;
  }
  private seller(record: OrderReturn, user: AuthenticatedUser) {
    return (
      user.sub === record.sellerId && user.roles.includes(TypeOfUser.Seller)
    );
  }
  private buyer(record: OrderReturn, user: AuthenticatedUser) {
    return user.sub === record.buyerId && user.roles.includes(TypeOfUser.Buyer);
  }
  async owned(manager: EntityManager, id: string, user: AuthenticatedUser) {
    const record = await manager.findOneBy(OrderReturn, { id });
    if (!record || (!this.seller(record, user) && !this.buyer(record, user)))
      throw new NotFoundException('Return not found');
    return record;
  }
  private make(
    session: CheckoutSession,
    sellerOrderId: string,
    id: string,
    kind: OrderReturn['kind'],
  ): OrderReturn {
    const seller = session.order!.sellerOrders.find(
      (value) => value.id === sellerOrderId,
    );
    if (!seller) throw new NotFoundException('Seller order not found');
    const shipment = session.order!.confirmation?.shipments.find(
      (value) => value.sellerOrderId === seller.id,
    );
    return Object.assign(new OrderReturn(), {
      id,
      checkoutId: session.id,
      sellerOrderId,
      sellerId: seller.sellerId,
      buyerId: session.buyerId,
      kind,
      automaticReference: kind === 'failed_delivery' ? seller.id : null,
      status: kind === 'failed_delivery' ? 'in_transit' : 'requested',
      revision: 1,
      createdAt: Date.now(),
      nextCheckAt: 0,
      data: {
        items: [],
        history: [],
        notifications: [],
        provider: shipment?.provider ?? this.delivery.provider,
        originalReference: shipment?.reference ?? seller.id,
        shipment:
          kind === 'failed_delivery' &&
          shipment?.trackingNumber &&
          shipment.status !== 'pending'
            ? {
                reference: shipment.reference,
                method: session.order!.shipping.method,
                country: session.order!.delivery.country,
                trackingNumber: shipment.trackingNumber,
                status: shipment.status,
                version: shipment.version,
                events: shipment.events,
              }
            : null,
        inspection: null,
        buyerIssue: false,
        discrepancyResolved: false,
        shippingCents: seller.shippingCents,
        shippingRefundCents: 0,
        claim: null,
        evidence: [],
        refund: null,
      },
    });
  }
  async request(user: AuthenticatedUser, input: CreateReturnDto) {
    if (!user.roles.includes(TypeOfUser.Buyer))
      throw new BadRequestException('A buyer account is required');
    return this.products.withStockTransaction(async (manager) => {
      const previous = await manager.findOneBy(OrderReturn, { id: input.id });
      if (previous) {
        if (
          previous.buyerId !== user.sub ||
          previous.kind !== 'buyer_request' ||
          previous.checkoutId !== input.checkoutId ||
          previous.sellerOrderId !== input.sellerOrderId ||
          JSON.stringify(
            previous.data.items.map(({ productId, quantity, reason }) => ({
              productId,
              quantity,
              reason,
            })),
          ) !==
            JSON.stringify(
              input.items.map(({ productId, quantity, reason }) => ({
                productId,
                quantity,
                reason,
              })),
            )
        )
          throw new ConflictException('Return request identifier already used');
        return { id: previous.id };
      }
      const session = await this.paid(manager, input.checkoutId);
      if (session.buyerId !== user.sub)
        throw new NotFoundException('Order not found');
      const seller = session.order!.sellerOrders.find(
        (value) => value.id === input.sellerOrderId,
      );
      if (!seller || seller.fulfillment !== 'delivered')
        throw new ConflictException(
          'Returns can be requested after this seller shipment is delivered',
        );
      const existing = await manager.find(OrderReturn, {
        where: { checkoutId: session.id, sellerOrderId: seller.id },
      });
      const seen = new Set<string>();
      const record = this.make(session, seller.id, input.id, 'buyer_request');
      record.data.items = input.items.map((item) => {
        const original = seller.items.find(
          (line) => line.productId === item.productId,
        );
        const reserved = existing
          .filter((value) => value.status !== 'rejected')
          .reduce(
            (sum, value) =>
              sum +
              (value.data.items.find(
                (line) => line.productId === item.productId,
              )?.quantity ?? 0),
            0,
          );
        if (
          !original ||
          seen.has(item.productId) ||
          item.quantity + reserved > original.quantity ||
          !item.reason.trim()
        )
          throw new BadRequestException(
            'Invalid, duplicate or already returned quantity',
          );
        seen.add(item.productId);
        return {
          productId: item.productId,
          quantity: item.quantity,
          reason: item.reason,
          name: original.name,
          unitPriceCents: original.unitPriceCents,
        };
      });
      this.event(
        record,
        'Buyer requested a return. Awaiting seller approval.',
        'buyer',
      );
      await manager.save(OrderReturn, record);
      return { id: record.id };
    });
  }
  async discover() {
    await this.products.withStockTransaction(async (manager) => {
      const rows = await manager
        .createQueryBuilder(CheckoutSession, 'c')
        .where(
          "c.status = 'completed' AND c.id > :cursor AND EXISTS (SELECT 1 FROM json_each(c.\"order\", '$.sellerOrders') s WHERE json_extract(s.value, '$.fulfillment') IN ('returning_to_sender','returned_to_sender'))",
          { cursor: this.cursor },
        )
        .orderBy('c.id')
        .take(50)
        .getMany();
      this.cursor = rows.length === 50 ? rows.at(-1)!.id : '';
      for (const session of rows) {
        if (session.order?.status !== 'paid') continue;
        for (const seller of session.order.sellerOrders.filter((value) =>
          ['returning_to_sender', 'returned_to_sender'].includes(
            value.fulfillment,
          ),
        )) {
          if (
            await manager.findOneBy(OrderReturn, {
              automaticReference: seller.id,
            })
          )
            continue;
          const record = this.make(
            session,
            seller.id,
            randomUUID(),
            'failed_delivery',
          );
          record.data.items = seller.items.map((item) => ({
            productId: item.productId,
            name: item.name,
            unitPriceCents: item.unitPriceCents,
            quantity: item.quantity,
            reason: 'Failed outbound delivery',
          }));
          this.event(
            record,
            'Undelivered shipment is returning. All items in this seller shipment are expected.',
          );
          if (seller.fulfillment === 'returned_to_sender') {
            record.status = 'received';
            this.event(
              record,
              'Carrier reports the parcel received by the seller. Awaiting inspection.',
            );
          }
          await manager.save(OrderReturn, record);
        }
      }
    });
  }
  async list(user: AuthenticatedUser) {
    const rows = await this.products.withStockTransaction(async (manager) => {
      return manager.find(OrderReturn, {
        where: [
          ...(user.roles.includes(TypeOfUser.Buyer)
            ? [{ buyerId: user.sub }]
            : []),
          ...(user.roles.includes(TypeOfUser.Seller)
            ? [{ sellerId: user.sub }]
            : []),
        ],
        order: { createdAt: 'DESC' },
        take: 100,
      });
    });
    return this.present(rows, user);
  }
  async get(id: string, user: AuthenticatedUser) {
    const record = await this.products.withStockTransaction((manager) =>
      this.owned(manager, id, user),
    );
    return (await this.present([record], user))[0];
  }
  private async present(records: OrderReturn[], user: AuthenticatedUser) {
    const ids = [...new Set(records.map((record) => record.checkoutId))];
    const sessions = ids.length
      ? await this.products.withStockTransaction((manager) =>
          manager.find(CheckoutSession, { where: { id: In(ids) } }),
        )
      : [];
    const display = await this.presentation.describe(sessions);
    return records.map((record) => {
      const order = display.find((value) => value.id === record.checkoutId);
      const seller = order?.sellers.find(
        (value) => value.id === record.sellerOrderId,
      );
      return {
        ...this.view(record, user),
        reference: `RT-${record.id.replaceAll('-', '').slice(0, 8).toUpperCase()}`,
        orderNumber: order?.orderNumber,
        placedAt: order?.placedAt,
        sellerName: seller?.sellerName ?? 'Seller',
        items: record.data.items.map((item) => ({
          ...item,
          thumbnail:
            seller?.items.find((value) => value.productId === item.productId)
              ?.thumbnail ?? null,
        })),
      };
    });
  }
  private view(record: OrderReturn, user: AuthenticatedUser) {
    const { notifications, ...data } = record.data;
    return {
      id: record.id,
      checkoutId: record.checkoutId,
      sellerOrderId: record.sellerOrderId,
      kind: record.kind,
      status: record.status,
      revision: record.revision,
      createdAt: record.createdAt,
      canReview: this.seller(record, user),
      ...data,
      notifications: notifications.map(({ audience, text, status }) => ({
        audience,
        text,
        status,
      })),
    };
  }
  async action(id: string, user: AuthenticatedUser, input: ReturnActionDto) {
    await this.products.withStockTransaction(async (manager) => {
      const record = await this.owned(manager, id, user);
      if (record.revision !== input.revision)
        throw new ConflictException('Return changed. Refresh and try again.');
      const seller = this.seller(record, user);
      if (!seller && input.action !== 'message')
        throw new NotFoundException('Seller return not found');
      const notes = input.notes?.trim() ?? '';
      if (input.action === 'message') {
        if (!notes) throw new BadRequestException('Enter a message');
        this.event(record, notes, seller ? 'seller' : 'buyer');
      } else if (input.action === 'approve' || input.action === 'reject') {
        if (record.kind !== 'buyer_request' || record.status !== 'requested')
          throw new ConflictException('Request has already been decided');
        if (input.action === 'reject' && !notes)
          throw new BadRequestException('A rejection explanation is required');
        record.status = input.action === 'approve' ? 'approved' : 'rejected';
        this.event(
          record,
          input.action === 'approve'
            ? `Seller approved the return. ${notes}`
            : `Seller rejected the request. ${notes}`,
          'seller',
        );
      } else if (input.action === 'inspect') {
        if (!['received', 'under_review'].includes(record.status))
          throw new ConflictException(
            'Receive the return before inspecting it',
          );
        this.inspect(record, input.items, notes);
        record.status = 'under_review';
        this.event(record, `Seller recorded inspection. ${notes}`, 'seller');
      } else if (
        input.action === 'ask_buyer' ||
        input.action === 'close_issue'
      ) {
        if (!record.data.inspection || !notes || record.status === 'resolved')
          throw new BadRequestException(
            'Inspection and explanation are required',
          );
        record.data.buyerIssue = input.action === 'ask_buyer';
        record.data.discrepancyResolved = input.action === 'close_issue';
        this.event(
          record,
          `${record.data.buyerIssue ? 'Buyer clarification requested' : 'Buyer discrepancy resolved'}: ${notes}`,
          'seller',
        );
      } else if (input.action === 'carrier_claim') {
        if (!record.data.inspection?.discrepancy || !notes || record.data.claim)
          throw new BadRequestException(
            'A discrepancy, explanation and an unused claim are required',
          );
        record.data.claim = { notes, result: null };
        this.event(
          record,
          `Carrier investigation requested. ${notes}`,
          'seller',
        );
      } else if (input.action === 'retry_refund') {
        if (
          record.status !== 'resolved' ||
          record.data.refund?.status !== 'failed' ||
          !notes
        )
          throw new ConflictException(
            'Only a failed refund can be retried after review',
          );
        record.data.refund.status = 'pending';
        this.event(
          record,
          `Seller requested another refund check. ${notes}`,
          'seller',
        );
      } else if (input.action === 'resolve') {
        if (
          record.status !== 'under_review' ||
          !record.data.inspection ||
          record.data.buyerIssue ||
          !notes
        )
          throw new ConflictException(
            'Complete inspection, resolve buyer clarification and explain the decision first',
          );
        if (
          record.data.inspection.discrepancy &&
          !record.data.discrepancyResolved
        )
          throw new ConflictException(
            'Record the discrepancy resolution before finalizing',
          );
        const shippingRefundCents = input.shippingRefundCents ?? 0;
        const previousReturns = await manager.find(OrderReturn, {
          where: {
            checkoutId: record.checkoutId,
            sellerOrderId: record.sellerOrderId,
            status: 'resolved',
          },
        });
        const shippingAlreadyRefunded = previousReturns.reduce(
          (sum, value) => sum + value.data.shippingRefundCents,
          0,
        );
        if (
          shippingRefundCents + shippingAlreadyRefunded >
          record.data.shippingCents
        )
          throw new BadRequestException(
            'Shipping refund exceeds this seller shipment charge',
          );
        record.data.shippingRefundCents = shippingRefundCents;
        const amountCents =
          shippingRefundCents +
          record.data.items.reduce(
            (sum, item) =>
              sum +
              item.unitPriceCents *
                record.data.inspection!.items.find(
                  (value) => value.productId === item.productId,
                )!.refund,
            0,
          );
        const session = await this.paid(manager, record.checkoutId);
        if (amountCents && !session.payment?.provider)
          throw new ConflictException(
            'Original payment provider is required for a refund',
          );
        for (const item of record.data.inspection.items.filter(
          (value) => value.restock > 0,
        )) {
          const result = await manager
            .createQueryBuilder()
            .update(Products)
            .set({ stock: () => 'stock + :quantity' })
            .where('id = :id AND sellerId = :sellerId AND stock <= :maximum', {
              id: item.productId,
              sellerId: record.sellerId,
              quantity: item.restock,
              maximum: 2147483647 - item.restock,
            })
            .execute();
          if (result.affected !== 1)
            throw new ConflictException(
              'A restocked product is missing, changed owner or exceeds the stock limit',
            );
        }
        record.status = 'resolved';
        record.data.refund = amountCents
          ? { reference: record.id, amountCents, status: 'pending' }
          : null;
        this.event(
          record,
          `Return review completed. Sellable stock restored. Approved item refund ${(amountCents / 100).toFixed(2)} EUR. ${notes}`,
          'seller',
        );
      }
      await manager.save(OrderReturn, record);
    });
    return this.get(id, user);
  }
  private inspect(
    record: OrderReturn,
    items: InspectionLineDto[] | undefined,
    notes: string,
  ) {
    if (!items || items.length !== record.data.items.length || !notes)
      throw new BadRequestException(
        'Inspect every expected item and provide notes',
      );
    const seen = new Set<string>();
    for (const item of items) {
      const expected = record.data.items.find(
        (value) => value.productId === item.productId,
      );
      if (
        !expected ||
        seen.has(item.productId) ||
        item.sellable > item.received ||
        item.restock > item.sellable ||
        item.restock > expected.quantity ||
        item.refund > expected.quantity
      )
        throw new BadRequestException('Invalid inspection quantities');
      seen.add(item.productId);
    }
    record.data.discrepancyResolved = false;
    record.data.inspection = {
      items,
      notes,
      discrepancy: items.some(
        (item) =>
          item.received !==
            record.data.items.find(
              (value) => value.productId === item.productId,
            )!.quantity || item.sellable < item.received,
      ),
    };
  }
  async dispatch() {
    if (this.closed || this.scanning) return;
    this.scanning = true;
    try {
      await this.discover();
      const rows = await this.products.withStockTransaction(async (manager) => {
        const due = await manager
          .createQueryBuilder(OrderReturn, 'r')
          .where('r.nextCheckAt <= :now', { now: Date.now() })
          .take(100)
          .getMany();
        for (const record of due) {
          record.nextCheckAt = Date.now() + 4000;
          await manager.save(OrderReturn, record);
        }
        return due;
      });
      for (const record of rows) {
        if (
          ['approved', 'awaiting_shipment', 'in_transit'].includes(
            record.status,
          ) ||
          (record.data.claim &&
            !['approved', 'rejected'].includes(
              record.data.claim.result?.status ?? '',
            )) ||
          record.data.refund?.status === 'pending'
        ) {
          await this.jobs.add(
            'return-processing',
            { id: record.id },
            `return-${record.id}-${Math.floor(Date.now() / 4000)}`,
          );
        }
        for (const notice of record.data.notifications.filter(
          (value) =>
            value.status === 'pending' && (value.leaseUntil ?? 0) <= Date.now(),
        )) {
          await this.jobs.add(
            'return-email',
            { id: record.id, noticeId: notice.id },
            `return-mail-${notice.id}`,
          );
        }
      }
    } catch {
      this.logger.warn('Return work remains saved and will retry');
    } finally {
      this.scanning = false;
    }
  }
  private read(id: string) {
    return this.products.withStockTransaction((manager) =>
      manager.findOneBy(OrderReturn, { id }),
    );
  }
  private async mutate(id: string, update: (record: OrderReturn) => void) {
    await this.products.withStockTransaction(async (manager) => {
      const record = await manager.findOneBy(OrderReturn, { id });
      if (!record) return;
      update(record);
      await manager.save(OrderReturn, record);
    });
  }
  async process(id: string) {
    let record = await this.read(id);
    if (!record) return;
    if (
      ['approved', 'awaiting_shipment', 'in_transit'].includes(record.status)
    ) {
      const session = await this.products.withStockTransaction((manager) =>
        this.paid(manager, record!.checkoutId),
      );
      const provider = this.delivery.create(record.data.provider);
      const shipment =
        record.kind === 'failed_delivery'
          ? await provider.get(record.data.originalReference)
          : record.data.shipment
            ? await provider.get(record.id)
            : await provider.create({
                reference: record.id,
                method: session.order!.shipping.method,
                country: session.order!.delivery.country,
                direction: 'return',
                relatedReference: record.data.originalReference,
              });
      if (
        shipment.method !== session.order!.shipping.method ||
        shipment.country !== session.order!.delivery.country
      )
        throw new ConflictException(
          'Return shipment details do not match the order',
        );
      await this.syncShipment(id, shipment);
    }
    record = (await this.read(id))!;
    if (
      record.data.claim &&
      !['approved', 'rejected'].includes(record.data.claim.result?.status ?? '')
    ) {
      const adapter = this.delivery.create(record.data.provider);
      if (!adapter.createClaim || !adapter.getClaim)
        throw new Error('Carrier does not support claims');
      const shipmentReference =
        record.kind === 'failed_delivery'
          ? record.data.originalReference
          : record.id;
      const result = record.data.claim.result
        ? await adapter.getClaim(record.id)
        : await adapter.createClaim({
            reference: record.id,
            shipmentReference,
            notes: record.data.claim.notes,
          });
      if (
        result.reference !== record.id ||
        result.shipmentReference !== shipmentReference
      )
        throw new Error('Carrier claim reference mismatch');
      await this.mutate(id, (current) => {
        if (
          current.data.claim &&
          current.data.claim.result?.status !== result.status
        ) {
          current.data.claim.result = result;
          this.event(
            current,
            `Carrier claim ${result.status}. ${result.resolution}`,
          );
        }
      });
    }
    record = (await this.read(id))!;
    if (record.data.refund?.status === 'pending') {
      const session = await this.products.withStockTransaction((manager) =>
        this.paid(manager, record!.checkoutId),
      );
      const adapter = this.payments.create(session.payment!.provider);
      if (!adapter.refund) throw new Error('Provider does not support refunds');
      const result = await adapter.refund({
        reference: record.id,
        paymentReference: session.payment!.id,
        amountCents: record.data.refund.amountCents,
      });
      if (result.status === 'succeeded' || result.status === 'failed')
        await this.mutate(id, (current) => {
          if (current.data.refund?.status === 'pending') {
            current.data.refund.status = result.status;
            this.event(
              current,
              result.status === 'succeeded'
                ? 'Approved refund completed by the payment provider.'
                : 'Refund was rejected by the payment provider. Seller review is required.',
            );
          }
        });
    }
  }
  private async syncShipment(id: string, shipment: ProviderShipment) {
    await this.mutate(id, (record) => {
      const reference =
        record.kind === 'failed_delivery'
          ? record.data.originalReference
          : record.id;
      const previous = record.data.shipment;
      if (
        record.kind === 'buyer_request' &&
        (shipment.direction !== 'return' ||
          shipment.relatedReference !== record.data.originalReference)
      )
        throw new ConflictException(
          'Return shipment direction or original reference mismatch',
        );
      if (
        shipment.reference !== reference ||
        (previous && shipment.trackingNumber !== previous.trackingNumber)
      )
        throw new ConflictException('Return shipment mismatch');
      if (previous && shipment.version < previous.version) return;
      if (
        previous?.events.some(
          (event, index) =>
            event.sequence !== shipment.events[index]?.sequence ||
            event.status !== shipment.events[index]?.status ||
            event.occurredAt !== shipment.events[index]?.occurredAt,
        )
      )
        throw new ConflictException('Return tracking history changed');
      if (
        !['approved', 'awaiting_shipment', 'in_transit'].includes(record.status)
      )
        return;
      record.data.shipment = shipment;
      for (const event of shipment.events.filter(
        (value) => value.sequence > (previous?.version ?? 0),
      )) {
        this.event(
          record,
          `Return tracking: ${event.status.replaceAll('_', ' ')}.`,
        );
      }
      const arrived =
        record.kind === 'failed_delivery'
          ? shipment.status === 'returned_to_sender'
          : shipment.status === 'delivered';
      record.status = arrived
        ? 'received'
        : shipment.status === 'label_created'
          ? 'awaiting_shipment'
          : 'in_transit';
      if (arrived)
        this.event(record, 'Parcel received by seller. Awaiting inspection.');
    });
  }
  async sendEmail(id: string, noticeId: string) {
    const lease = randomUUID();
    let claimed:
      | { record: OrderReturn; audience: 'buyer' | 'seller'; text: string }
      | undefined;
    await this.products.withStockTransaction(async (manager) => {
      const record = await manager.findOneBy(OrderReturn, { id });
      const notice = record?.data.notifications.find(
        (value) => value.id === noticeId,
      );
      if (
        !record ||
        !notice ||
        notice.status !== 'pending' ||
        (notice.leaseUntil ?? 0) > Date.now()
      )
        return;
      const index = record.data.notifications.indexOf(notice);
      if (
        record.data.notifications
          .slice(0, index)
          .some(
            (value) =>
              value.audience === notice.audience && value.status === 'pending',
          )
      )
        return;
      notice.lease = lease;
      notice.leaseUntil = Date.now() + 60000;
      await manager.save(OrderReturn, record);
      claimed = { record, audience: notice.audience, text: notice.text };
    });
    if (!claimed) return;
    try {
      const user = await this.users.findById(
        claimed.audience === 'buyer'
          ? claimed.record.buyerId
          : claimed.record.sellerId,
      );
      const to =
        user?.emailVerifiedAt && user.email && isEmail(user.email)
          ? user.email
          : null;
      if (to) {
        const url = `${this.payments.shopOrigin}/returns/${id}`;
        await this.email.create().send({
          id: noticeId,
          to,
          subject: 'Nest Shop return update',
          text: `${claimed.text}\n${url}`,
          html: hbs.handlebars.compile(
            '<div style="font:16px Arial;color:#242b25;background:#f7f6f2;padding:24px"><h1 style="color:#526b44">Nest Shop.</h1><h2>Return update</h2><p>{{text}}</p><a href="{{url}}">View return details</a></div>',
          )({ text: claimed.text, url }),
        });
      }
      await this.mutate(id, (record) => {
        const notice = record.data.notifications.find(
          (value) => value.id === noticeId,
        )!;
        if (notice.lease === lease) {
          notice.status = to
            ? this.email.mode === 'LOG'
              ? 'logged'
              : 'sent'
            : 'skipped';
          notice.leaseUntil = 0;
        }
      });
    } catch {
      await this.mutate(id, (record) => {
        const notice = record.data.notifications.find(
          (value) => value.id === noticeId,
        )!;
        if (notice.lease === lease) notice.leaseUntil = 0;
      });
      throw new Error('Return email will retry');
    }
  }
}
