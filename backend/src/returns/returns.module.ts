import { OrderPresentationModule } from '../orders/order-presentation.service';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProductsModule } from '../products/products.module';
import { JobsModule } from '../jobs/job-queue';
import { EmailModule } from '../user-interaction/email/email.module';
import { DeliveryProviderFactory } from '../orders/delivery-provider';
import { PaymentProviderFactory } from '../payments/payment-provider';
import { ReturnsService } from './returns.service';
import { ReturnsController } from './returns.controller';
@Module({
  imports: [
    AuthModule,
    ProductsModule,
    JobsModule,
    EmailModule,
    OrderPresentationModule,
  ],
  providers: [ReturnsService, DeliveryProviderFactory, PaymentProviderFactory],
  controllers: [ReturnsController],
})
export class ReturnsModule {}
