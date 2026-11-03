const { ProductMedia } = require('../dist/products/media/product-media.entity');
const { ProductMediaService } = require('../dist/products/media/product-media.service');
const { after, afterEach, before, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { MongoClient } = require('mongodb');
const { DataSource } = require('typeorm');
const { Test } = require('@nestjs/testing');
const { getDataSourceToken } = require('@nestjs/typeorm');
const { JwtService } = require('@nestjs/jwt');
const request = require('supertest');
const { AppModule } = require('../dist/app.module');
const { Products } = require('../dist/products/products.entity');
const { OtpFactory } = require('../dist/user-interaction/configs/otp.config');
const { UsersRepository } = require('../dist/auth/users.repository');
const { configureViews } = require('../dist/views.config');
const { AuthStateStore, MemoryAuthStateStore } = require('../dist/auth/storage/auth-state.store');

const uri = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017';
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(uri).hostname), 'Tests require a local MongoDB');
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
const previous = { secret: process.env.JWT_SECRET, uri: process.env.MONGODB_URI, database: process.env.MONGODB_DATABASE };
let app;
let moduleRef;
let api;
let database;
let codes;
let jwt;

const buyer = (overrides = {}) => ({
    email: 'buyer@example.com', password: 'Password1!', confirmPassword: 'Password1!',
    firstName: 'Test', lastName: 'Buyer', dob: '2000-01-01', nationality: 'Germany',
    typeOfUser: 'buyer', buyerProfile: { deliveryAddress: 'Test address' }, ...overrides,
});
const start = user => api.post('/auth/register').send({ user }).expect(202);
const verify = (challengeId, channel, code) => api.post('/auth/register/verify').send({ challengeId, channel, code });

