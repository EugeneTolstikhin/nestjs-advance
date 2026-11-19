process.env.NODE_ENV = 'test';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { mkdtemp, rm } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { DataSource } = require('typeorm');
const { Test } = require('@nestjs/testing');
const { getDataSourceToken } = require('@nestjs/typeorm');
const { JwtService } = require('@nestjs/jwt');
const { createClient } = require('redis');
const request = require('supertest');
const build = process.env.TEST_BUILD_DIR || '../dist';
let directory,
  processes = [],
  app,
  api,
  db,
  jwt,
  mailOrigin,
  carrierOrigin,
  secret,
  users,
  service,
  emailAdapter,
  modules;
let confirmed, buyer, other, sellerOrders, cookie;
const accounts = new Map();
const freePort = async () => {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
};
async function until(read, label = 'background work') {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
function child(command, args, env = {}) {
  const process = spawn(command, args, {
    env: { ...global.process.env, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  process.stderr.on('data', () => {});
  processes.push(process);
  return process;
}
async function mail(path) {
  const response = await fetch(mailOrigin + path);
  assert.equal(response.status, 200);
  return response.json();
}
const inbox = () => mail('/api/v1/messages');
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'order-confirmation-'));
  buyer = randomUUID();
  other = randomUUID();
  secret = randomBytes(32).toString('hex');
  const redisPort = await freePort(),
    smtpPort = await freePort(),
    webPort = await freePort(),
    popPort = await freePort(),
    carrierPort = await freePort();
  mailOrigin = `http://127.0.0.1:${webPort}`;
  carrierOrigin = `http://127.0.0.1:${carrierPort}`;
  Object.assign(process.env, {
    JWT_SECRET: randomBytes(32).toString('hex'),
    PAYMENT_PROVIDERS: 'simulated',
    RETURNS_ENABLED: 'true',
    RETURN_EVIDENCE_DIR: join(directory, 'evidence'),
    PAYMENT_SIMULATOR_SECRET: secret,
    DELIVERY_PROVIDER: 'simulated',
    DELIVERY_SIMULATOR_URL: carrierOrigin,
    DELIVERY_SIMULATOR_SECRET: secret,
    ORDER_CONFIRMATION_ENABLED: 'true',
    JOBS_DRIVER: 'bullmq',
    JOBS_REDIS_URL: `redis://127.0.0.1:${redisPort}`,
    JOBS_REDIS_PREFIX: `test-order-${randomUUID()}`,
    EMAIL_PROVIDER: 'mailpit',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtpPort),
    SMTP_USER: '',
    SMTP_PASS: '',
    SMTP_SECURE: 'false',
    SMTP_REQUIRE_TLS: 'false',
    SMTP_FROM: 'Nest Shop <no-reply@nest-shop.test>',
    INVOICE_STORAGE_DIR: join(directory, 'invoices'),
    MEDIA_STORAGE_DIR: join(directory, 'media'),
    SHOP_ORIGIN: 'http://localhost:3000',
  });
  child(process.env.TEST_REDIS_BINARY || 'redis-server', [
    '--port',
    String(redisPort),
    '--bind',
    '127.0.0.1',
    '--save',
    '',
    '--appendonly',
    'no',
    '--dir',
    directory,
  ]);
  const redis = createClient({
    url: process.env.JOBS_REDIS_URL,
    socket: { reconnectStrategy: false },
  });
  redis.on('error', () => {});
  await until(async () => {
    try {
      if (!redis.isOpen) await redis.connect();
      return (await redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }, 'isolated Redis');
  await redis.close();
  child(process.env.TEST_MAILPIT_BINARY || 'mailpit', [
    '--listen',
    `127.0.0.1:${webPort}`,
    '--smtp',
    `127.0.0.1:${smtpPort}`,
    '--pop3',
    `127.0.0.1:${popPort}`,
    '--database',
    join(directory, 'mailpit.sqlite'),
    '--disable-version-check',
    '--quiet',
  ]);
  await until(async () => {
    try {
      return await inbox();
    } catch {
      return false;
    }
  }, 'isolated Mailpit');
  child(
    process.execPath,
    [resolve(__dirname, '../../delivery-simulator/dist/main.js')],
    { DELIVERY_SIMULATOR_DATABASE: join(directory, 'carrier.sqlite') },
  );
  await until(async () => {
    try {
      return (await fetch(carrierOrigin)).status === 200;
    } catch {
      return false;
    }
  }, 'independent delivery provider');
  const paymentPort = await freePort();
  process.env.PAYMENT_SIMULATOR_URL = `http://127.0.0.1:${paymentPort}`;
  child(
    process.execPath,
    [resolve(__dirname, '../../payment-simulator/dist/main.js')],
    { PAYMENT_SIMULATOR_DATABASE: join(directory, 'payments.sqlite') },
  );
  const { AppModule } = require(`${build}/app.module`);
  const { Products } = require(`${build}/products/products.entity`);
  const { ProductMedia } = require(
    `${build}/products/media/product-media.entity`,
  );
  const { CheckoutSession, StockReservation } = require(
    `${build}/checkout/checkout-session.entity`,
  );
  const { UsersRepository } = require(`${build}/auth/users.repository`);
  const { CartRepository } = require(`${build}/cart/cart.repository`);
  const { AuthStateStore, MemoryAuthStateStore } = require(
    `${build}/auth/storage/auth-state.store`,
  );
  const { OrderConfirmationService } = require(
    `${build}/orders/order-confirmation.service`,
  );
  const { EmailProviderFactory } = require(
    `${build}/user-interaction/email/email-provider`,
  );
  const { configureViews } = require(`${build}/views.config`);
  accounts.set(buyer, {
    _id: buyer,
    firstName: 'Buyer',
    lastName: 'Test',
    email: 'buyer@example.test',
    emailVerifiedAt: new Date(),
    roles: ['buyer'],
  });
  accounts.set(other, {
    _id: other,
    firstName: 'Other',
    lastName: 'Buyer',
    email: 'unverified@example.test',
    roles: ['buyer'],
  });
  modules = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(UsersRepository)
    .useValue({ findById: async (id) => accounts.get(id) ?? null })
    .overrideProvider(CartRepository)
    .useValue({ get: async () => null })
    .overrideProvider(AuthStateStore)
    .useValue(new MemoryAuthStateStore())
    .overrideProvider(getDataSourceToken())
    .useFactory({
      factory: () =>
        new DataSource({
          type: 'better-sqlite3',
          database: join(directory, 'shop.sqlite'),
          entities: [
            Products,
            ProductMedia,
            CheckoutSession,
            StockReservation,
            require(`${build}/returns/return.entity`).OrderReturn,
          ],
          synchronize: true,
        }).initialize(),
    })
    .compile();
  app = modules.createNestApplication({ logger: false });
  await configureViews(app);
  await app.init();
  await app.listen(0, '127.0.0.1');
  api = request(app.getHttpServer());
  db = modules.get(DataSource);
  jwt = modules.get(JwtService);
  service = modules.get(
    require(`${build}/returns/returns.service`).ReturnsService,
  );
  emailAdapter = modules.get(EmailProviderFactory).create();
  cookie = `nest_session=${await jwt.signAsync({ sub: buyer, roles: ['buyer'] })}`;
});
after(async () => {
  await app?.close();
  for (const process of processes.reverse())
    if (process.exitCode === null) {
      const exit = new Promise((resolve) => process.once('exit', resolve));
      process.kill();
      await exit;
    }
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function paid(id) {
  const { CheckoutSession } = require(
    `${build}/checkout/checkout-session.entity`,
  );
  const now = Date.now();
  const checkoutId = randomUUID();
  const items = [
    {
      productId: randomUUID(),
      sellerId: randomUUID(),
      name: 'Äpfel <script>unsafe</script>',
      quantity: 2,
      unitPriceCents: 125,
      lineTotalCents: 250,
    },
    {
      productId: randomUUID(),
      sellerId: randomUUID(),
      name: 'Notebook',
      quantity: 1,
      unitPriceCents: 300,
      lineTotalCents: 300,
    },
  ];
  const sellerOrders = items.map((item) => ({
    id: randomUUID(),
    sellerId: item.sellerId,
    items: [item],
    shippingCents: 499,
    totalCents: item.lineTotalCents + 499,
    fulfillment: 'unfulfilled',
  }));
  const order = {
    id: randomUUID(),
    status: 'paid',
    createdAt: now,
    paidAt: now,
    currency: 'EUR',
    totalCents: 1548,
    items,
    delivery: {
      fullName: 'Invoice Buyer',
      addressLine1: 'Teststrasse 1',
      postalCode: '10115',
      city: 'Berlin',
      country: 'DE',
      email: 'different-unverified@example.test',
    },
    shipping: {
      method: 'standard',
      label: 'Standard',
      estimatedDelivery: 'Demo',
      shippingCents: 998,
      shipments: sellerOrders.map((seller) => ({
        sellerId: seller.sellerId,
        feeCents: 499,
      })),
    },
    sellerOrders,
    cleanup: 'cleared_or_preserved',
  };
  await db.getRepository(CheckoutSession).save({
    id: checkoutId,
    buyerId: id,
    activeBuyerId: null,
    status: 'completed',
    expiresAt: now,
    createdAt: now,
    machineSnapshot: { value: 'completed' },
    quoteHash: 'test',
    cartHash: 'test',
    items,
    subtotalCents: 550,
    currency: 'EUR',
    order,
    payment: { id: randomUUID(), status: 'succeeded' },
  });
  return { checkoutId, sellerOrders };
}
async function data(id, token = cookie) {
  return (await api.get(`/orders/${id}/data`).set('Cookie', token).expect(200))
    .body;
}
async function changeStatus(number, status) {
  const html = await (await fetch(carrierOrigin)).text();
  const { Window } = require('happy-dom');
  const browser = new Window();
  browser.document.body.innerHTML = html;
  const article = [...browser.document.querySelectorAll('article')].find(
    (value) => value.textContent.includes(number),
  );
  assert.ok(article);
  const csrf = article.querySelector('[name="csrf"]').value;
  const version = article.querySelector('[name="version"]').value;
  browser.close();
  const response = await fetch(`${carrierOrigin}/shipments/${number}/status`, {
    method: 'POST',
    headers: {
      Origin: carrierOrigin,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ csrf, version, status }),
    redirect: 'manual',
  });
  assert.equal(response.status, 303);
}
const sellerToken = async (id) =>
  `nest_session=${await jwt.signAsync({ sub: id, roles: ['seller'] })}`;
async function carrier(path, body) {
  const response = await fetch(carrierOrigin + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
async function fixture(returned = false) {
  const value = await paid(buyer);
  const { CheckoutSession } = require(
    `${build}/checkout/checkout-session.entity`,
  );
  const { Products } = require(`${build}/products/products.entity`);
  const session = await db
    .getRepository(CheckoutSession)
    .findOneByOrFail({ id: value.checkoutId });
  for (const seller of session.order.sellerOrders) {
    accounts.set(seller.sellerId, {
      _id: seller.sellerId,
      email: `${seller.sellerId}@example.test`,
      emailVerifiedAt: new Date(),
      roles: ['seller'],
    });
    for (const item of seller.items)
      await db.getRepository(Products).save({
        id: item.productId,
        sellerId: seller.sellerId,
        name: `${item.name}-${randomUUID()}`,
        description: 'Test',
        price: item.unitPriceCents / 100,
        stock: 10,
      });
    const shipment = await carrier('/api/shipments', {
      reference: seller.id,
      method: 'standard',
      country: 'DE',
    });
    for (const status of returned && seller === session.order.sellerOrders[0]
      ? [
          'picked_up',
          'in_transit',
          'delivery_failed',
          'returning_to_sender',
          'returned_to_sender',
        ]
      : ['picked_up', 'in_transit', 'out_for_delivery', 'delivered'])
      await changeStatus(shipment.trackingNumber, status);
    seller.fulfillment =
      returned && seller === session.order.sellerOrders[0]
        ? 'returned_to_sender'
        : 'delivered';
  }
  const paymentId = randomUUID();
  const origin = process.env.PAYMENT_SIMULATOR_URL;
  const response = await until(async () => {
    try {
      const result = await fetch(`${origin}/api/payments`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          reference: paymentId,
          amountCents: session.order.totalCents,
          currency: 'EUR',
          expiresAt: Date.now() + 600000,
          returnUrl: 'http://localhost:3000/checkout',
        }),
      });
      return result.ok ? result.json() : false;
    } catch {
      return false;
    }
  });
  await fetch(response.paymentUrl, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'approve' }),
    redirect: 'manual',
  });
  session.payment = {
    ...session.payment,
    id: paymentId,
    provider: 'simulated',
    status: 'succeeded',
  };
  await db.getRepository(CheckoutSession).save(session);
  return {
    session,
    seller: session.order.sellerOrders[0],
    otherSeller: session.order.sellerOrders[1],
  };
}
async function view(id, token = cookie) {
  return (await api.get(`/returns/${id}/data`).set('Cookie', token).expect(200))
    .body;
}
async function action(id, token, command, extra = {}, expected = 201) {
  const record = await view(id, token);
  return api
    .post(`/returns/${id}/actions`)
    .set('Cookie', token)
    .send({
      action: command,
      revision: record.revision,
      notes: 'Test explanation',
      ...extra,
    })
    .expect(expected);
}
let firstReturn, firstFixture, sellerCookie;
test('buyer partial return requires the owning seller approval and creates exactly one separate return shipment', async () => {
  firstFixture = await fixture();
  const { session, seller } = firstFixture;
  sellerCookie = await sellerToken(seller.sellerId);
  const input = {
    id: randomUUID(),
    checkoutId: session.id,
    sellerOrderId: seller.id,
    items: [
      {
        productId: seller.items[0].productId,
        quantity: 1,
        reason: 'Wrong size',
      },
    ],
  };
  firstReturn = input.id;
  await api.get('/returns').set('Cookie', cookie).expect(200);
  await api.get('/assets/returns.js').expect(200);
  await api.get('/assets/returns.css').expect(200);
  await api
    .post('/returns/requests')
    .set('Cookie', cookie)
    .send(input)
    .expect(201);
  await api
    .post('/returns/requests')
    .set('Cookie', cookie)
    .send(input)
    .expect(201);
  assert.equal((await view(firstReturn)).status, 'requested');
  const before = await fetch(carrierOrigin).then((response) => response.text());
  assert.ok(!before.includes(firstReturn));
  await action(firstReturn, cookie, 'approve', {}, 404);
  await api
    .post(`/returns/${firstReturn}/actions`)
    .set('Cookie', await sellerToken(firstFixture.otherSeller.sellerId))
    .send({ action: 'approve', revision: (await view(firstReturn)).revision })
    .expect(404);
  await action(firstReturn, sellerCookie, 'approve');
  const ready = await until(async () => {
    const value = await view(firstReturn);
    return value.shipment ? value : false;
  }, 'return shipment job');
  assert.equal(ready.shipment.reference, firstReturn);
  assert.equal(ready.shipment.direction, 'return');
  assert.equal(ready.shipment.relatedReference, seller.id);
  const number = ready.shipment.trackingNumber;
  await service.process(firstReturn);
  assert.equal((await view(firstReturn)).shipment.trackingNumber, number);
  await api
    .post('/returns/requests')
    .set('Cookie', cookie)
    .send({
      ...input,
      id: randomUUID(),
      items: [{ ...input.items[0], quantity: 2 }],
    })
    .expect(400);
  for (const status of [
    'picked_up',
    'in_transit',
    'out_for_delivery',
    'delivered',
  ])
    await changeStatus(number, status);
  await until(
    async () => (await view(firstReturn)).status === 'received',
    'return arrival',
  );
});
test('inspection, buyer clarification and evidence are private, and stock/refund effects survive retries', async () => {
  const line = firstFixture.seller.items[0];
  await action(firstReturn, sellerCookie, 'inspect', {
    items: [
      {
        productId: line.productId,
        received: 1,
        sellable: 0,
        restock: 0,
        refund: 1,
      },
    ],
  });
  await action(firstReturn, sellerCookie, 'ask_buyer');
  await action(firstReturn, sellerCookie, 'resolve', {}, 409);
  await action(firstReturn, cookie, 'message', {
    notes: 'The item was already damaged when received.',
  });
  const sharp = require('sharp');
  const image = await sharp({
    create: { width: 8, height: 8, channels: 3, background: 'red' },
  })
    .png()
    .toBuffer();
  const upload = await api
    .post(`/returns/${firstReturn}/evidence`)
    .set('Cookie', cookie)
    .attach('files', image, 'evidence.png')
    .expect(201);
  const photo = upload.body.evidence[0].id;
  await api
    .get(`/returns/${firstReturn}/evidence/${photo}`)
    .set('Cookie', cookie)
    .expect(200)
    .expect('Content-Type', /image\/jpeg/);
  await api.get(`/returns/${firstReturn}/evidence/${photo}`).expect(401);
  const foreign = `nest_session=${await jwt.signAsync({ sub: other, roles: ['buyer'] })}`;
  await api
    .get(`/returns/${firstReturn}/data`)
    .set('Cookie', foreign)
    .expect(404);
  await api
    .get(`/returns/${firstReturn}/evidence/${photo}`)
    .set('Cookie', foreign)
    .expect(404);
  await action(firstReturn, sellerCookie, 'close_issue');
  // Seller decides one item is sellable after clarification.
  await action(firstReturn, sellerCookie, 'inspect', {
    items: [
      {
        productId: line.productId,
        received: 1,
        sellable: 1,
        restock: 1,
        refund: 1,
      },
    ],
  });
  const original = await view(firstReturn, sellerCookie);
  await action(firstReturn, sellerCookie, 'resolve');
  await api
    .post(`/returns/${firstReturn}/actions`)
    .set('Cookie', sellerCookie)
    .send({ action: 'resolve', revision: original.revision, notes: 'Repeat' })
    .expect(409);
  await until(
    async () => (await view(firstReturn)).refund?.status === 'succeeded',
    'simulated refund',
  );
  await service.process(firstReturn);
  await service.process(firstReturn);
  const { Products } = require(`${build}/products/products.entity`);
  assert.equal(
    (await db.getRepository(Products).findOneByOrFail({ id: line.productId }))
      .stock,
    11,
  );
  assert.equal(
    (await view(firstReturn)).refund.amountCents,
    line.unitPriceCents,
  );
  assert.equal(
    (
      await db
        .getRepository(Products)
        .findOneByOrFail({ id: firstFixture.otherSeller.items[0].productId })
    ).stock,
    10,
  );
});
test('failed delivery automatically expects all shipment items and supports a carrier investigation', async () => {
  const { session, seller } = await fixture(true);
  await service.discover();
  await service.discover();
  const { OrderReturn } = require(`${build}/returns/return.entity`);
  const records = await db
    .getRepository(OrderReturn)
    .findBy({ automaticReference: seller.id });
  assert.equal(records.length, 1);
  const record = records[0];
  const sellerAuth = await sellerToken(seller.sellerId);
  assert.equal(record.status, 'received');
  assert.equal(record.data.items[0].quantity, 2);
  const line = seller.items[0];
  await action(record.id, sellerAuth, 'inspect', {
    items: [
      {
        productId: line.productId,
        received: 1,
        sellable: 1,
        restock: 1,
        refund: 2,
      },
    ],
  });
  await action(record.id, sellerAuth, 'carrier_claim');
  await until(
    async () => (await view(record.id)).claim?.result?.status === 'open',
    'carrier claim job',
  );
  const { Window } = require('happy-dom');
  const browser = new Window();
  browser.document.body.innerHTML = await fetch(carrierOrigin).then((r) =>
    r.text(),
  );
  const form = browser.document.querySelector(
    `form[action="/claims/${record.id}"]`,
  );
  assert.ok(form);
  const csrf = form.querySelector('[name=csrf]').value;
  const version = form.querySelector('[name=version]').value;
  browser.close();
  const decision = await fetch(`${carrierOrigin}/claims/${record.id}`, {
    method: 'POST',
    headers: {
      Origin: carrierOrigin,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      csrf,
      version,
      status: 'approved',
      resolution: 'Parcel damage confirmed by simulator',
    }),
    redirect: 'manual',
  });
  assert.equal(decision.status, 303);
  await until(
    async () => (await view(record.id)).claim.result.status === 'approved',
    'carrier claim outcome',
  );
  await action(record.id, sellerAuth, 'resolve', {}, 409);
  await action(record.id, sellerAuth, 'close_issue');
  await action(record.id, sellerAuth, 'resolve', { shippingRefundCents: 499 });
  await until(
    async () => (await view(record.id)).refund?.status === 'succeeded',
    'automatic return refund',
  );
  assert.equal(
    (await view(record.id)).refund.amountCents,
    2 * line.unitPriceCents + 499,
  );
  await until(async () => {
    const messages = (await inbox()).messages;
    return messages.some(
      (value) => value.Subject === 'Nest Shop return update',
    );
  }, 'async return email');
});

