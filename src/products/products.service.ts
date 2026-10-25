import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { 
    Product,
    CreateProductDto,
    UpdateProductDto,
    DeleteProductDto,
    GetProductByIdDto,
    PatchProductDto,
 } from './products.dto';

@Injectable()
export class ProductsService {
    private products: Product[] = [];
    private nextId = 1;

    getProducts(): Product[] {
        return [...this.products];
    }

    getProductById( id : GetProductByIdDto): Product {
        const product = this.products.find(product => product.id === id.id);
        if (!product) {
            throw new NotFoundException(`Product with ID ${id.id} not found`);
        }
        return product;
    }

    createProduct(product: CreateProductDto): Product {
        const productsAmountBeforeCreate = this.products.length;
        const newProduct = new Product(
            this.nextId++,
            product.name,
            product.description,
            product.price,
            product.imageUrl,
        );
        this.products.push(newProduct);
        if (productsAmountBeforeCreate === this.products.length) {
            throw new BadRequestException('Failed to create product');
        }
        return newProduct;
    }

    updateProduct(updatedProduct: UpdateProductDto): Product {
        const index = this.products.findIndex(product => product.id === updatedProduct.id);
        if (index !== -1) {
            const existingProduct = this.products[index];
            this.products[index] = new Product(
                existingProduct.id,
                updatedProduct.name ?? existingProduct.name,
                updatedProduct.description ?? existingProduct.description,
                updatedProduct.price ?? existingProduct.price,
                updatedProduct.imageUrl ?? existingProduct.imageUrl,
            );
            return this.products[index];
        }
        throw new NotFoundException(`Product with ID ${updatedProduct.id} not found`);
    }

    patchProduct(updatedProduct: PatchProductDto): Product {
        const index = this.products.findIndex(product => product.id === updatedProduct.id);
        if (index !== -1) {
            const existingProduct = this.products[index];
            this.products[index] = new Product(
                existingProduct.id,
                updatedProduct.name ?? existingProduct.name,
                updatedProduct.description ?? existingProduct.description,
                updatedProduct.price ?? existingProduct.price,
                updatedProduct.imageUrl ?? existingProduct.imageUrl,
            );
            return this.products[index];
        }
        throw new NotFoundException(`Product with ID ${updatedProduct.id} not found`);
    }

    deleteProduct(id: DeleteProductDto): Product[] {
        const productsAmountBeforeDelete = this.products.length;
        this.products = this.products.filter(product => product.id !== id.id);
        if (productsAmountBeforeDelete === this.products.length) {
            throw new NotFoundException(`Product with ID ${id.id} not found`);
        }
        return this.products;
    }
}
