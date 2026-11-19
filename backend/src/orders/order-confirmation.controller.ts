import {
  Controller,
  Get,
  Header,
  Param,
  Query,
  Render,
  Req,
  Res,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { IsUUID } from 'class-validator';
import type { Response } from 'express';
import type { AuthRequest } from '../auth/utils/auth-request';
import { SessionAuthGuard } from '../auth/guard/session-auth.guard';
import { Roles } from '../auth/guard/roles.decorator';
import { TypeOfUser } from '../auth/auth.dto';
import { MaskPii } from '../interceptor/pii/mask-pii.decorator';
import { OrderConfirmationService } from './order-confirmation.service';
class OrderIdDto {
  @IsUUID('4') id: string;
}
class InvoiceIdDto extends OrderIdDto {
  @IsUUID('4') sellerOrderId: string;
}
@Controller('orders')
@UseGuards(SessionAuthGuard)
@Roles(TypeOfUser.Buyer, TypeOfUser.Seller)
@MaskPii(false)
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
export class OrderConfirmationController {
  constructor(private readonly orders: OrderConfirmationService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @Render('orders')
  async history(@Req() request: AuthRequest) {
    return {
      title: 'My orders',
      orders: await this.orders.history(request.user!.sub),
      canReviewReturns: request.user!.roles.includes(TypeOfUser.Seller),
    };
  }
  @Roles(TypeOfUser.Buyer)
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @Render('order-confirmation')
  async page(@Req() request: AuthRequest, @Param() params: OrderIdDto) {
    await this.orders.owned(request.user!.sub, params.id);
    return { title: 'Order confirmation', checkoutId: params.id };
  }
  @Roles(TypeOfUser.Buyer)
  @Get(':id/data')
  @Header('Cache-Control', 'no-store')
  get(@Req() request: AuthRequest, @Param() params: OrderIdDto) {
    return this.orders.view(request.user!.sub, params.id);
  }
  @Roles(TypeOfUser.Buyer)
  @Get(':id/invoices/:sellerOrderId')
  @Header('Cache-Control', 'private, no-store')
  async invoice(
    @Req() request: AuthRequest,
    @Param() params: InvoiceIdDto,
    @Query('inline') inline: string | undefined,
    @Res() response: Response,
  ) {
    const file = await this.orders.invoiceFile(
      request.user!.sub,
      params.id,
      params.sellerOrderId,
    );
    response.set({
      'Content-Type': 'application/pdf',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `${inline === '1' ? 'inline' : 'attachment'}; filename="${file.filename}"`,
    });
    await new Promise<void>((resolve, reject) =>
      response.sendFile(file.path, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  }
}
