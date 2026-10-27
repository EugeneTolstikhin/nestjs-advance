import { Body, Controller, Delete, Get, Header, Param, ParseFilePipe, ParseFloatPipe, ParseIntPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ProductsService } from './products.service';
import { CreateProductDto, DeleteProductDto, GetProductByIdDto, Product, UpdateProductDto, PatchProductDto } from './products.dto';
import { AuthGuard } from '../auth/guard/auth.guard';
import { Roles } from '../auth/guard/roles.decorator';
import { TypeOfUser } from '../auth/auth.dto';

@Controller('products')
export class ProductsController {
    constructor (private readonly productsService: ProductsService) {}

    @Get()
    @Header('Content-Type', 'application/json') //Optional
    getProducts(
        @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
        @Query('page', new ParseIntPipe({ optional: true })) page?: number
    ): Product[] {
        return this.productsService.getProducts(limit, page);
    }

    @Get(':id')
    @Header('Content-Type', 'application/json')
    getProductById(@Param('id', ParseIntPipe) id: number): Product {
        const searchProduct = new GetProductByIdDto(id);
        return this.productsService.getProductById(searchProduct);
    }

    @Post()
    @Header('Content-Type', 'application/json')
    @UseGuards(AuthGuard)
    @Roles(TypeOfUser.Seller)
    createProduct(
        @Body('name') name: string,
        @Body('description') description: string,
        @Body('price', ParseFloatPipe) price: number,
        @Body('imageUrl', new ParseFilePipe({ fileIsRequired: false })) imageUrl?: string
    ): Product
    {
        const productDto = new CreateProductDto(name, description, price, imageUrl);
        return this.productsService.createProduct(productDto);
    }

    @Put(':id')
    @Header('Content-Type', 'application/json')
    @UseGuards(AuthGuard)
    @Roles(TypeOfUser.Seller)
    updateProduct(
        @Param('id', ParseIntPipe) id: number,
        @Body('name') name: string,
        @Body('description') description: string,
        @Body('price', ParseFloatPipe) price: number,
        @Body('imageUrl', new ParseFilePipe({ fileIsRequired: false })) imageUrl?: string
    ): Product {
        const updateProduct = new UpdateProductDto(id, name, description, price, imageUrl);
        return this.productsService.updateProduct(updateProduct);
    }

    @Patch(':id')
    @Header('Content-Type', 'application/json')
    @UseGuards(AuthGuard)
    @Roles(TypeOfUser.Seller)
    patchProduct(
        @Param('id', ParseIntPipe) id: number,
        @Body('name') name?: string,
        @Body('description') description?: string,
        @Body('price', new ParseFloatPipe({ optional: true })) price?: number,
        @Body('imageUrl', new ParseFilePipe({ fileIsRequired: false })) imageUrl?: string
    ): Product {
        const patchProduct = new PatchProductDto(id, name, description, price, imageUrl);
        return this.productsService.patchProduct(patchProduct);
    }

    @Delete(':id')
    @Header('Content-Type', 'application/json')
    @UseGuards(AuthGuard)
    @Roles(TypeOfUser.Seller, TypeOfUser.Admin)
    deleteProduct(@Param('id', ParseIntPipe) id: number): Product[] {
        const deleteProduct = new DeleteProductDto(id);
        return this.productsService.deleteProduct(deleteProduct);
    }
}
