const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { Test } = require('@nestjs/testing');
const { JwtService } = require('@nestjs/jwt');
const { AppModule } = require('../dist/app.module');
const { AuthService } = require('../dist/auth/auth.service');
const { AuthGuard } = require('../dist/guard/auth/auth.guard');
const { Roles } = require('../dist/guard/auth/roles.decorator');
const { TokenMiddleware } = require('../dist/middleware/token/token.middleware');

let moduleRef;
let jwt;
let guard;
let auth;
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
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    jwt = moduleRef.get(JwtService);
    guard = moduleRef.get(AuthGuard);
    auth = moduleRef.get(AuthService);
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
    const seller = await jwt.signAsync({ sub: '1', typeOfUser: 'seller' });
    const req = { headers: { authorization: `Bearer ${seller}` } };
    assert.equal(await guard.canActivate(context(req)), true);
    assert.deepEqual(req.user, { sub: '1', typeOfUser: 'seller' });
    const buyer = await jwt.signAsync({ sub: '2', typeOfUser: 'buyer' });
    await assert.rejects(guard.canActivate(context({ headers: {}, accessToken: buyer })), assertStatus(403));
    await assert.rejects(guard.canActivate(context({ headers: {} })), assertStatus(401));
});

test('guard rejects forged, expired, wrongly scoped and incomplete tokens', async () => {
    const claims = { sub: '1', typeOfUser: 'seller' };
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
    ];
    const parts = (await jwt.signAsync({ sub: '2', typeOfUser: 'buyer' })).split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url'));
    parts[1] = Buffer.from(JSON.stringify({ ...payload, typeOfUser: 'seller' })).toString('base64url');
    tokens.push(parts.join('.'));
    for (const accessToken of tokens) {
        await assert.rejects(guard.canActivate(context({ headers: {}, accessToken })), assertStatus(401));
    }
});

test('registration and login issue tokens from the stored role and hide password hashes', async () => {
    const user = {
        username: 'seller@example.com', password: 'Password1!', confirmPassword: 'Password1!',
        firstName: 'Test', lastName: 'User', dob: '2000-01-01', nationality: 'Germany', typeOfUser: 'seller',
    };
    const session = await auth.register(user);
    const claims = await jwt.verifyAsync(session.access_token);
    assert.equal(claims.typeOfUser, 'seller');
    assert.equal(claims.exp - claims.iat, 900);
    assert.equal(session.user.encryptedPassword, undefined);
    const loggedIn = await auth.login({ username: user.username, password: user.password });
    assert.equal((await jwt.verifyAsync(loggedIn.access_token)).typeOfUser, 'seller');
    await assert.rejects(auth.login({ username: user.username, password: 'Wrong1!' }), assertStatus(401));
    await assert.rejects(auth.register(user), assertStatus(409));
    await assert.rejects(auth.register({ ...user, confirmPassword: 'Other1!' }), assertStatus(400));
    await assert.rejects(auth.register({ ...user, typeOfUser: 'admin' }), assertStatus(400));
});

test('every product write is guarded and seller-only, while reads are public', () => {
    const { ProductsController } = require('../dist/products/products.controller');
    for (const method of ['createProduct', 'updateProduct', 'patchProduct', 'deleteProduct']) {
        const route = ProductsController.prototype[method];
        assert.deepEqual(Reflect.getMetadata('roles', route), ['seller']);
        assert.ok(Reflect.getMetadata('__guards__', route).includes(AuthGuard));
    }
    for (const method of ['getProducts', 'getProductById']) {
        assert.equal(Reflect.getMetadata('__guards__', ProductsController.prototype[method]), undefined);
    }
    const decorated = () => {};
    Roles('buyer', 'seller')(decorated);
    assert.deepEqual(Reflect.getMetadata('roles', decorated), ['buyer', 'seller']);
});
