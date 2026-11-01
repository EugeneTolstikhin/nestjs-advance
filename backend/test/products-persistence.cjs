const { afterEach, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const { DataSource, QueryFailedError } = require('typeorm');
const { Products } = require('../dist/products/products.entity');
const { ProductsService } = require('../dist/products/products.service');

let db;
let repository;
let service;

beforeEach(async () => {
    db = await new DataSource({
        type: 'better-sqlite3', database: ':memory:', entities: [Products], synchronize: true,
    }).initialize();
    repository = db.getRepository(Products);
    service = new ProductsService(repository);
});

afterEach(async () => {
    if (db?.isInitialized) await db.destroy();
});

test('duplicate names return 409 and leave the original product unchanged', async () => {
    const first = await service.createProduct({ name: 'Book', description: 'Original', price: 10 });
    assert.ok(first.id);
    assert.ok(first.createdAt instanceof Date);
    await assert.rejects(
        service.createProduct({ name: 'Book', description: 'Duplicate', price: 20 }),
        error => error.getStatus() === 409 && error.message === 'A product with this name already exists',
    );
    assert.equal(await repository.count(), 1);
    const stored = await repository.findOneByOrFail({ id: first.id });
    assert.equal(stored.description, 'Original');
    assert.equal(stored.price, 10);
});

test('different product names can both be saved', async () => {
    await service.createProduct({ name: 'Book', description: 'First', price: 10 });
    await service.createProduct({ name: 'Notebook', description: 'Second', price: 20 });
    assert.equal(await repository.count(), 2);
});

test('other database failures are not reported as duplicate names', async () => {
    await assert.rejects(
        service.createProduct({ name: 'Book', price: 10 }),
        error => error instanceof QueryFailedError && error.driverError.code === 'SQLITE_CONSTRAINT_NOTNULL',
    );
    assert.equal(await repository.count(), 0);
});

test('reads and deletes use database rows across service instances', async () => {
    const first = await service.createProduct({ name: 'Book', description: 'First', price: 10 });
    const second = await service.createProduct({ name: 'Notebook', description: 'Second', price: 20 });
    const anotherService = new ProductsService(repository);
    assert.equal((await anotherService.getProducts()).length, 2);
    assert.equal((await anotherService.getProductById({ id: first.id })).name, 'Book');
    const remaining = await anotherService.deleteProduct({ id: first.id });
    assert.deepEqual(remaining.map(product => product.id), [second.id]);
    assert.equal(await repository.findOneBy({ id: first.id }), null);
    assert.equal((await service.getProducts()).length, 1);
});

test('PUT replaces editable fields and PATCH preserves omitted fields and accepts zero', async () => {
    const first = await service.createProduct({
        name: 'Book', description: 'Original', price: 10, imageUrl: 'https://example.com/book.png',
    });
    const patched = await service.patchProduct(first.id, { price: 0 });
    assert.equal(patched.id, first.id);
    assert.equal(patched.name, 'Book');
    assert.equal(patched.imageUrl, first.imageUrl);
    assert.equal((await repository.findOneByOrFail({ id: first.id })).price, 0);
    const replaced = await service.updateProduct(first.id, {
        name: 'Updated book', description: 'Replacement', price: 15,
    });
    const stored = await repository.findOneByOrFail({ id: first.id });
    assert.equal(stored.name, replaced.name);
    assert.equal(stored.description, 'Replacement');
    assert.equal(stored.imageUrl, null);
    assert.equal(stored.createdAt.getTime(), first.createdAt.getTime());
    assert.ok(stored.updatedAt instanceof Date);
});

test('duplicate names on PUT and PATCH return 409 without changing stored data', async () => {
    await service.createProduct({ name: 'Book', description: 'First', price: 10 });
    const second = await service.createProduct({ name: 'Notebook', description: 'Second', price: 20 });
    await assert.rejects(service.updateProduct(second.id, {
        name: 'Book', description: 'Should not be saved', price: 99,
    }), error => error.getStatus() === 409);
    await assert.rejects(service.patchProduct(second.id, { name: 'Book', price: 99 }),
        error => error.getStatus() === 409);
    const stored = await repository.findOneByOrFail({ id: second.id });
    assert.equal(stored.name, 'Notebook');
    assert.equal(stored.price, 20);
    assert.equal(stored.description, 'Second');
    assert.equal(await repository.count(), 2);
});

test('missing rows return 404 and updates do not insert new rows', async () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    for (const action of [
        () => service.getProductById({ id }),
        () => service.updateProduct(id, { name: 'Book', description: 'Missing', price: 10 }),
        () => service.patchProduct(id, { price: 10 }),
        () => service.deleteProduct({ id }),
    ]) {
        await assert.rejects(action, error => error.getStatus() === 404);
    }
    assert.equal(await repository.count(), 0);
});

test('pagination has stable ordering, supports limit alone, and rejects invalid values', async () => {
    for (let i = 0; i < 5; i++) {
        await service.createProduct({ name: `Product ${i}`, description: 'Paging', price: i });
    }
    const all = await service.getProducts();
    const ids = products => products.map(product => product.id);
    assert.deepEqual(ids(await service.getProducts(2)), ids(all.slice(0, 2)));
    assert.deepEqual(ids(await service.getProducts(2, 2)), ids(all.slice(2, 4)));
    assert.deepEqual(await service.getProducts(2, 4), []);
    for (const [limit, page] of [[0, 1], [-1, 1], [1.5, 1], [2, 0], [2, -1], [undefined, 2]]) {
        await assert.rejects(service.getProducts(limit, page), error => error.getStatus() === 400);
    }
});
