import { Controller, Get, Render } from '@nestjs/common';
import { ProductsService } from '../products.service';

@Controller('shop')
export class ProductsPageController {
    constructor(private readonly productsService: ProductsService) {}

    @Get()
    @Render('products')
    async getProductsPage() {
        const products = await this.productsService.getProducts();
        return {
            title: 'Products',
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
