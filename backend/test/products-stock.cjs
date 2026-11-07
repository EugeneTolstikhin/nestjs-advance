const { afterEach, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const { DataSource } = require('typeorm');
const build = process.env.TEST_BUILD_DIR || '../dist';
const { Products } = require(`${build}/products/products.entity`);
const { ProductMedia } = require(`${build}/products/media/product-media.entity`);
const { ProductMediaService } = require(`${build}/products/media/product-media.service`);
const { InlineJobQueue } = require(`${build}/jobs/job-queue`);
const { ProductsService } = require(`${build}/products/products.service`);

let db, repository, service;
beforeEach(async () => {
    db = await new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [Products, ProductMedia], synchronize: true }).initialize();
    repository = db.getRepository(Products);
    service = new ProductsService(repository, new ProductMediaService(db, new InlineJobQueue()));
});
afterEach(async () => { if (db?.isInitialized) await db.destroy(); });
const product = (name, stock) => service.createProduct({ name, description: 'Test stock', price: 1, ...(stock === undefined ? {} : { stock }) });
const stock = async id => (await repository.findOneByOrFail({ id })).stock;
const purchase = items => service.withStockTransaction(manager => service.deductStock(items, manager));

test('stock persists; products without an initial count start out of stock', async () => {
    const a = await product('Book', 7), b = await product('Bag');
    assert.equal(await stock(a.id), 7); assert.equal(await stock(b.id), 0);
    assert.equal((await service.getProductById({ id: a.id })).stock, 7);
});
test('database constraints reject negative, fractional, null and overflowing stock', async () => {
    const a = await product('Book', 7);
    for (const value of [-1, 0.5, null, 2147483648]) {
        await assert.rejects(repository.query('UPDATE products SET stock = ? WHERE id = ?', [value, a.id]));
    }
    assert.equal(await stock(a.id), 7);
});
test('edits preserve stock; corrections require the count that the seller saw', async () => {
    const a = await product('Book', 7);
    await service.patchProduct(a.id, { price: 2 });
    assert.equal(await stock(a.id), 7);
    await service.updateProduct(a.id, { name: 'Book', description: 'Edited', price: 3, stock: 4, expectedStock: 7 });
    assert.equal(await stock(a.id), 4);
    await assert.rejects(service.patchProduct(a.id, { stock: 10, expectedStock: 7, name: 'Stale update' }), e => e.getStatus() === 409);
    await assert.rejects(service.patchProduct(a.id, { stock: 10 }), e => e.getStatus() === 400);
    assert.equal(await stock(a.id), 4);
    assert.equal((await repository.findOneByOrFail({ id: a.id })).name, 'Book');
});
test('restocking adds to the latest count without lost increments and enforces the bound', async () => {
    const a = await product('Book', 0);
    await Promise.all(Array.from({ length: 20 }, () => service.restockProduct(a.id, 1)));
    assert.equal(await stock(a.id), 20);
    await service.patchProduct(a.id, { stock: 2147483647, expectedStock: 20 });
    await assert.rejects(service.restockProduct(a.id, 1), e => e.getStatus() === 400);
    await assert.rejects(service.patchProduct(a.id, { stock: 1, expectedStock: 2147483647, restockQuantity: 2 }), e => e.getStatus() === 400);
    assert.equal(await stock(a.id), 2147483647);
});
test('concurrent purchases cannot oversell, and ordinary edits do not restore consumed stock', async () => {
    const a = await product('Book', 3);
    const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => purchase([{ productId: a.id, quantity: 1 }])));
    assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 3);
    assert.equal(await stock(a.id), 0);
    await service.updateProduct(a.id, { name: 'Book', description: 'Edited', price: 2 });
    assert.equal(await stock(a.id), 0);
});
test('an insufficient line or failure to record an order rolls back every decrement', async () => {
    const a = await product('Book', 5), b = await product('Bag', 1);
    await assert.rejects(purchase([{ productId: a.id, quantity: 2 }, { productId: b.id, quantity: 2 }]), e => e.getStatus() === 409);
    assert.equal(await stock(a.id), 5); assert.equal(await stock(b.id), 1);
    await assert.rejects(service.withStockTransaction(async manager => {
        await service.deductStock([{ productId: a.id, quantity: 2 }], manager);
        throw new Error('Order write failed');
    }), /Order write failed/);
    assert.equal(await stock(a.id), 5);
});
test('duplicate order lines are combined and invalid deductions cannot mutate stock', async () => {
    const a = await product('Book', 5);
    await purchase([{ productId: a.id, quantity: 2 }, { productId: a.id, quantity: 3 }]);
    assert.equal(await stock(a.id), 0);
    for (const quantity of [0, -1, 0.5, Infinity, 2147483648]) {
        await assert.rejects(purchase([{ productId: a.id, quantity }]), e => e.getStatus() === 400);
    }
    await assert.rejects(service.deductStock([{ productId: a.id, quantity: 1 }], db.manager), /requires the order transaction/);
});
test('development schema synchronization preserves legacy products and defaults their stock to zero', async () => {
    await db.query('DROP TABLE products');
    await db.query('CREATE TABLE products (id varchar PRIMARY KEY, name varchar(100) NOT NULL UNIQUE, description varchar(255) NOT NULL, price decimal(10,2) NOT NULL, createdAt datetime NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt datetime NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    await db.query("INSERT INTO products (id, name, description, price) VALUES ('legacy', 'Old book', 'Existing data', 12)");
    await db.synchronize();
    const existing = await repository.findOneByOrFail({ id: 'legacy' });
    assert.equal(existing.stock, 0); assert.equal(existing.price, 12); assert.equal(existing.name, 'Old book');
});
