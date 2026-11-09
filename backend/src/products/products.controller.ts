import type { AuthRequest } from '../auth/utils/auth-request';
import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Req, Put, Query, UseGuards, UsePipes, ValidationPipe, UnauthorizedException } from '@nestjs/common';
import { ProductsService } from './products.service';
import { RestockProductDto, CreateProductDto, DeleteProductDto, GetProductByIdDto, UpdateProductDto, PatchProductDto } from './products.dto';
import { SessionAuthGuard } from '../auth/guard/session-auth.guard';
import { SameOriginGuard } from '../auth/guard/same-origin.guard';
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

    @Get('my')
    @UseGuards(SameOriginGuard, SessionAuthGuard)
    @Roles(TypeOfUser.Seller)
    getMyProducts(
        @Req() request: AuthRequest,
        @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
        @Query('page', new ParseIntPipe({ optional: true })) page?: number
    ): Promise<ProductEntity[]> {
        if (!request.user) {
            throw new UnauthorizedException('User not authenticated');
        }
        return this.productsService.getMyProducts(request.user.sub, limit, page);
    }

    @Get(':id')
    getProductById(@Param() dto: GetProductByIdDto): Promise<ProductEntity> {
        return this.productsService.getProductById(dto);
    }

    @Post()
    @UseGuards(SameOriginGuard, SessionAuthGuard)
    @Roles(TypeOfUser.Seller)
    createProduct(@Body() dto: CreateProductDto, @Req() request: AuthRequest): Promise<ProductEntity> {
        if (!request.user) {
            throw new UnauthorizedException('User not authenticated');
        }
        return this.productsService.createProduct(dto, request.user.sub);
    }

    @Put(':id')
    @UseGuards(SameOriginGuard, SessionAuthGuard)
    @Roles(TypeOfUser.Seller)
    updateProduct(
        @Param() params: GetProductByIdDto,
        @Body() dto: UpdateProductDto,
        @Req() request: AuthRequest
    ): Promise<ProductEntity> {
        if (!request.user) {
            throw new UnauthorizedException('User not authenticated');
        }
        return this.productsService.updateProduct(params.id, dto, request.user.sub);
    }

    @Patch(':id')
    @UseGuards(SameOriginGuard, SessionAuthGuard)
    @Roles(TypeOfUser.Seller)
    patchProduct(
        @Param() params: GetProductByIdDto,
        @Body() dto: PatchProductDto,
        @Req() request: AuthRequest
    ): Promise<ProductEntity> {
        if (!request.user) {
            throw new UnauthorizedException('User not authenticated');
        }
        return this.productsService.patchProduct(params.id, dto, request.user.sub);
    }

    @Post(':id/restock')
    @UseGuards(SameOriginGuard, SessionAuthGuard)
    @Roles(TypeOfUser.Seller)
    restockProduct(
        @Param() params: GetProductByIdDto,
        @Body() dto: RestockProductDto,
        @Req() request: AuthRequest
    ): Promise<ProductEntity> {
        if (!request.user) {
            throw new UnauthorizedException('User not authenticated');
        }
        return this.productsService.restockProduct(params.id, dto.quantity, request.user.sub);
    }

    @Delete(':id')
    @UseGuards(SameOriginGuard, SessionAuthGuard)
    @Roles(TypeOfUser.Seller, TypeOfUser.Admin)
    deleteProduct(
        @Param() dto: DeleteProductDto,
        @Req() request: AuthRequest
    ): Promise<ProductEntity[]> {
        if (!request.user) {
            throw new UnauthorizedException('User not authenticated');
        }
        return this.productsService.deleteProduct(dto, request.user.sub, {
            isAdmin: request.user.roles.includes(TypeOfUser.Admin),
        });
    }
}
