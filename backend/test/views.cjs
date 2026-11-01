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
const { ProductsPageController } = require('../dist/products/products-page.controller');
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
            type: 'better-sqlite3', database: ':memory:', entities: [Products], synchronize: true,
        }).initialize() }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureViews(app);
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
