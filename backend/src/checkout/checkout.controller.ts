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
import { CheckoutService } from './checkout.service';

class CheckoutIdDto {
  @IsUUID('4') id: string;
}
class ReserveCheckoutDto {
  @IsString() @Matches(/^[a-f0-9]{64}$/) quoteHash: string;
}
class CancelCheckoutDto {
  @IsInt() @Min(1) revision: number;
}

@Controller('checkout')
@UseGuards(SessionAuthGuard, SameOriginGuard)
@Roles(TypeOfUser.Buyer)
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @Render('checkout')
  page() {
    return { title: 'Checkout' };
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
