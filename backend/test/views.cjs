const { ProductMedia } = require('../dist/products/media/product-media.entity');
const { ProductMediaService } = require('../dist/products/media/product-media.service');
const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { Test } = require('@nestjs/testing');
const { DataSource } = require('typeorm');
const { getDataSourceToken } = require('@nestjs/typeorm');
const { AppModule } = require('../dist/app.module');
const { Products } = require('../dist/products/products.entity');
const { ProductsService } = require('../dist/products/products.service');
const { ProductsPageController } = require('../dist/products/pages/view-products.controller');
const { configureViews } = require('../dist/views.config');

let app;
let page;
let service;
const originalSecret = process.env.JWT_SECRET;

before(async () => {
    process.env.JWT_SECRET = 'test-only-secret-with-at-least-32-characters';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(getDataSourceToken())
        .useFactory({ factory: () => new DataSource({
            type: 'better-sqlite3', database: ':memory:', entities: [Products, ProductMedia], synchronize: true,
        }).initialize() }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await configureViews(app);
    await app.init();
    page = moduleRef.get(ProductsPageController);
    service = moduleRef.get(ProductsService);
});

after(async () => {
    await app?.close();
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

const render = model => new Promise((resolve, reject) => {
    app.getHttpAdapter().getInstance().render('products', model, (error, html) => {
        if (error) reject(error);
        else resolve(html);
    });
});

test('configured Handlebars engine renders the built empty products page', async () => {
    const html = await render(await page.getProductsPage());
    assert.match(html, /<!DOCTYPE html>/);
    assert.match(html, /<title>Products \| Nest Shop<\/title>/);
    assert.match(html, /No products yet/);
    assert.match(html, /href="\/assets\/styles.css"/);
    assert.doesNotMatch(html, /\{\{/);
});

test('products from SQLite render with formatted prices and escaped user text', async () => {
    await service.createProduct({
        name: '<script>alert(1)</script>', description: '<b>Untrusted text</b>', price: 12.5,
    });
    const html = await render(await page.getProductsPage());
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;b&gt;Untrusted text&lt;\/b&gt;/);
    assert.match(html, />12\.50<\/span>/);
    assert.doesNotMatch(html, /No products yet/);
});

test('stylesheet is included in build output and the UI has its own route', async () => {
    const css = await readFile(join(__dirname, '../dist/public/styles.css'), 'utf8');
    assert.match(css, /\.products/);
    assert.equal(Reflect.getMetadata('path', ProductsPageController), 'shop');
    assert.equal(app.getHttpAdapter().getInstance().get('view engine'), 'hbs');
});

test('guest navbar links home and shows Login/Register without an avatar', async () => {
    const html = await render({ title: 'Products', products: [] });
    assert.match(html, /href="\/" aria-label="Nest Shop home"/);
    assert.match(html, /href="\/auth\/login">Login<\/a>/);
    assert.match(html, /href="\/auth\/register">Register<\/a>/);
    assert.doesNotMatch(html, /class="user-avatar"/);
    assert.doesNotMatch(html, /logout-button|logout.js/);
});

test('authenticated navbar shows an avatar and escapes the user name', async () => {
    const html = await render({ title: 'Products', products: [], user: { name: '<script>Eugene</script>' } });
    assert.match(html, /class="user-avatar"/);
    assert.match(html, /id="logout-button">Logout<\/button>/);
    assert.match(html, /src="\/assets\/logout.js" defer/);
    assert.match(html, /&lt;script&gt;Eugene&lt;\/script&gt;/);
    assert.doesNotMatch(html, /href="\/auth\/(login|register)"/);
    assert.doesNotMatch(html, /<script>/);
});

test('authenticated navbar falls back to username when no display name is supplied', async () => {
    const html = await render({ title: 'Products', products: [], user: { username: 'eugene@example.com' } });
    assert.match(html, /eugene@example.com/);
    assert.match(html, /class="user-avatar"/);
});

test('seller catalog renders add/edit/delete controls and safely escaped product labels', async () => {
    const html = await render({ title: 'Products', canEditProducts: true, canDeleteProducts: true,
        products: [{ id: 'product-id', name: '<b>Book</b>', description: 'Test', price: '10.00' }] });
    assert.match(html, /href="\/shop\/new">Add product/);
    assert.match(html, /href="\/shop\/product-id\/edit"/);
    assert.match(html, /data-delete-product="product-id"/);
    assert.match(html, /aria-label="Delete &lt;b&gt;Book&lt;\/b&gt;"/);
    assert.match(html, /id="delete-product-dialog"/);
    assert.doesNotMatch(html, /<b>Book<\/b>/);
});

test('public catalog has no seller controls, and delete-only access does not expose editing', async () => {
    const model = { title: 'Products', products: [{ id: 'p', name: 'Book', price: '10.00' }] };
    const guest = await render(model);
    assert.doesNotMatch(guest, /Add product|data-delete-product|delete-product-dialog|\/shop\/p\/edit/);
    const admin = await render({ ...model, canDeleteProducts: true });
    assert.match(admin, /data-delete-product="p"/);
    assert.doesNotMatch(admin, /Add product|\/shop\/p\/edit/);
});
