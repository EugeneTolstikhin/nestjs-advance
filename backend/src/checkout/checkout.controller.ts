import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Render,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { IsInt, IsString, IsUUID, Matches, Min } from 'class-validator';
import { SessionAuthGuard } from '../auth/guard/session-auth.guard';
import { SameOriginGuard } from '../auth/guard/same-origin.guard';
import { Roles } from '../auth/guard/roles.decorator';
import { TypeOfUser } from '../auth/auth.dto';
import type { AuthRequest } from '../auth/utils/auth-request';
import { PaymentsService } from '../payments/payments.service';
import { PaymentProviderFactory } from '../payments/payment-provider';
import { MaskPii } from '../interceptor/pii/mask-pii.decorator';
import { CheckoutService } from './checkout.service';
import {
  CheckoutRevisionDto,
  DeliveryDetailsDto,
  SelectShippingDto,
  StartPaymentDto,
  RetryCheckoutDto,
} from './checkout-details.dto';

class CheckoutIdDto {
  @IsUUID('4') id: string;
}
class ReserveCheckoutDto {
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  quoteHash: string;
}
class CancelCheckoutDto {
  @IsInt()
  @Min(1)
  revision: number;
}

@Controller('checkout')
@MaskPii(false) // Delivery details are returned only to the authenticated checkout owner.
@UseGuards(SessionAuthGuard, SameOriginGuard)
@Roles(TypeOfUser.Buyer)
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
export class CheckoutController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly payments: PaymentsService,
    private readonly providers: PaymentProviderFactory,
  ) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @Render('checkout')
  page() {
    return {
      title: 'Checkout',
      paymentsEnabled: this.providers.options().length > 0,
      paymentOptions: this.providers.options(),
    };
  }

  @Get('data')
  @Header('Cache-Control', 'no-store')
  preview(@Req() request: AuthRequest) {
    return this.checkout.preview(request.user!.sub);
  }

  @Post('reservations')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  reserve(@Req() request: AuthRequest, @Body() dto: ReserveCheckoutDto) {
    return this.checkout.reserve(request.user!.sub, dto.quoteHash);
  }

  @Post(':id/delivery')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  delivery(
    @Req() request: AuthRequest,
    @Param() params: CheckoutIdDto,
    @Body() body: DeliveryDetailsDto,
  ) {
    return this.checkout.saveDelivery(request.user!.sub, params.id, body);
  }

  @Post(':id/shipping')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  shipping(
    @Req() request: AuthRequest,
    @Param() params: CheckoutIdDto,
    @Body() body: SelectShippingDto,
  ) {
    return this.checkout.selectShipping(request.user!.sub, params.id, body);
  }

  @Get('payment-options')
  @Header('Cache-Control', 'no-store')
  paymentOptions() {
    return this.providers.options();
  }

  @Post(':id/payment')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  payment(
    @Req() request: AuthRequest,
    @Param() params: CheckoutIdDto,
    @Body() body: StartPaymentDto,
  ) {
    return this.payments.start(
      request.user!.sub,
      params.id,
      body.revision,
      body.optionId,
    );
  }

  @Post(':id/retry')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  retry(
    @Req() request: AuthRequest,
    @Param() params: CheckoutIdDto,
    @Body() body: RetryCheckoutDto,
  ) {
    return this.checkout.retry(
      request.user!.sub,
      params.id,
      body.revision,
      body.quoteHash,
    );
  }

  @Post(':id/back')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  back(
    @Req() request: AuthRequest,
    @Param() params: CheckoutIdDto,
    @Body() body: CheckoutRevisionDto,
  ) {
    return this.checkout.back(request.user!.sub, params.id, body.revision);
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  get(@Req() request: AuthRequest, @Param() dto: CheckoutIdDto) {
    return this.checkout.get(request.user!.sub, dto.id);
  }

  @Delete(':id')
  @Header('Cache-Control', 'no-store')
  cancel(
    @Req() request: AuthRequest,
    @Param() dto: CheckoutIdDto,
    @Body() body: CancelCheckoutDto,
  ) {
    return this.checkout.cancel(request.user!.sub, dto.id, body.revision);
  }
}
