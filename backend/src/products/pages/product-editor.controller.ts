import {
    Controller,
    Get,
    Header,
    Param,
    Render,
    Req,
    UnauthorizedException,
    UseGuards,
    UsePipes,
    ValidationPipe
} from '@nestjs/common';
import { SessionAuthGuard } from '../../auth/guard/session-auth.guard';
import { Roles } from '../../auth/guard/roles.decorator';
import { TypeOfUser } from '../../auth/auth.dto';
import { ProductsService } from '../products.service';
import { GetProductByIdDto } from '../products.dto';
import { productForm } from './product-form';
import type { AuthRequest } from '../../auth/utils/auth-request';

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
    async edit(@Param() dto: GetProductByIdDto, @Req() request: AuthRequest) {
        if (!request.user) {
            throw new UnauthorizedException('User not authenticated');
        }
        await this.products.getOwnedProductById(dto, request.user.sub); // Ensure the product exists and belongs to the user
        return { title: 'Edit product', productId: dto.id };
    }

    @Get('product-schema')
    @Header('Cache-Control', 'no-store')
    schema() { return productForm(); }
}
