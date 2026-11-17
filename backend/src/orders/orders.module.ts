import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProductsModule } from '../products/products.module';
import { JobsModule } from '../jobs/job-queue';
import { OrderConfirmationService } from './order-confirmation.service';
import { OrderConfirmationController } from './order-confirmation.controller';
import { DeliveryProviderFactory } from './delivery-provider';
import { InvoiceRendererFactory } from './invoice-renderer';
import { EmailModule } from '../user-interaction/email/email.module';
@Module({
  imports: [AuthModule, ProductsModule, JobsModule, EmailModule],
  providers: [
    OrderConfirmationService,
    DeliveryProviderFactory,
    InvoiceRendererFactory,
  ],
  controllers: [OrderConfirmationController],
})
export class OrdersModule {}
