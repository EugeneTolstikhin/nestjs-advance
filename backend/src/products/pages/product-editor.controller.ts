import { Controller, Get, Header, Param, Render, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { SessionAuthGuard } from '../../auth/guard/session-auth.guard';
import { Roles } from '../../auth/guard/roles.decorator';
import { TypeOfUser } from '../../auth/auth.dto';
import { ProductsService } from '../products.service';
import { GetProductByIdDto } from '../products.dto';
import { productForm } from './product-form';

@Controller('shop')
@UseGuards(SessionAuthGuard)
@Roles(TypeOfUser.Seller)
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
export class ProductEditorController {
    constructor(private readonly products: ProductsService) {}

    @Get('new')
    @Header('Cache-Control', 'no-store')
    @Render('product-editor')
    create() { return { title: 'Add a product', productId: '' }; }

    @Get(':id/edit')
    @Header('Cache-Control', 'no-store')
    @Render('product-editor')
    async edit(@Param() dto: GetProductByIdDto) {
        await this.products.getProductById(dto);
        return { title: 'Edit product', productId: dto.id };
    }

    @Get('product-schema')
    @Header('Cache-Control', 'no-store')
    schema() { return productForm(); }
}
