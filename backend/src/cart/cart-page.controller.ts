import { Controller, Get, Header, Render, Res } from '@nestjs/common';
import type { Response } from 'express';
import { TypeOfUser } from '../auth/auth.dto';
import { CartService } from './cart.service';

@Controller('cart')
export class CartPageController {
    constructor(private readonly cart: CartService) {}
    @Get()
    @Header('Cache-Control', 'no-store')
    @Render('cart')
    async page(@Res({ passthrough: true }) response: Response) {
        const user = response.locals.user;
        if (!user) return { title: 'Shopping cart', guest: true };
        if (!user.roles.includes(TypeOfUser.Buyer)) return { title: 'Shopping cart', restricted: true };
        const cart = await this.cart.get(user.id);
        return { title: 'Shopping cart', buyer: true, ...cart,
            total: cart.total.toFixed(2), items: cart.items.map(item => ({ ...item,
                unitPrice: item.unitPrice?.toFixed(2), lineTotal: item.lineTotal?.toFixed(2),
                canIncrease: item.canIncrease,
            })) };
    }
}