test('seller rejection requires a reason and releases the declared quantities for a complete request', async () => {
  const { session, seller } = await fixture();
  const input = {
    id: randomUUID(),
    checkoutId: session.id,
    sellerOrderId: seller.id,
    items: seller.items.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
      reason: 'Return all items',
    })),
  };
  await api
    .post('/returns/requests')
    .set('Cookie', cookie)
    .send(input)
    .expect(201);
  const sellerAuth = await sellerToken(seller.sellerId);
  await action(input.id, sellerAuth, 'reject', { notes: '' }, 400);
  await action(input.id, sellerAuth, 'reject', {
    notes: 'Please clarify your reason before resubmitting',
  });
  assert.equal((await view(input.id)).status, 'rejected');
  const replacement = { ...input, id: randomUUID() };
  await api
    .post('/returns/requests')
    .set('Cookie', cookie)
    .send(replacement)
    .expect(201);
  assert.deepEqual(
    (await view(replacement.id)).items.map((item) => item.quantity),
    seller.items.map((item) => item.quantity),
  );
  const { OrderReturn } = require(`${build}/returns/return.entity`);
  const stored = await db
    .getRepository(OrderReturn)
    .findOneByOrFail({ id: replacement.id });
  assert.equal(stored.data.shipment, null);
});

