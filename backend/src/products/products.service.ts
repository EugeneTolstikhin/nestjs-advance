import { MAX_PRODUCT_STOCK } from './stock';
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
import { EntityManager, QueryFailedError, Repository } from 'typeorm';
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
            stock: product.stock ?? 0,
        });
        return this.saveProduct(productEntity, product.mediaIds, ownerId);
    }

    async updateProduct(id: string, updatedProduct: UpdateProductDto, ownerId?: string): Promise<ProductEntity> {
        return this.saveChanges(id, updatedProduct, ownerId);
    }

    async patchProduct(id: string, updatedProduct: PatchProductDto, ownerId?: string): Promise<ProductEntity> {
        return this.saveChanges(id, updatedProduct, ownerId);
    }

    async restockProduct(id: string, quantity: number): Promise<ProductEntity> {
        return this.saveChanges(id, { restockQuantity: quantity });
    }

    // SQLite uses a shared connection: serialize transactions with product/media writes.
    withStockTransaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
        return this.media.exclusive(() => this.productRepository.manager.transaction(work));
    }

    /** Call inside withStockTransaction, in the same SQL transaction that records a completed order.
     * A conditional decrement prevents overselling; throwing rolls back every line.
     * Checkout must also enforce a unique order/payment ID before calling this.
     */
    async deductStock(items: { productId: string; quantity: number }[], manager: EntityManager): Promise<void> {
        if (!manager.queryRunner?.isTransactionActive) {
            throw new Error('Stock deduction requires the order transaction');
        }
        if (!items.length) throw new BadRequestException('The order must contain products');
        const totals = new Map<string, number>();
        for (const item of items) {
            this.validateStock(item.quantity, 1);
            const quantity = (totals.get(item.productId) ?? 0) + item.quantity;
            this.validateStock(quantity, 1);
            totals.set(item.productId, quantity);
        }
        for (const [id, quantity] of totals) {
            const result = await manager.createQueryBuilder().update(ProductEntity)
                .set({ stock: () => 'stock - :quantity' })
                .where('id = :id AND stock >= :quantity', { id, quantity }).execute();
            if (result.affected !== 1) {
                throw new ConflictException('A product is missing or has insufficient stock. Refresh your cart.');
            }
        }
    }

    private validateStock(value: number, min = 0) {
        if (!Number.isInteger(value) || value < min || value > MAX_PRODUCT_STOCK) {
            throw new BadRequestException(`Stock must be an integer between ${min} and ${MAX_PRODUCT_STOCK}`);
        }
    }

    private async saveChanges(id: string, changes: PatchProductDto, ownerId?: string): Promise<ProductEntity> {
        return this.saveProduct(async manager => {
            // Read within the transaction, rather than saving a stale entity with an old stock count.
            const product = await manager.findOneBy(ProductEntity, { id });
            if (!product) throw new NotFoundException(`Product with ID ${id} not found`);
            if (changes.stock !== undefined) {
                this.validateStock(changes.stock);
                if (changes.restockQuantity !== undefined) throw new BadRequestException('Set stock or add a delivery, not both');
                if (changes.expectedStock === undefined) throw new BadRequestException('expectedStock is required when setting stock');
                this.validateStock(changes.expectedStock);
                if (product.stock !== changes.expectedStock) {
                    throw new ConflictException('Stock changed since you opened this page. Reload before correcting the stock count.');
                }
                product.stock = changes.stock;
            } else if (changes.expectedStock !== undefined) {
                throw new BadRequestException('expectedStock requires a new stock count');
            }
            if (changes.restockQuantity !== undefined) {
                this.validateStock(changes.restockQuantity, 1);
                this.validateStock(product.stock + changes.restockQuantity);
                product.stock += changes.restockQuantity;
            }
            product.name = changes.name ?? product.name;
            product.description = changes.description ?? product.description;
            product.price = changes.price ?? product.price;
            return product;
        }, changes.mediaIds, ownerId);
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

    private async saveProduct(product: ProductEntity | ((manager: EntityManager) => Promise<ProductEntity>), mediaIds?: string[], ownerId?: string): Promise<ProductEntity> {
        try {
            const saved = await this.media.exclusive(() => this.productRepository.manager.transaction(async manager => {
                const entity = typeof product === 'function' ? await product(manager) : product;
                this.validateStock(entity.stock);
                const saved = await manager.save(ProductEntity, entity);
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
