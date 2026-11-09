import { Controller, Get, Header, Render, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { AuthRequest } from '../../auth/utils/auth-request';
import { TypeOfUser } from '../../auth/auth.dto';
import { ProductsService } from '../products.service';
import { Roles } from '../../auth/guard/roles.decorator';
import { SessionAuthGuard } from '../../auth/guard/session-auth.guard';

@Controller('my-shop')
export class MyProductsPageController {
    constructor(private readonly productsService: ProductsService) {}

    @Get()
    @Header('Cache-Control', 'no-store')
    @Render('my-products')
    @UseGuards(SessionAuthGuard)
    @Roles(TypeOfUser.Seller)
    async getMyProductsPage(@Req() request: AuthRequest) {
        if (!request.user) {
            throw new UnauthorizedException('User not authenticated');
        }
        const products = await this.productsService.getMyProducts(request.user.sub);
        const roles: TypeOfUser[] = request.user.roles ?? [];
        return {
            title: 'My Products',
            canEditProducts: roles.includes(TypeOfUser.Seller),
            canDeleteProducts: roles.includes(TypeOfUser.Seller) || roles.includes(TypeOfUser.Admin),
            products: products.map(product => ({
                id: product.id,
                name: product.name,
                stock: product.stock,
                inStock: product.stock > 0,
                description: product.description,
                media: product.media?.map((item, index) => ({ ...item, label: `${item.isVideo ? 'Video' : 'Photo'} ${index + 1}` })),
                price: product.price.toFixed(2),
            })),
        };
    }
}