test('my orders and return selection use readable references, seller names and product thumbnails', async () => {
  const { session, seller } = await fixture();
  accounts.get(seller.sellerId).sellerProfile = { companyName: 'Green Farm' };
  const { ProductMedia } = require(
    `${build}/products/media/product-media.entity`,
  );
  const photoId = randomUUID();
  await db
    .getRepository(ProductMedia)
    .save({
      id: photoId,
      ownerId: seller.sellerId,
      productId: seller.items[0].productId,
      position: 0,
      originalName: 'apple.webp',
      kind: 'image',
      mimeType: 'image/webp',
      size: 20,
      reservedBytes: 20,
      status: 'ready',
      expiresAt: Date.now() + 600000,
    });
  const sharp = require('sharp');
  const { mkdir, writeFile } = require('node:fs/promises');
  await mkdir(join(directory, 'media', 'ready'), { recursive: true });
  await writeFile(
    join(directory, 'media', 'ready', `${photoId}.webp`),
    await sharp({
      create: { width: 16, height: 16, channels: 3, background: 'green' },
    })
      .webp()
      .toBuffer(),
  );
  const history = await api
    .get('/orders')
    .set('Cookie', cookie)
    .expect(200)
    .expect('Cache-Control', 'no-store');
  assert.match(history.text, /My orders/);
  assert.match(history.text, /Order #NS-\d{6}-[A-F0-9]{8}/);
  assert.match(history.text, /Green Farm/);
  assert.ok(history.text.includes(`/media/files/${photoId}`));
  assert.ok(
    history.text.includes(
      `/returns?checkout=${session.id}&amp;seller=${seller.id}`,
    ),
  );
  await api
    .get(`/media/files/${photoId}`)
    .expect(200)
    .expect('Content-Type', /image\/webp/);
  const details = (
    await api
      .get(`/orders/${session.id}/data`)
      .set('Cookie', cookie)
      .expect(200)
  ).body;
  assert.match(details.orderNumber, /^NS-\d{6}-[A-F0-9]{8}$/);
  assert.equal(details.sellers[0].sellerName, 'Green Farm');
  assert.equal(
    details.sellers[0].items[0].thumbnail,
    `/media/files/${photoId}`,
  );
  const options = (
    await api.get('/returns/data').set('Cookie', cookie).expect(200)
  ).body;
  const option = options.orders.find(
    (value) =>
      value.checkoutId === session.id && value.sellerOrderId === seller.id,
  );
  assert.equal(option.sellerName, 'Green Farm');
  assert.equal(option.orderNumber, details.orderNumber);
  assert.equal(option.items[0].thumbnail, `/media/files/${photoId}`);
  const foreign = `nest_session=${await jwt.signAsync({ sub: other, roles: ['buyer'] })}`;
  const foreignPage = await api
    .get('/orders')
    .set('Cookie', foreign)
    .expect(200);
  assert.ok(!foreignPage.text.includes(details.orderNumber));
  await api
    .get(`/orders/${session.id}/data`)
    .set('Cookie', foreign)
    .expect(404);
  await api.get('/orders').expect(401);
});
