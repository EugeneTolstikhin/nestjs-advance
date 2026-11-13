import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CartModule } from '../cart/cart.module';
import { ProductsModule } from '../products/products.module';
import { CheckoutController } from './checkout.controller';
import { CheckoutService } from './checkout.service';
import { PaymentsService } from '../payments/payments.service';
import { PaymentProviderFactory } from '../payments/payment-provider';
import { JobsModule } from '../jobs/job-queue';

@Module({
  imports: [AuthModule, CartModule, ProductsModule, JobsModule],
  providers: [CheckoutService, PaymentsService, PaymentProviderFactory],
  controllers: [CheckoutController],
})
export class CheckoutModule {}
