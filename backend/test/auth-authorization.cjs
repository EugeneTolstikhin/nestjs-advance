const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { Test } = require('@nestjs/testing');
const { JwtService } = require('@nestjs/jwt');
const { AuthModule } = require('../dist/auth/auth.module');
const { AuthGuard } = require('../dist/auth/guard/auth.guard');
const { Roles } = require('../dist/auth/guard/roles.decorator');
const { TokenMiddleware } = require('../dist/middleware/token/token.middleware');

let moduleRef;
let jwt;
let guard;
const previousSecret = process.env.JWT_SECRET;
const handler = () => {};
Reflect.defineMetadata('roles', ['seller'], handler);
const context = (request) => ({
    getHandler: () => handler, getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
});
const assertStatus = (status) => (error) => error.getStatus() === status;

before(async () => {
    process.env.JWT_SECRET = 'test-only-secret-with-at-least-32-characters';
    moduleRef = await Test.createTestingModule({ imports: [AuthModule] }).compile();
    jwt = moduleRef.get(JwtService);
    guard = moduleRef.get(AuthGuard);
});
after(async () => {
    await moduleRef?.close();
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
});

test('middleware accepts Bearer only and passes the extracted token', () => {
    const middleware = new TokenMiddleware();
    let called = false;
    const req = { headers: { authorization: 'bearer token-value' } };
    middleware.use(req, {}, () => { called = true; });
    assert.equal(req.accessToken, 'token-value');
    assert.equal(called, true);
    for (const authorization of [undefined, '', 'Basic token', 'Bearer', 'Bearer a b']) {
        assert.throws(() => middleware.use({ headers: { authorization } }, {}, () => {}), assertStatus(401));
    }
});

test('guard verifies seller tokens, attaches claims and denies buyers', async () => {
    const seller = await jwt.signAsync({ sub: '1', roles: ['seller'] });
    const req = { headers: { authorization: `Bearer ${seller}` } };
    assert.equal(await guard.canActivate(context(req)), true);
    assert.deepEqual(req.user, { sub: '1', roles: ['seller'] });
    const buyer = await jwt.signAsync({ sub: '2', roles: ['buyer'] });
    await assert.rejects(guard.canActivate(context({ headers: {}, accessToken: buyer })), assertStatus(403));
    await assert.rejects(guard.canActivate(context({ headers: {} })), assertStatus(401));
});

test('guard rejects forged, expired, wrongly scoped and incomplete tokens', async () => {
    const claims = { sub: '1', roles: ['seller'] };
    const tokens = [
        'invalid',
        await jwt.signAsync(claims, { expiresIn: -1 }),
        await jwt.signAsync(claims, { secret: 'a-different-secret' }),
        await jwt.signAsync(claims, { issuer: 'other-issuer' }),
        await jwt.signAsync(claims, { audience: 'other-api' }),
        await new JwtService({ secret: process.env.JWT_SECRET }).signAsync(claims, {
            issuer: 'nestjs-advance', audience: 'nestjs-advance-api',
        }),
        await jwt.signAsync({ typeOfUser: 'seller' }),
        await jwt.signAsync({ sub: '1', typeOfUser: 'unknown' }),
        await jwt.signAsync({ sub: '1', roles: [] }),
        await jwt.signAsync({ sub: '1', roles: ['seller', 'unknown'] }),
        await jwt.signAsync({ sub: '1', roles: 'seller', typeOfUser: 'seller' }),
    ];
    const parts = (await jwt.signAsync({ sub: '2', roles: ['buyer'] })).split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url'));
    parts[1] = Buffer.from(JSON.stringify({ ...payload, roles: ['seller'] })).toString('base64url');
    tokens.push(parts.join('.'));
    for (const accessToken of tokens) {
        await assert.rejects(guard.canActivate(context({ headers: {}, accessToken })), assertStatus(401));
    }
});

test('guard allows any matching role and accepts unexpired legacy tokens', async () => {
    const accessToken = await jwt.signAsync({ sub: 'both', roles: ['buyer', 'seller'] });
    const req = { headers: {}, accessToken };
    assert.equal(await guard.canActivate(context(req)), true);
    assert.deepEqual(req.user, { sub: 'both', roles: ['buyer', 'seller'] });
    const legacy = { headers: {}, accessToken: await jwt.signAsync({ sub: 'legacy', typeOfUser: 'seller' }) };
    assert.equal(await guard.canActivate(context(legacy)), true);
    assert.deepEqual(legacy.user.roles, ['seller']);
});

test('every product write is guarded and seller-only, while reads are public', () => {
    const { ProductsController } = require('../dist/products/products.controller');
    for (const method of ['createProduct', 'updateProduct', 'patchProduct', 'deleteProduct']) {
        const route = ProductsController.prototype[method];
        assert.deepEqual(Reflect.getMetadata('roles', route), method === 'deleteProduct' ? ['seller', 'admin'] : ['seller']);
        assert.ok(Reflect.getMetadata('__guards__', route).includes(AuthGuard));
    }
    for (const method of ['getProducts', 'getProductById']) {
        assert.equal(Reflect.getMetadata('__guards__', ProductsController.prototype[method]), undefined);
    }
    const decorated = () => {};
    Roles('buyer', 'seller')(decorated);
    assert.deepEqual(Reflect.getMetadata('roles', decorated), ['buyer', 'seller']);
});
