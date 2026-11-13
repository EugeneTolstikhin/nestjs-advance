require('reflect-metadata');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { SimulatorLedger } = require('../dist/simulator');
let ledger, directory;
const origin = 'http://localhost:4400';
const shop = 'http://localhost:3000';
const request = () => ({ reference: randomUUID(), amountCents: 999, currency: 'EUR', expiresAt: Date.now() + 60000, returnUrl: `${shop}/checkout?session=${randomUUID()}` });
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'simulator-ledger-')); ledger = new SimulatorLedger(join(directory, 'ledger.sqlite'), origin, shop); });
afterEach(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
test('idempotent creation reuses the same hosted page and rejects different amounts', () => {
 const body = request(); const first = ledger.create(body);
 assert.equal(ledger.create(body).paymentUrl, first.paymentUrl);
 assert.throws(() => ledger.create({ ...body, amountCents: 1 }), error => error.getStatus() === 409);
 assert.match(first.paymentUrl, /^http:\/\/localhost:4400\/pay\/[a-f0-9]{64}$/);
});
test('provider decisions persist across restart and cannot be reversed', () => {
 const body = request(); const payment = ledger.create(body); const token = payment.paymentUrl.split('/').pop();
 assert.equal(ledger.decide(token, 'approve'), body.returnUrl);
 ledger.close(); ledger = new SimulatorLedger(join(directory, 'ledger.sqlite'), origin, shop);
 assert.equal(ledger.get(body.reference).status, 'succeeded');
 ledger.decide(token, 'decline'); assert.equal(ledger.cancel(body.reference).status, 'succeeded');
});
test('an unpaid deadline expires, and delayed confirmation temporarily hides an already saved success', () => {
 const body = request(); const expired = ledger.create({ ...body, expiresAt: Date.now() - 1 }); assert.equal(expired.status, 'expired');
 const pending = ledger.create(request()); ledger.decide(pending.paymentUrl.split('/').pop(), 'delayed');
 assert.throws(() => ledger.get(pending.reference), error => error.getStatus() === 503);
 assert.equal(ledger.hosted(pending.paymentUrl.split('/').pop()).status, 'succeeded');
});
test('rejects foreign return destinations and treats lookup strings as literal parameters', () => {
 assert.throws(() => ledger.create({ ...request(), returnUrl: 'https://attacker.test/checkout' }), error => error.getStatus() === 409);
 assert.throws(() => ledger.get("x'; DROP TABLE payments; --"), error => error.getStatus() === 404);
 assert.equal(ledger.create(request()).status, 'pending');
});
