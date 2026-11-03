import { Controller, Get, Header, Render, Res } from '@nestjs/common';
import type { Response } from 'express';
import { TypeOfUser } from '../../auth/auth.dto';
import { ProductsService } from '../products.service';

@Controller('shop')
export class ProductsPageController {
    constructor(private readonly productsService: ProductsService) {}

    @Get()
    @Header('Cache-Control', 'no-store')
    @Render('products')
    async getProductsPage(@Res({ passthrough: true }) response?: Response) {
        const products = await this.productsService.getProducts();
        const roles: TypeOfUser[] = response?.locals.user?.roles ?? [];
        return {
            title: 'Products',
            canEditProducts: roles.includes(TypeOfUser.Seller),
            canDeleteProducts: roles.includes(TypeOfUser.Seller) || roles.includes(TypeOfUser.Admin),
            products: products.map(product => ({
                id: product.id,
                name: product.name,
                description: product.description,
                imageUrl: product.imageUrl,
                price: product.price.toFixed(2),
            })),
        };
    }
}
