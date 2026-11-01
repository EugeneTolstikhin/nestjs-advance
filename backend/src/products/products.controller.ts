import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Query, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ProductsService } from './products.service';
import { CreateProductDto, DeleteProductDto, GetProductByIdDto, UpdateProductDto, PatchProductDto } from './products.dto';
import { AuthGuard } from '../auth/guard/auth.guard';
import { Roles } from '../auth/guard/roles.decorator';
import { TypeOfUser } from '../auth/auth.dto';
import { Products as ProductEntity } from './products.entity';

@Controller('products')
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
export class ProductsController {
    constructor (private readonly productsService: ProductsService) {}

    @Get()
    getProducts(
        @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
        @Query('page', new ParseIntPipe({ optional: true })) page?: number
    ): Promise<ProductEntity[]> {
        return this.productsService.getProducts(limit, page);
    }

    @Get(':id')
    getProductById(@Param() dto: GetProductByIdDto): Promise<ProductEntity> {
        return this.productsService.getProductById(dto);
    }

    @Post()
    @UseGuards(AuthGuard)
    @Roles(TypeOfUser.Seller)
    createProduct(@Body() dto: CreateProductDto): Promise<ProductEntity> {
        return this.productsService.createProduct(dto);
    }

    @Put(':id')
    @UseGuards(AuthGuard)
    @Roles(TypeOfUser.Seller)
    updateProduct(
        @Param() params: GetProductByIdDto,
        @Body() dto: UpdateProductDto
    ): Promise<ProductEntity> {
        return this.productsService.updateProduct(params.id, dto);
    }

    @Patch(':id')
    @UseGuards(AuthGuard)
    @Roles(TypeOfUser.Seller)
    patchProduct(
        @Param() params: GetProductByIdDto,
        @Body() dto: PatchProductDto
    ): Promise<ProductEntity> {
        return this.productsService.patchProduct(params.id, dto);
    }

    @Delete(':id')
    @UseGuards(AuthGuard)
    @Roles(TypeOfUser.Seller, TypeOfUser.Admin)
    deleteProduct(@Param() dto: DeleteProductDto): Promise<ProductEntity[]> {
        return this.productsService.deleteProduct(dto);
    }
}
