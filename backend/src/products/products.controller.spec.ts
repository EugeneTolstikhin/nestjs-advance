import type { AuthRequest } from '../auth/utils/auth-request';
import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { CreateProductDto, DeleteProductDto, GetProductByIdDto, PatchProductDto, UpdateProductDto, RestockProductDto } from './products.dto';

const id = '550e8400-e29b-41d4-a716-446655440000';

describe('ProductsController', () => {
    const validation = Reflect.getMetadata('__pipes__', ProductsController)[0] as ValidationPipe;

    it('validates UUID path DTOs for reads and deletes', async () => {
        for (const metatype of [GetProductByIdDto, DeleteProductDto]) {
            await expect(validation.transform({ id }, { type: 'param', metatype }))
                .resolves.toMatchObject({ id });
            await expect(validation.transform({ id: '123' }, { type: 'param', metatype }))
                .rejects.toBeInstanceOf(BadRequestException);
        }
    });

    it('validates required creation and update fields and rejects unknown fields', async () => {
        await expect(validation.transform({ name: 'Book', description: 'NestJS', price: 10 },
            { type: 'body', metatype: CreateProductDto })).resolves.toMatchObject({ price: 10 });
        for (const body of [{}, { name: 'Book', description: 'NestJS', price: '10' },
            { name: 'Book', description: 'NestJS', price: 10, unexpected: true },
            { name: 'Book', description: 'NestJS', price: 10, mediaIds: null }]) {
            await expect(validation.transform(body, { type: 'body', metatype: CreateProductDto }))
                .rejects.toBeInstanceOf(BadRequestException);
        }
        await expect(validation.transform({ id }, { type: 'body', metatype: UpdateProductDto }))
            .rejects.toBeInstanceOf(BadRequestException);
        await expect(validation.transform({ price: 0 }, { type: 'body', metatype: PatchProductDto }))
            .resolves.toMatchObject({ price: 0 });
    });

    it('rejects body IDs on both PUT and PATCH', async () => {
        const body = { id, name: 'Book', description: 'NestJS', price: 10 };
        for (const metatype of [UpdateProductDto, PatchProductDto]) {
            await expect(validation.transform(body, { type: 'body', metatype }))
                .rejects.toMatchObject({ response: {
                    message: expect.arrayContaining(['property id should not exist']),
                } });
        }
    });

    it('accepts integer stock and rejects invalid counts on every write DTO', async () => {
        for (const metatype of [CreateProductDto, UpdateProductDto, PatchProductDto]) {
            const body = { name: 'Book', description: 'Stock', price: 1, stock: 0 };
            await expect(validation.transform(body, { type: 'body', metatype })).resolves.toMatchObject({ stock: 0 });
            for (const stock of [-1, 1.5, null, '5', 2147483648]) {
                await expect(validation.transform({ ...body, stock }, { type: 'body', metatype })).rejects.toBeInstanceOf(BadRequestException);
            }
        }
        await expect(validation.transform({ quantity: 5 }, { type: 'body', metatype: RestockProductDto })).resolves.toMatchObject({ quantity: 5 });
        for (const quantity of [0, -1, 0.5, null, '5', 2147483648]) {
            await expect(validation.transform({ quantity }, { type: 'body', metatype: RestockProductDto })).rejects.toBeInstanceOf(BadRequestException);
        }
    });

    it('rejects the removed image URL field on product writes', async () => {
        for (const metatype of [CreateProductDto, UpdateProductDto, PatchProductDto]) {
            await expect(validation.transform({ name: 'Book', description: 'Test', price: 10,
                imageUrl: 'https://example.com/book.jpg' }, { type: 'body', metatype }))
                .rejects.toMatchObject({ response: {
                    message: expect.arrayContaining(['property imageUrl should not exist']),
                } });
        }
    });

    it('passes URL IDs separately from validated update bodies and keeps pagination optional', async () => {
        const service = { updateProduct: vi.fn(), patchProduct: vi.fn(), getProducts: vi.fn() };
        const controller = new ProductsController(service as unknown as ProductsService);
        const update = await validation.transform({ name: 'Book', description: 'NestJS', price: 10 },
            { type: 'body', metatype: UpdateProductDto });
        await controller.updateProduct({ id }, update, { user: { sub: 'seller', roles: [] } } as unknown as AuthRequest);
        await controller.patchProduct({ id }, { price: 0 }, { user: { sub: 'seller', roles: [] } } as unknown as AuthRequest);
        await controller.getProducts();
        expect(service.updateProduct).toHaveBeenCalledWith(id, update, 'seller');
        expect(service.patchProduct).toHaveBeenCalledWith(id, { price: 0 }, 'seller');
        expect(service.getProducts).toHaveBeenCalledWith(undefined, undefined);
    });
});