before(async () => { await client.connect(); });
beforeEach(async () => {
    process.env.JWT_SECRET = 'test-only-secret-with-at-least-32-characters';
    process.env.MONGODB_URI = uri;
    process.env.MONGODB_DATABASE = `nestjs_test_${randomUUID().replaceAll('-', '')}`;
    database = client.db(process.env.MONGODB_DATABASE);
    codes = new Map();
    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(AuthStateStore).useFactory({ factory: () => new MemoryAuthStateStore() })
        .overrideProvider(getDataSourceToken()).useFactory({ factory: () => new DataSource({
            type: 'better-sqlite3', database: ':memory:', entities: [Products, ProductMedia], synchronize: true,
        }).initialize() })
        .overrideProvider(OtpFactory).useValue({ create: async () => ({ sendOtp: async (recipient, code) => {
            codes.set(recipient, code); return { message: 'Test delivery' };
        } }) }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureViews(app);
    await app.init();
    api = request(app.getHttpServer());
    jwt = moduleRef.get(JwtService);
});
afterEach(async () => {
    await app?.close(); app = undefined;
    if (database && database.databaseName.startsWith('nestjs_test_')) await database.dropDatabase();
    database = undefined;
});
after(async () => {
    await client.close();
    for (const [key, value] of [['JWT_SECRET', previous.secret], ['MONGODB_URI', previous.uri], ['MONGODB_DATABASE', previous.database]]) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
});

test('email-only registration saves nothing until verified, then sets a secure browser session', async () => {
    const pending = await start(buyer());
    assert.equal(await database.collection('users').countDocuments(), 0);
    assert.equal(pending.body.access_token, undefined);
    assert.equal(pending.headers['set-cookie'], undefined);
    assert.equal(JSON.stringify(pending.body).includes(codes.get('buyer@example.com')), false);
    const completed = await verify(pending.body.challengeId, 'email', codes.get('buyer@example.com')).expect(200);
    assert.equal(completed.body.registered, true);
    const cookies = completed.headers['set-cookie'];
    assert.match(cookies[0], /HttpOnly/);
    assert.match(cookies[0], /SameSite=Lax/i);
    const stored = await database.collection('users').findOne({ email: 'buyer@example.com' });
    assert.ok(stored.emailVerifiedAt instanceof Date);
    assert.match(stored.passwordHash, /^\$2/);
    assert.equal(stored.password, undefined);
    assert.equal(stored.confirmPassword, undefined);
    assert.deepEqual(stored.buyerProfile, { deliveryAddress: 'Test address' });
    assert.equal((await jwt.verifyAsync(completed.body.access_token)).sub, stored._id);
    await api.get('/shop').set('Cookie', cookies[0].split(';')[0]).expect(200).expect(/Test Buyer/);
    await verify(pending.body.challengeId, 'email', codes.get('buyer@example.com')).expect(410);
    const browser = request.agent(app.getHttpServer());
    await browser.post('/auth/login').send({ user: { username: 'buyer@example.com', password: 'Password1!' } }).expect(201);
    await browser.get('/shop').expect(200).expect(/id="logout-button"/).expect(/Test Buyer/);
    await browser.post('/auth/logout').set('Origin', 'https://untrusted.example').send({}).expect(403);
    await browser.get('/shop').expect(200).expect(/Test Buyer/);
    const logout = await browser.post('/auth/logout').send({}).expect(204);
    assert.match(logout.headers['set-cookie'][0], /^nest_session=;/);
    assert.match(logout.headers['set-cookie'][0], /Path=\/;.*Expires=Thu, 01 Jan 1970/);
    assert.match(logout.headers['set-cookie'][0], /HttpOnly/);
    assert.match(logout.headers['set-cookie'][0], /SameSite=Lax/i);
    const guest = await browser.get('/shop').expect(200);
    assert.match(guest.text, /href="\/auth\/login"/);
    assert.doesNotMatch(guest.text, /logout-button|Test Buyer/);
    await browser.post('/auth/logout').send({}).expect(204);
    await browser.post('/auth/logout').type('form').send({}).expect(415);
    await browser.get('/assets/logout.js').expect(200).expect(/\/auth\/logout/);
    const reloaded = new UsersRepository();
    try { assert.equal((await reloaded.findByContact('buyer@example.com'))._id, stored._id); }
    finally { await reloaded.onModuleDestroy(); }
});

test('both contacts must be verified independently before MongoDB receives the user', async () => {
    const pending = await start(buyer({ phone: '+4917612345678' }));
    const first = await verify(pending.body.challengeId, 'email', codes.get('buyer@example.com')).expect(200);
    assert.equal(first.body.registered, false);
    assert.equal(first.headers['set-cookie'], undefined);
    assert.equal(await database.collection('users').countDocuments(), 0);
    await verify(pending.body.challengeId, 'phone', codes.get('+4917612345678')).expect(200);
    const user = await database.collection('users').findOne({ email: 'buyer@example.com' });
    assert.ok(user.phoneVerifiedAt instanceof Date);
    assert.ok(user.emailVerifiedAt instanceof Date);
});

test('phone-only sellers save their business profile and can log in by phone', async () => {
    const seller = buyer({ email: undefined, phone: '+4917612345678', typeOfUser: 'seller',
        buyerProfile: undefined, sellerProfile: { companyName: 'Sample shop', businessAddress: 'Test street', vatNumber: 'TEST-1' } });
    const pending = await start(seller);
    assert.deepEqual(pending.body.contacts.map(contact => contact.channel), ['phone']);
    await verify(pending.body.challengeId, 'phone', codes.get(seller.phone)).expect(200);
    const stored = await database.collection('users').findOne({ phone: seller.phone });
    assert.equal(stored.email, undefined);
    assert.deepEqual(stored.sellerProfile, seller.sellerProfile);
    await api.post('/auth/login').send({ user: { username: seller.phone, password: seller.password } }).expect(201);
});

test('invalid registrations and cross-origin submissions cannot create accounts', async () => {
    for (const user of [buyer({ email: undefined }), buyer({ typeOfUser: 'admin' }),
        buyer({ password: 'weak' }), buyer({ sellerProfile: { companyName: 'Wrong role' } }),
        buyer({ emailVerifiedAt: '2000-01-01' }), buyer({ buyerProfile: { permissions: ['admin'] } })]) {
        await api.post('/auth/register').send({ user }).expect(400);
    }
    await api.post('/auth/register').set('Origin', 'https://untrusted.example').send({ user: buyer() }).expect(403);
    await api.post('/auth/register').type('form').send({ user: buyer() }).expect(415);
    await api.post('/auth/register-by-phone').send({ phone: '+4917612345678' }).expect(400);
    assert.equal(await database.collection('users').countDocuments(), 0);
});

test('email and phone OTP login require an existing verified contact and set browser sessions', async () => {
    const registration = await start(buyer({ phone: '+4917612345678' }));
    await verify(registration.body.challengeId, 'email', codes.get('buyer@example.com')).expect(200);
    await verify(registration.body.challengeId, 'phone', codes.get('+4917612345678')).expect(200);
    const count = await database.collection('users').countDocuments();
    for (const [channel, contact] of [['email', 'buyer@example.com'], ['phone', '+4917612345678']]) {
        const browser = request.agent(app.getHttpServer());
        const challenge = await browser.post('/auth/login/otp').send({ channel, contact }).expect(202);
        assert.equal(challenge.headers['set-cookie'], undefined);
        assert.equal(challenge.body.access_token, undefined);
        assert.equal(JSON.stringify(challenge.body).includes(codes.get(contact)), false);
        await browser.post('/auth/login/otp/verify').send({ challengeId: challenge.body.challengeId, code: '000000' }).expect(401);
        const session = await browser.post('/auth/login/otp/verify').send({ challengeId: challenge.body.challengeId, code: codes.get(contact) }).expect(200);
        assert.deepEqual((await jwt.verifyAsync(session.body.access_token)).roles, ['buyer']);
        assert.match(session.headers['set-cookie'][0], /HttpOnly/);
        await browser.get('/shop').expect(200).expect(/Test Buyer/).expect(/logout-button/);
        await browser.post('/auth/login/otp/verify').send({ challengeId: challenge.body.challengeId, code: codes.get(contact) }).expect(410);
    }
    const unknown = await api.post('/auth/login/otp').send({ channel: 'email', contact: 'missing@example.com' }).expect(202);
    assert.equal(codes.has('missing@example.com'), false);
    await api.post('/auth/login/otp/verify').send({ challengeId: unknown.body.challengeId, code: '123456' }).expect(401);
    assert.equal(await database.collection('users').countDocuments(), count);
    await api.post('/auth/login').send({ user: { username: 'buyer@example.com', password: 'wrong' } }).expect(401);
});

test('login page and APIs validate credentials, limit code requests and reject cross-origin posts', async () => {
    const html = await api.get('/auth/login').expect(200).expect('Cache-Control', 'no-store');
    assert.match(html.text, /id="login-form"/);
    assert.match(html.text, /survey-core.js/);
    await api.get('/assets/login.js').expect(200).expect(/\/auth\/login\/otp\/verify/);
    const schema = await api.get('/auth/login/schema').expect(200);
    assert.deepEqual(schema.body.credentials.elements[0].choices.map(choice => choice.value), ['password', 'email', 'phone']);
    for (const dto of [{ channel: 'email', contact: 'bad' }, { channel: 'phone', contact: '012345' },
        { channel: 'LOG', contact: 'buyer@example.com' }, { channel: 'email', contact: 'buyer@example.com', typeOfUser: 'admin' }]) {
        await api.post('/auth/login/otp').send(dto).expect(400);
    }
    await api.post('/auth/login/otp').set('Origin', 'https://untrusted.example').send({ channel: 'email', contact: 'buyer@example.com' }).expect(403);
    await api.post('/auth/login/otp').type('form').send({ channel: 'email', contact: 'buyer@example.com' }).expect(415);
    await api.post('/auth/login/otp/verify').send({ challengeId: 'invalid', code: '123456' }).expect(400);
    const dto = { channel: 'email', contact: 'buyer@example.com' };
    await api.post('/auth/login/otp').send(dto).expect(202);
    await api.post('/auth/login/otp').send(dto).expect(429);
});

test('unique MongoDB indexes resolve a race between two pending registrations', async () => {
    const first = await start(buyer());
    const firstCode = codes.get('buyer@example.com');
    const second = await start(buyer());
    const secondCode = codes.get('buyer@example.com');
    await verify(first.body.challengeId, 'email', firstCode).expect(200);
    await verify(second.body.challengeId, 'email', secondCode).expect(409);
    assert.equal(await database.collection('users').countDocuments(), 1);
    await api.post('/auth/register').send({ user: buyer() }).expect(409);
});

test('bad codes and resend requests are limited without authenticating the user', async () => {
    const pending = await start(buyer());
    await api.post('/auth/register/resend').send({ challengeId: pending.body.challengeId, channel: 'email' }).expect(429);
    for (let i = 0; i < 5; i++) await verify(pending.body.challengeId, 'email', '000000').expect(401);
    await verify(pending.body.challengeId, 'email', codes.get('buyer@example.com')).expect(429);
    assert.equal(await database.collection('users').countDocuments(), 0);
});

test('registration page, SurveyJS bundles, schema and product role guards remain usable', async () => {
    await api.get('/').expect(302).expect('Location', '/shop');
    await api.get('/auth/register').expect(200).expect(/registration-form/).expect(/survey-core.js/);
    await api.get('/assets/vendor/survey-core.js').expect(200);
    await api.get('/assets/vendor/survey-ui.js').expect(200);
    const stylesheet = await api.get('/assets/vendor/survey.css').expect(200).expect('Content-Type', /text\/css/);
    assert.match(stylesheet.text, /\.sd-radio/);
    assert.match(stylesheet.text, /\.sd-root-modern/);
    assert.doesNotMatch(stylesheet.text, /@import/);
    const schema = await api.get('/auth/register/schema').expect(200);
    const { Model } = require('survey-core');
    const model = new Model(schema.body);
    model.data = { typeOfUser: 'buyer' };
    assert.equal(model.getQuestionByName('deliveryAddress').isVisible, true);
    assert.equal(model.getQuestionByName('companyName').isVisible, false);
    model.setValue('contactMethod', 'email');
    assert.equal(model.getQuestionByName('email').isVisible, true);
    assert.equal(model.getQuestionByName('phone').isVisible, false);
    model.setValue('contactMethod', 'phone');
    assert.equal(model.getQuestionByName('email').isVisible, false);
    assert.equal(model.getQuestionByName('phone').isVisible, true);
    model.setValue('contactMethod', 'both');
    assert.equal(model.getQuestionByName('email').isRequired, true);
    assert.equal(model.getQuestionByName('phone').isRequired, true);
    model.setValue('typeOfUser', 'seller');
    assert.equal(model.getQuestionByName('companyName').isVisible, true);
    model.dispose();
    await api.get('/products').expect(200);
    await api.post('/products').send({ name: 'Book', description: 'Test', price: 10 }).expect(401);
    const buyerToken = await jwt.signAsync({ sub: 'test-buyer', roles: ['buyer'] });
    await api.post('/products').set('Authorization', `Bearer ${buyerToken}`).send({ name: 'Book', description: 'Test', price: 10 }).expect(403);
    const sellerToken = await jwt.signAsync({ sub: 'test-seller', roles: ['seller'] });
    await api.post('/products').set('Authorization', `Bearer ${sellerToken}`).send({ name: 'Book', description: 'Test', price: 10 }).expect(201);
});

test('a buyer enables selling on the same account with a refreshed session and separate profiles', async () => {
    const registration = await start(buyer());
    const initial = await verify(registration.body.challengeId, 'email', codes.get('buyer@example.com')).expect(200);
    const initialUser = await database.collection('users').findOne({ email: 'buyer@example.com' });
    assert.deepEqual(initialUser.roles, ['buyer']);
    assert.equal(initialUser.typeOfUser, undefined);
    assert.equal(initialUser.profile, undefined);
    const browser = request.agent(app.getHttpServer());
    const cookie = initial.headers['set-cookie'][0].split(';')[0];
    await browser.get('/account').set('Cookie', cookie).expect(200).expect(/Seller profile/).expect(/My account/);
    const schema = await browser.get('/account/schema').set('Cookie', cookie).expect(200).expect('Cache-Control', 'no-store');
    assert.deepEqual(schema.body.buyer.data, { deliveryAddress: 'Test address' });
    assert.equal(schema.body.seller.form.completeText, 'Enable seller role');
    await api.post('/products').set('Authorization', `Bearer ${initial.body.access_token}`).send({ name: 'Book', description: 'Test', price: 10 }).expect(403);
    const upgraded = await browser.post('/account/seller').set('Cookie', cookie).send({ companyName: 'My shop', businessAddress: 'Business street', vatNumber: 'TEST' }).expect(200);
    assert.deepEqual(upgraded.body.user.roles.sort(), ['buyer', 'seller']);
    const claims = await jwt.verifyAsync(upgraded.body.access_token);
    assert.equal(claims.sub, initialUser._id);
    assert.deepEqual(claims.roles.sort(), ['buyer', 'seller']);
    assert.equal(claims.typeOfUser, undefined);
    assert.match(upgraded.headers['set-cookie'][0], /HttpOnly/);
    const stored = await database.collection('users').findOne({ _id: initialUser._id });
    assert.deepEqual(stored.buyerProfile, initialUser.buyerProfile);
    assert.deepEqual(stored.sellerProfile, { companyName: 'My shop', businessAddress: 'Business street', vatNumber: 'TEST' });
    assert.equal(stored.passwordHash, initialUser.passwordHash);
    assert.equal(stored.emailVerifiedAt.getTime(), initialUser.emailVerifiedAt.getTime());
    assert.equal(await database.collection('users').countDocuments(), 1);
    await browser.get('/account/schema').expect(200).expect(result => assert.equal(result.body.seller.data.companyName, 'My shop'));
    await api.post('/products').set('Authorization', `Bearer ${upgraded.body.access_token}`).send({ name: 'Book', description: 'Test', price: 10 }).expect(201);
    await api.post('/auth/register').send({ user: buyer({ typeOfUser: 'seller', buyerProfile: undefined, sellerProfile: {} }) }).expect(409);
});

test('profile mutations use the authenticated identity, reject privilege fields, and preserve concurrent updates', async () => {
    await api.get('/account').expect(401);
    await api.get('/account/schema').expect(401);
    await api.post('/account/seller').send({}).expect(401);
    const pending = await start(buyer({ typeOfUser: 'seller', buyerProfile: undefined, sellerProfile: { companyName: 'First shop' } }));
    const result = await verify(pending.body.challengeId, 'email', codes.get('buyer@example.com')).expect(200);
    const authorization = `Bearer ${result.body.access_token}`;
    for (const body of [{ roles: ['admin'] }, { userId: 'other-user' }, { email: 'new@example.com' },
        { companyName: 'A', buyerProfile: {} }, { companyName: 123 }]) {
        await api.post('/account/seller').set('Authorization', authorization).send(body).expect(400);
    }
    await api.post('/account/seller').set('Authorization', authorization).set('Origin', 'https://untrusted.example').send({}).expect(403);
    await api.post('/account/seller').set('Authorization', authorization).type('form').send({}).expect(415);
    const updates = await Promise.all([
        api.post('/account/buyer').set('Authorization', authorization).send({ deliveryAddress: 'Home address' }),
        api.post('/account/seller').set('Authorization', authorization).send({ companyName: 'Updated shop' }),
    ]);
    updates.forEach(update => assert.equal(update.status, 200));
    const stored = await database.collection('users').findOne({ email: 'buyer@example.com' });
    assert.deepEqual(stored.roles.sort(), ['buyer', 'seller']);
    assert.deepEqual(stored.buyerProfile, { deliveryAddress: 'Home address' });
    assert.deepEqual(stored.sellerProfile, { companyName: 'Updated shop' });
    await api.post('/account/buyer').set('Authorization', authorization).send({ deliveryAddress: 'Home address' }).expect(200);
    assert.equal((await database.collection('users').findOne({ _id: stored._id })).roles.length, 2);
});

test('existing single-role MongoDB users migrate without losing identity or profile data', async () => {
    const timestamp = new Date('2020-01-01');
    const passwordHash = await require('bcrypt').hash('Password1!', 10);
    for (const role of ['buyer', 'seller']) await database.collection('users').insertOne({
        _id: `legacy-${role}`, email: `${role}@example.com`, passwordHash, firstName: 'Legacy', lastName: role,
        dob: '2000-01-01', nationality: 'Germany', emailVerifiedAt: timestamp, createdAt: timestamp, updatedAt: timestamp,
        typeOfUser: role, profile: role === 'buyer' ? { deliveryAddress: 'Old address' } : { companyName: 'Old shop' },
    });
    const legacyToken = await jwt.signAsync({ sub: 'legacy-buyer', typeOfUser: 'buyer' });
    const account = await api.get('/account/schema').set('Cookie', `nest_session=${legacyToken}`).expect(200);
    assert.equal(account.body.buyer.data.deliveryAddress, 'Old address');
    const buyerUser = await database.collection('users').findOne({ _id: 'legacy-buyer' });
    const sellerUser = await database.collection('users').findOne({ _id: 'legacy-seller' });
    assert.deepEqual(buyerUser.roles, ['buyer']);
    assert.deepEqual(sellerUser.roles, ['seller']);
    assert.deepEqual(buyerUser.buyerProfile, { deliveryAddress: 'Old address' });
    assert.deepEqual(sellerUser.sellerProfile, { companyName: 'Old shop' });
    assert.equal(sellerUser.typeOfUser, undefined);
    assert.equal(sellerUser.profile, undefined);
    assert.equal(buyerUser.passwordHash, passwordHash);
    assert.equal(buyerUser.emailVerifiedAt.getTime(), timestamp.getTime());
    assert.equal(buyerUser.createdAt.getTime(), timestamp.getTime());
    const session = await api.post('/auth/login').send({ user: { username: 'seller@example.com', password: 'Password1!' } }).expect(201);
    assert.deepEqual((await jwt.verifyAsync(session.body.access_token)).roles, ['seller']);
});

test('an email and phone belonging to different accounts never merge those accounts', async () => {
    const first = await start(buyer());
    await verify(first.body.challengeId, 'email', codes.get('buyer@example.com')).expect(200);
    const second = await start(buyer({ email: undefined, phone: '+4917612345678', typeOfUser: 'seller', buyerProfile: undefined }));
    await verify(second.body.challengeId, 'phone', codes.get('+4917612345678')).expect(200);
    await api.post('/auth/register').send({ user: buyer({ phone: '+4917612345678' }) }).expect(409);
    assert.equal(await database.collection('users').countDocuments(), 2);
    const users = await database.collection('users').find().toArray();
    assert.equal(users.filter(user => user.email && user.phone).length, 0);
    assert.equal(users.filter(user => user.roles.length === 2).length, 0);
});

test('seller browser sessions create, edit and delete products through the existing API', async () => {
    const pending = await start(buyer({ typeOfUser: 'seller', buyerProfile: undefined, sellerProfile: {} }));
    const session = await verify(pending.body.challengeId, 'email', codes.get('buyer@example.com')).expect(200);
    const cookie = session.headers['set-cookie'][0].split(';')[0];
    const browser = request.agent(app.getHttpServer());
    await browser.get('/shop').set('Cookie', cookie).expect(200).expect(/href="\/shop\/new"/);
    await browser.get('/shop/new').set('Cookie', cookie).expect(200).expect(/product-editor.js/).expect(/survey-keyboard.js/);
    await browser.get('/shop/product-schema').set('Cookie', cookie).expect(200).expect(result => {
        assert.deepEqual(result.body.elements.map(field => field.name), ['name', 'description', 'price']);
    });
    const body = { name: 'New book', description: 'Description', price: 12.5 };
    const created = await browser.post('/products').set('Cookie', cookie).send(body).expect(201);
    const id = created.body.id;
    await browser.get('/shop').set('Cookie', cookie).expect(200).expect(new RegExp(`/shop/${id}/edit`)).expect(/data-delete-product/);
    await browser.get(`/shop/${id}/edit`).set('Cookie', cookie).expect(200).expect(new RegExp(`data-product-id="${id}"`));
    await browser.get('/shop/not-a-uuid/edit').set('Cookie', cookie).expect(400);
    await browser.post('/products').set('Cookie', cookie).send(body).expect(409);
    await browser.put(`/products/${id}`).set('Cookie', cookie).send({ name: 'Updated book', description: 'Edited', price: 0 }).expect(200).expect(result => {
        assert.equal('imageUrl' in result.body, false);
        assert.equal(result.body.price, 0);
    });
    await browser.put(`/products/${id}`).set('Cookie', cookie).send({ name: 'Bad', description: 'Test', price: -1 }).expect(400);
    await browser.patch(`/products/${id}`).set('Cookie', cookie).send({ price: 15 }).expect(200);
    for (const method of ['post', 'put', 'patch', 'delete']) {
        const path = method === 'post' ? '/products' : `/products/${id}`;
        await browser[method](path).set('Cookie', cookie).set('Origin', 'https://untrusted.example').send(body).expect(403);
    }
    await browser.put(`/products/${id}`).set('Cookie', cookie).type('form').send({ price: 1 }).expect(415);
    await browser.delete(`/products/${id}`).set('Cookie', cookie).expect(200);
    await api.get(`/products/${id}`).expect(404);
    await browser.get(`/shop/${id}/edit`).set('Cookie', cookie).expect(404);
});

test('guests and buyers cannot access product editors or mutate products with browser cookies', async () => {
    await api.get('/shop').expect(200).expect(result => assert.doesNotMatch(result.text, /Add product|data-delete-product/));
    await api.get('/shop/new').expect(401);
    const pending = await start(buyer());
    const session = await verify(pending.body.challengeId, 'email', codes.get('buyer@example.com')).expect(200);
    const cookie = session.headers['set-cookie'][0].split(';')[0];
    await api.get('/shop/new').set('Cookie', cookie).expect(403);
    await api.get('/shop/product-schema').set('Cookie', cookie).expect(403);
    await api.get('/shop').set('Cookie', cookie).expect(200).expect(result => assert.doesNotMatch(result.text, /Add product|data-delete-product/));
    const id = randomUUID();
    await api.get(`/shop/${id}/edit`).set('Cookie', cookie).expect(403);
    await api.post('/products').set('Cookie', cookie).send({ name: 'Book', description: 'Test', price: 10 }).expect(403);
    await api.put(`/products/${id}`).set('Cookie', cookie).send({ name: 'Book', description: 'Test', price: 10 }).expect(403);
    await api.delete(`/products/${id}`).set('Cookie', cookie).expect(403);
});
