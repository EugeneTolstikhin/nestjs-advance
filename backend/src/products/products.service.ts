import { ProductMediaService } from './media/product-media.service';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { 
    CreateProductDto,
    UpdateProductDto,
    DeleteProductDto,
    GetProductByIdDto,
    PatchProductDto,
 } from './products.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { Products as ProductEntity } from './products.entity';

@Injectable()
export class ProductsService {
    constructor(
        @InjectRepository(ProductEntity)
        private readonly productRepository: Repository<ProductEntity>,
        private readonly media: ProductMediaService
    ) {}
    async getProducts(limit?: number, page?: number): Promise<ProductEntity[]> {
        if ((limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) ||
            (page !== undefined && (!Number.isSafeInteger(page) || page < 1))) {
            throw new BadRequestException('limit and page must be positive integers');
        }
        if (page !== undefined && limit === undefined) {
            throw new BadRequestException('limit is required when page is provided');
        }
        const skip = limit === undefined ? undefined : ((page ?? 1) - 1) * limit;
        if (skip !== undefined && !Number.isSafeInteger(skip)) {
            throw new BadRequestException('Pagination offset is too large');
        }
        const products = await this.productRepository.find({
            order: { createdAt: 'ASC', id: 'ASC' },
            take: limit,
            skip,
        });
        return this.media.decorate(products);
    }

    async getProductById({ id }: GetProductByIdDto): Promise<ProductEntity> {
        const product = await this.productRepository.findOneBy({ id });
        if (!product) {
            throw new NotFoundException(`Product with ID ${id} not found`);
        }
        return (await this.media.decorate([product]))[0];
    }

    async createProduct(product: CreateProductDto, ownerId?: string): Promise<ProductEntity> {
        const productEntity = this.productRepository.create({
            name: product.name,
            description: product.description,
            price: product.price,
        });
        return this.saveProduct(productEntity, product.mediaIds, ownerId);
    }

    async updateProduct(id: string, updatedProduct: UpdateProductDto, ownerId?: string): Promise<ProductEntity> {
        const product = await this.getProductById({ id });
        product.name = updatedProduct.name;
        product.description = updatedProduct.description;
        product.price = updatedProduct.price;
        return this.saveProduct(product, updatedProduct.mediaIds, ownerId);
    }

    async patchProduct(id: string, updatedProduct: PatchProductDto, ownerId?: string): Promise<ProductEntity> {
        const product = await this.getProductById({ id });
        product.name = updatedProduct.name ?? product.name;
        product.description = updatedProduct.description ?? product.description;
        product.price = updatedProduct.price ?? product.price;
        return this.saveProduct(product, updatedProduct.mediaIds, ownerId);
    }

    async deleteProduct({ id }: DeleteProductDto): Promise<ProductEntity[]> {
        const result = await this.media.exclusive(() => this.productRepository.manager.transaction(async manager => {
            const deleted = await manager.delete(ProductEntity, { id });
            if (deleted.affected) await this.media.detach(manager, id);
            return deleted;
        }));
        if (!result.affected) {
            throw new NotFoundException(`Product with ID ${id} not found`);
        }
        await this.media.cleanup().catch(() => {});
        // Keep the existing API contract: return the remaining products.
        return this.getProducts();
    }

    private async saveProduct(product: ProductEntity, mediaIds?: string[], ownerId?: string): Promise<ProductEntity> {
        try {
            const saved = await this.media.exclusive(() => this.productRepository.manager.transaction(async manager => {
                const saved = await manager.save(ProductEntity, product);
                if (mediaIds !== undefined) await this.media.attach(manager, saved.id, mediaIds, ownerId);
                return (await this.media.decorate([saved], manager))[0];
            }));
            await this.media.cleanup().catch(() => {});
            return saved;
        } catch (error) {
            // The database constraint also protects against simultaneous requests.
            if (error instanceof QueryFailedError &&
                error.driverError.code === 'SQLITE_CONSTRAINT_UNIQUE' &&
                error.driverError.message === 'UNIQUE constraint failed: products.name') {
                throw new ConflictException('A product with this name already exists');
            }
            throw error;
        }
    }

}
