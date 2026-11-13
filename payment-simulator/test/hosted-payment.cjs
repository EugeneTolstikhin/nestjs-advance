const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { mkdtemp, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { createServer } = require('node:net');
const { spawn } = require('node:child_process');
let directory, child, origin, secret;
const shopOrigin = 'http://localhost:3000';
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hosted-payment-'));
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  origin = `http://127.0.0.1:${port}`; secret = randomBytes(32).toString('hex');
  child = spawn(process.execPath, [join(__dirname, '../dist/main.js')], {
    env: { ...process.env, NODE_ENV: 'test', PAYMENT_SIMULATOR_SECRET: secret, PAYMENT_SIMULATOR_URL: origin, SHOP_ORIGIN: shopOrigin, PAYMENT_SIMULATOR_DATABASE: join(directory, 'provider.sqlite') },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let errorOutput = ''; child.stderr.on('data', chunk => { errorOutput += chunk; });
  const deadline = Date.now() + 10000;
  while (true) {
    if (child.exitCode !== null) throw new Error(`Simulator exited: ${errorOutput}`);
    try { if ((await fetch(`${origin}/api/payments/unknown`)).status === 401) break; } catch {}
    if (Date.now() > deadline) throw new Error('Simulator startup timed out');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
});
after(async () => {
  if (child?.exitCode === null) { const exit = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exit; }
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function payment() {
  const body = { reference: randomUUID(), amountCents: 1099, currency: 'EUR', expiresAt: Date.now() + 60000, returnUrl: `${shopOrigin}/checkout?session=${randomUUID()}` };
  const response = await fetch(`${origin}/api/payments`, { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 201); return { ...await response.json(), returnUrl: body.returnUrl };
}
function post(url, decision, sourceOrigin) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(sourceOrigin === undefined ? {} : { Origin: sourceOrigin }) }, body: new URLSearchParams({ decision }), redirect: 'manual' });
}
test('hosted page preserves native form Origin and permits only its provider and configured shop redirect', async () => {
  const intent = await payment(); const page = await fetch(intent.paymentUrl);
  assert.equal(page.headers.get('referrer-policy'), 'same-origin');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(page.headers.get('content-security-policy'), new RegExp(`form-action 'self' ${shopOrigin}`));
  assert.match(await page.text(), /form method="post"/);
});
for (const [decision, expected] of [['approve', 'succeeded'], ['decline', 'failed'], ['cancel', 'cancelled'], ['delayed', 'succeeded']]) {
  test(`${decision} form submission saves the outcome and redirects back to the shop`, async () => {
    const intent = await payment();
    const response = await post(intent.paymentUrl, decision, origin);
    assert.equal(response.status, 303); assert.equal(response.headers.get('location'), intent.returnUrl);
    const result = await fetch(`${origin}/api/payments/${intent.reference}`, { headers: { Authorization: `Bearer ${secret}` } });
    if (decision === 'delayed') {
      assert.equal(result.status, 503);
      const hosted = await fetch(intent.paymentUrl); assert.match(await hosted.text(), /<strong>succeeded<\/strong>/);
    } else { assert.equal(result.status, 200); assert.equal((await result.json()).status, expected); }
  });
}
test('foreign, null and missing origins remain rejected without changing the intent', async () => {
  const intent = await payment();
  for (const source of ['https://attacker.test', 'null', undefined])
    assert.equal((await post(intent.paymentUrl, 'approve', source)).status, 403);
  const response = await fetch(`${origin}/api/payments/${intent.reference}`, { headers: { Authorization: `Bearer ${secret}` } });
  assert.equal((await response.json()).status, 'pending');
});
