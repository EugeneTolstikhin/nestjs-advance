import { Body, Controller, Delete, Get, Header, HttpCode, Param, Patch, Post, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { IsIn, IsUUID } from 'class-validator';
import { SessionAuthGuard } from '../auth/guard/session-auth.guard';
import { SameOriginGuard } from '../auth/guard/same-origin.guard';
import { Roles } from '../auth/guard/roles.decorator';
import { TypeOfUser } from '../auth/auth.dto';
import type { AuthRequest } from '../auth/utils/auth-request';
import { CartService } from './cart.service';

class CartProductDto { @IsUUID('4') productId: string; }
class AddCartItemDto {}
class CartQuantityDto { @IsIn([-1, 1]) delta: -1 | 1; }

@Controller('cart')
@UseGuards(SessionAuthGuard, SameOriginGuard)
@Roles(TypeOfUser.Buyer)
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
export class CartController {
    constructor(private readonly cart: CartService) {}
    @Get('data')
    @Header('Cache-Control', 'no-store')
    get(@Req() request: AuthRequest) { return this.cart.get(request.user!.sub); }

    @Post('items/:productId')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    add(@Req() request: AuthRequest, @Param() dto: CartProductDto, @Body() _body: AddCartItemDto) {
        return this.cart.add(request.user!.sub, dto.productId);
    }
    @Patch('items/:productId')
    @Header('Cache-Control', 'no-store')
    change(@Req() request: AuthRequest, @Param() dto: CartProductDto, @Body() body: CartQuantityDto) {
        return this.cart.change(request.user!.sub, dto.productId, body.delta);
    }
    @Delete('items/:productId')
    @Header('Cache-Control', 'no-store')
    remove(@Req() request: AuthRequest, @Param() dto: CartProductDto) {
        return this.cart.remove(request.user!.sub, dto.productId);
    }
}
