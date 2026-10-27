const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { Test } = require('@nestjs/testing');
const { JwtService } = require('@nestjs/jwt');
const request = require('supertest');
const { AppModule } = require('../dist/app.module');

let app;
let api;
let jwt;
let sellerToken;
let buyerToken;
const originalSecret = process.env.JWT_SECRET;

const registration = (typeOfUser) => ({
    user: {
        username: `${typeOfUser}@example.com`, password: 'Password1!',
        confirmPassword: 'Password1!', firstName: 'Test', lastName: 'User',
        dob: '2000-01-01', nationality: 'Germany', typeOfUser,
    },
});
const product = { name: 'Book', description: 'NestJS', price: 10 };

before(async () => {
    process.env.JWT_SECRET = 'test-only-secret-with-at-least-32-characters';
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    app.useLogger(false);
    await app.init();
    api = request(app.getHttpServer());
    jwt = module.get(JwtService);
    for (const role of ['seller', 'buyer']) {
        const response = await api.post('/auth/register').send(registration(role)).expect(201);
        assert.equal(response.body.user.typeOfUser, role);
        assert.equal(response.body.user.encryptedPassword, undefined);
        const claims = await jwt.verifyAsync(response.body.access_token);
        assert.equal(claims.typeOfUser, role);
        assert.equal(claims.exp - claims.iat, 900);
        if (role === 'seller') sellerToken = response.body.access_token;
        else buyerToken = response.body.access_token;
    }
});

after(async () => {
    await app?.close();
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

test('product reads are public and still validate query parameters', async () => {
    await api.get('/products').expect(200);
    await api.get('/products?limit=qwerty').expect(400);
    await api.get('/products/999').expect(404);
});

test('every product write requires a token and rejects buyers', async () => {
    for (const [method, path] of [
        ['post', '/products'], ['put', '/products/1'],
        ['patch', '/products/1'], ['delete', '/products/1'],
    ]) {
        await api[method](path).send(product).expect(401);
        await api[method](path).set('Authorization', `Bearer ${buyerToken}`).send(product).expect(403);
    }
});

test('sellers can create, read, replace, patch and delete products', async () => {
    const headers = { Authorization: `Bearer ${sellerToken}` };
    const created = await api.post('/products').set(headers).send(product).expect(201);
    const path = `/products/${created.body.id}`;
    await api.get(path).expect(200);
    await api.put(path).set(headers).send({ ...product, price: 20 }).expect(200);
    const updated = await api.patch(path).set(headers).send({ price: 0 }).expect(200);
    assert.equal(updated.body.price, 0);
    await api.delete(path).set(headers).expect(200);
    await api.get(path).expect(404);
});

test('malformed, expired, tampered and incorrectly scoped tokens are rejected', async () => {
    const claims = { sub: '1', typeOfUser: 'seller' };
    const expired = await jwt.signAsync(claims, { expiresIn: -1 });
    const wrongSignature = await jwt.signAsync(claims, { secret: 'a-different-test-secret' });
    const wrongIssuer = await jwt.signAsync(claims, { issuer: 'other-app' });
    const wrongAudience = await jwt.signAsync(claims, { audience: 'other-api' });
    const unknownRole = await jwt.signAsync({ sub: '1', typeOfUser: 'unknown' });
    const missingSubject = await jwt.signAsync({ typeOfUser: 'seller' });
    const missingExpiry = await new JwtService({ secret: process.env.JWT_SECRET }).signAsync(claims, {
        issuer: 'nestjs-advance', audience: 'nestjs-advance-api',
    });
    const parts = buyerToken.split('.');
    const changed = { ...JSON.parse(Buffer.from(parts[1], 'base64url')), typeOfUser: 'seller' };
    parts[1] = Buffer.from(JSON.stringify(changed)).toString('base64url');
    for (const token of [
        'invalid', expired, wrongSignature, wrongIssuer, wrongAudience,
        unknownRole, missingSubject, missingExpiry, parts.join('.'),
    ]) {
        await api.post('/products').set('Authorization', `Bearer ${token}`).send(product).expect(401);
    }
    await api.post('/products').set('Authorization', `Basic ${sellerToken}`).send(product).expect(401);
});

test('login checks credentials and signs the stored role', async () => {
    const response = await api.post('/auth/login').send({
        user: { username: 'seller@example.com', password: 'Password1!' },
    }).expect(201);
    assert.equal((await jwt.verifyAsync(response.body.access_token)).typeOfUser, 'seller');
    await api.post('/auth/login').send({
        user: { username: 'seller@example.com', password: 'Wrong1!' },
    }).expect(401);
    await api.post('/auth/login').send({
        user: { username: 'seller@example.com', password: 'Password1!', typeOfUser: 'seller' },
    }).expect(400);
});

test('registration rejects duplicate accounts, mismatched passwords and admin roles', async () => {
    await api.post('/auth/register').send(registration('seller')).expect(409);
    const mismatch = registration('buyer');
    mismatch.user.confirmPassword = 'Different1!';
    await api.post('/auth/register').send(mismatch).expect(400);
    await api.post('/auth/register').send(registration('admin')).expect(400);
    await api.post('/auth/register').send({ user: {} }).expect(400);
});
