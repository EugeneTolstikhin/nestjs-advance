import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { join } from 'node:path';
import type { OrderRecord } from '../payments/payment-records';
export interface InvoiceInput {
  number: string;
  order: OrderRecord;
  sellerOrder: OrderRecord['sellerOrders'][number];
}
export interface InvoiceRenderer {
  render(input: InvoiceInput): Promise<Buffer>;
}
class PdfKitInvoiceRenderer implements InvoiceRenderer {
  render(input: InvoiceInput): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 48,
        bufferPages: true,
        info: {
          Title: `Demo invoice ${input.number}`,
          Author: 'Nest Shop',
          CreationDate: new Date(input.order.paidAt ?? input.order.createdAt),
        },
      });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const fonts = join(__dirname, 'fonts');
      doc.registerFont('Body', join(fonts, 'NotoSans-Regular.ttf'));
      doc.registerFont('Bold', join(fonts, 'NotoSans-Bold.ttf'));
      const money = (cents: number) =>
        new Intl.NumberFormat('en-IE', {
          style: 'currency',
          currency: 'EUR',
        }).format(cents / 100);
      const text = (value: string) =>
        // Strip non-printing controls from customer-provided PDF text.
        // oxlint-disable-next-line no-control-regex
        value.replace(/[\x00-\x08\x0b-\x1f]/g, '');
      const page = () => {
        if (doc.y > 700) doc.addPage();
      };
      doc.font('Bold').fontSize(22).fillColor('#526b44').text('Nest Shop.');
      doc
        .moveDown(0.4)
        .font('Bold')
        .fontSize(10)
        .fillColor('#64501b')
        .text('DEVELOPMENT DEMO - NOT A TAX INVOICE');
      doc
        .moveDown()
        .font('Bold')
        .fontSize(25)
        .fillColor('#242b25')
        .text('Invoice');
      doc
        .moveDown(0.5)
        .font('Body')
        .fontSize(9)
        .text(`Number: ${input.number}`);
      doc.text(
        `Issued: ${new Date(input.order.paidAt ?? input.order.createdAt).toISOString().slice(0, 10)}`,
      );
      doc.text(`Order: ${input.order.id}`);
      doc.text(`Seller order: ${input.sellerOrder.id}`);
      doc.moveDown().font('Bold').fontSize(11).text('Demo seller');
      doc.font('Body').fontSize(9).text(input.sellerOrder.sellerId);
      doc.moveDown().font('Bold').fontSize(11).text('Deliver to');
      doc
        .font('Body')
        .fontSize(10)
        .text(
          text(
            [
              input.order.delivery.fullName,
              input.order.delivery.addressLine1,
              input.order.delivery.addressLine2,
              `${input.order.delivery.postalCode} ${input.order.delivery.city}`,
              'Germany',
            ]
              .filter(Boolean)
              .join('\n'),
          ),
        );
      doc.moveDown(1.3).font('Bold').fontSize(11).text('Purchased items');
      for (const item of input.sellerOrder.items) {
        page();
        const name = text(item.name);
        const height = doc
          .font('Bold')
          .fontSize(10)
          .heightOfString(name, { width: 350 });
        if (doc.y + height + 36 > 735) doc.addPage();
        doc
          .font('Bold')
          .fontSize(10)
          .fillColor('#242b25')
          .text(name, { width: 490 });
        doc
          .font('Body')
          .fontSize(10)
          .fillColor('#62695f')
          .text(
            `${item.quantity} × ${money(item.unitPriceCents)} = ${money(item.lineTotalCents)}`,
          );
        doc.moveDown(0.7);
      }
      if (doc.y > 630) doc.addPage();
      doc
        .moveDown()
        .font('Body')
        .fontSize(11)
        .fillColor('#242b25')
        .text(
          `Items subtotal: ${money(input.sellerOrder.totalCents - input.sellerOrder.shippingCents)}`,
        );
      doc.text(`Shipping: ${money(input.sellerOrder.shippingCents)}`);
      doc
        .moveDown(0.4)
        .font('Bold')
        .fontSize(16)
        .text(`Paid total: ${money(input.sellerOrder.totalCents)}`);
      doc
        .moveDown()
        .font('Body')
        .fontSize(9)
        .fillColor('#62695f')
        .text(
          'Paid using the development payment flow. Tax, VAT and legal issuer information are not configured. This document is for testing only.',
        );
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(i);
        doc
          .font('Body')
          .fontSize(8)
          .fillColor('#62695f')
          .text(`Nest Shop demo · Page ${i + 1} of ${range.count}`, 48, 780, {
            width: 490,
            align: 'center',
            lineBreak: false,
          });
      }
      doc.end();
    });
  }
}
@Injectable()
export class InvoiceRendererFactory {
  private readonly renderer: InvoiceRenderer;
  constructor() {
    if ((process.env.INVOICE_RENDERER ?? 'pdfkit') !== 'pdfkit')
      throw new Error('Unknown invoice renderer');
    this.renderer = new PdfKitInvoiceRenderer();
  }
  create() {
    return this.renderer;
  }
}
