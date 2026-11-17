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
    PAYMENT_PROVIDERS: 'disabled',
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
          entities: [Products, ProductMedia, CheckoutSession, StockReservation],
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
  service = modules.get(OrderConfirmationService);
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
test('paid confirmation creates per-seller PDFs, tracking numbers and asynchronous SMTP invoice emails', async () => {
  const created = await paid(buyer);
  confirmed = created.checkoutId;
  sellerOrders = created.sellerOrders;
  const ready = await until(async () => {
    const current = await data(confirmed);
    return current.sellers.every(
      (seller) =>
        seller.invoice?.status === 'ready' &&
        seller.shipment?.trackingNumber &&
        seller.notifications.some(
          (notice) =>
            notice.kind === 'confirmation' && notice.status === 'sent',
        ),
    )
      ? current
      : false;
  }, 'invoice generation, tracking and SMTP confirmation');
  assert.equal(ready.recipient, 'buyer@example.test');
  assert.equal(ready.sellers.length, 2);
  const messages = (await inbox()).messages;
  assert.equal(messages.length, 2);
  for (const summary of messages) {
    const message = await mail(`/api/v1/message/${summary.ID}`);
    assert.equal(message.To[0].Address, 'buyer@example.test');
    assert.equal(message.Attachments.length, 1);
    assert.match(message.Attachments[0].FileName, /^DEMO-.*\.pdf$/);
    assert.match(message.Text, /Tracking: NS-/);
    assert.match(message.HTML, /Nest Shop/);
  }
  const file = await api
    .get(`/orders/${confirmed}/invoices/${sellerOrders[0].id}`)
    .set('Cookie', cookie)
    .expect(200)
    .expect('Content-Type', /application\/pdf/)
    .expect('Cache-Control', 'private, no-store');
  assert.equal(file.body.subarray(0, 5).toString(), '%PDF-');
  await api
    .get(`/orders/${confirmed}/invoices/${sellerOrders[0].id}?inline=1`)
    .set('Cookie', cookie)
    .expect(200)
    .expect('Content-Disposition', /^inline;/);
  const page = await api
    .get(`/orders/${confirmed}`)
    .set('Cookie', cookie)
    .expect(200);
  assert.match(page.text, /Order confirmed/);
});
test('all missed delivery events are caught in order, emailed asynchronously and not duplicated on replay', async () => {
  const current = await data(confirmed);
  const number = current.sellers[0].shipment.trackingNumber;
  await changeStatus(number, 'picked_up');
  await changeStatus(number, 'in_transit');
  const ready = await until(async () => {
    const view = await data(confirmed);
    const seller = view.sellers[0];
    return seller.shipment.version === 3 &&
      seller.notifications.filter((notice) => notice.status === 'sent')
        .length === 3
      ? view
      : false;
  }, 'all tracking event emails');
  assert.deepEqual(
    ready.sellers[0].shipment.events.map((event) => event.status),
    ['label_created', 'picked_up', 'in_transit'],
  );
  await service.syncDelivery(confirmed);
  await service.syncDelivery(confirmed);
  assert.equal((await inbox()).messages.length, 4);
  const updateMessages = await Promise.all(
    (await inbox()).messages.map((value) =>
      mail(`/api/v1/message/${value.ID}`),
    ),
  );
  assert.ok(
    updateMessages.some((value) => value.Text.includes('Status: picked up')),
  );
  assert.ok(
    updateMessages.some((value) => value.Text.includes('Status: in transit')),
  );
  let attempts = 0;
  const send = emailAdapter.send.bind(emailAdapter);
  emailAdapter.send = async (message) => {
    attempts++;
    if (attempts === 1) throw new Error('Temporary SMTP failure');
    return send(message);
  };
  await changeStatus(number, 'out_for_delivery');
  await until(
    async () =>
      (await data(confirmed)).sellers[0].notifications.some(
        (value) => value.event.sequence === 4 && value.status === 'sent',
      ),
    'email retry',
  );
  assert.ok(attempts >= 2);
  emailAdapter.send = send;
  assert.equal((await inbox()).messages.length, 5);
});
test('return-to-sender events are emailed and the received parcel is no longer polled', async () => {
  const initial = await data(confirmed);
  const shipment = initial.sellers[0].shipment;
  for (const status of [
    'delivery_failed',
    'returning_to_sender',
    'returned_to_sender',
  ]) {
    await changeStatus(shipment.trackingNumber, status);
  }
  await until(async () => {
    const seller = (await data(confirmed)).sellers[0];
    return (
      seller.shipment.status === 'returned_to_sender' &&
      seller.notifications.filter((notice) => notice.status === 'sent')
        .length === 7
    );
  }, 'return tracking and email updates');
  const messages = await Promise.all(
    (await inbox()).messages.map((value) =>
      mail(`/api/v1/message/${value.ID}`),
    ),
  );
  assert.ok(
    messages.some((message) =>
      message.Text.includes('Status: returning to sender'),
    ),
  );
  assert.ok(
    messages.some((message) =>
      message.Text.includes('Status: returned to sender'),
    ),
  );
  assert.equal(messages.length, 8);
  const { DeliveryProviderFactory } = require(
    `${build}/orders/delivery-provider`,
  );
  const adapter = modules.get(DeliveryProviderFactory).create();
  const original = adapter.get.bind(adapter);
  let returnedPolls = 0;
  adapter.get = async (reference) => {
    if (reference === shipment.reference) returnedPolls++;
    return original(reference);
  };
  try {
    await service.syncDelivery(confirmed);
  } finally {
    adapter.get = original;
  }
  assert.equal(returnedPolls, 0);
  assert.equal((await inbox()).messages.length, 8);
});
test('invoices and confirmation data are owner-only and never served as public assets', async () => {
  const foreign = `nest_session=${await jwt.signAsync({ sub: other, roles: ['buyer'] })}`;
  await api.get(`/orders/${confirmed}`).expect(401);
  await api.get(`/orders/${confirmed}/data`).set('Cookie', foreign).expect(404);
  await api
    .get(`/orders/${confirmed}/invoices/${sellerOrders[0].id}`)
    .set('Cookie', foreign)
    .expect(404);
  await api
    .get(`/orders/${confirmed}/invoices/${randomUUID()}`)
    .set('Cookie', cookie)
    .expect(404);
  await api.get(`/assets/invoices/${sellerOrders[0].id}.pdf`).expect(404);
});
test('phone-only/unverified-email buyers get private downloads and tracking without sending to an unverified destination', async () => {
  const created = await paid(other);
  const foreign = `nest_session=${await jwt.signAsync({ sub: other, roles: ['buyer'] })}`;
  const ready = await until(async () => {
    const view = await data(created.checkoutId, foreign);
    return view.sellers.every(
      (value) =>
        value.invoice?.status === 'ready' &&
        value.shipment?.trackingNumber &&
        value.notifications.some((notice) => notice.status === 'skipped'),
    )
      ? view
      : false;
  });
  assert.equal(ready.recipient, null);
  await api
    .get(`/orders/${created.checkoutId}/invoices/${created.sellerOrders[0].id}`)
    .set('Cookie', foreign)
    .expect(200);
  assert.equal((await inbox()).messages.length, 8);
});
