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
        private readonly productRepository: Repository<ProductEntity>
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
        return this.productRepository.find({
            order: { createdAt: 'ASC', id: 'ASC' },
            take: limit,
            skip,
        });
    }

    async getProductById({ id }: GetProductByIdDto): Promise<ProductEntity> {
        const product = await this.productRepository.findOneBy({ id });
        if (!product) {
            throw new NotFoundException(`Product with ID ${id} not found`);
        }
        return product;
    }

    async createProduct(product: CreateProductDto): Promise<ProductEntity> {
        const productEntity = this.productRepository.create({
            name: product.name,
            description: product.description,
            price: product.price,
            imageUrl: product.imageUrl,
        });
        return this.saveProduct(productEntity);
    }

    async updateProduct(id: string, updatedProduct: UpdateProductDto): Promise<ProductEntity> {
        const product = await this.getProductById({ id });
        product.name = updatedProduct.name;
        product.description = updatedProduct.description;
        product.price = updatedProduct.price;
        // PUT replaces editable fields; omitting the optional image removes it.
        product.imageUrl = updatedProduct.imageUrl ?? null;
        return this.saveProduct(product);
    }

    async patchProduct(id: string, updatedProduct: PatchProductDto): Promise<ProductEntity> {
        const product = await this.getProductById({ id });
        product.name = updatedProduct.name ?? product.name;
        product.description = updatedProduct.description ?? product.description;
        product.price = updatedProduct.price ?? product.price;
        if (updatedProduct.imageUrl !== undefined) {
            product.imageUrl = updatedProduct.imageUrl;
        }
        return this.saveProduct(product);
    }

    async deleteProduct({ id }: DeleteProductDto): Promise<ProductEntity[]> {
        const result = await this.productRepository.delete({ id });
        if (!result.affected) {
            throw new NotFoundException(`Product with ID ${id} not found`);
        }
        // Keep the existing API contract: return the remaining products.
        return this.getProducts();
    }

    private async saveProduct(product: ProductEntity): Promise<ProductEntity> {
        try {
            return await this.productRepository.save(product);
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
