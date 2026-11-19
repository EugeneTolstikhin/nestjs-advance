require("reflect-metadata");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { DeliveryLedger } = require("../dist/ledger");
test("idempotent shipment creation and ordered status history survive restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "delivery-ledger-"));
  let ledger = new DeliveryLedger(join(directory, "ledger.sqlite"));
  try {
    const request = {
      reference: randomUUID(),
      method: "standard",
      country: "DE",
    };
    const first = ledger.create(request);
    assert.equal(ledger.create(request).trackingNumber, first.trackingNumber);
    ledger.update(first.trackingNumber, "picked_up", 1);
    ledger.update(first.trackingNumber, "in_transit", 2);
    ledger.close();
    ledger = new DeliveryLedger(join(directory, "ledger.sqlite"));
    const restored = ledger.get(request.reference);
    assert.deepEqual(
      restored.events.map((event) => event.status),
      ["label_created", "picked_up", "in_transit"],
    );
    assert.equal(restored.version, 3);
    assert.throws(
      () => ledger.update(first.trackingNumber, "delivered", 3),
      (error) => error.getStatus() === 409,
    );
    assert.throws(
      () => ledger.update(first.trackingNumber, "out_for_delivery", 2),
      (error) => error.getStatus() === 409,
    );
    ledger.update(first.trackingNumber, "out_for_delivery", 3);
    ledger.update(first.trackingNumber, "delivered", 4);
    assert.throws(
      () => ledger.update(first.trackingNumber, "in_transit", 5),
      (error) => error.getStatus() === 409,
    );
  } finally {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed delivery can return to sender and finish without reopening delivery", () => {
  const ledger = new DeliveryLedger(":memory:");
  try {
    let shipment = ledger.create({
      reference: randomUUID(),
      method: "standard",
      country: "DE",
    });
    for (const status of [
      "picked_up",
      "in_transit",
      "out_for_delivery",
      "delivery_failed",
      "returning_to_sender",
      "returned_to_sender",
    ]) {
      if (status === "returned_to_sender") {
        assert.throws(
          () =>
            ledger.update(
              shipment.trackingNumber,
              "in_transit",
              shipment.version,
            ),
          (error) => error.getStatus() === 409,
        );
      }
      shipment = ledger.update(
        shipment.trackingNumber,
        status,
        shipment.version,
      );
    }
    assert.equal(shipment.status, "returned_to_sender");
    for (const status of ["in_transit", "delivered", "delivery_failed"]) {
      assert.throws(
        () => ledger.update(shipment.trackingNumber, status, shipment.version),
        (error) => error.getStatus() === 409,
      );
    }
    assert.deepEqual(
      shipment.events.slice(-2).map((event) => event.status),
      ["returning_to_sender", "returned_to_sender"],
    );
  } finally {
    ledger.close();
  }
});

test('carrier claims are idempotent, versioned and retain their terminal outcome', () => {
  const ledger = new DeliveryLedger(':memory:');
  try {
    const shipment = ledger.create({ reference: randomUUID(), method: 'standard', country: 'DE' });
    const input = { reference: randomUUID(), shipmentReference: shipment.reference, notes: 'One item missing' };
    assert.equal(ledger.createClaim(input).status, 'open');
    assert.equal(ledger.createClaim(input).version, 1);
    ledger.updateClaim(input.reference, 'investigating', 'Checking parcel history', 1);
    assert.throws(() => ledger.updateClaim(input.reference, 'approved', 'Confirmed', 1), error => error.getStatus() === 409);
    ledger.updateClaim(input.reference, 'approved', 'Damage confirmed', 2);
    assert.equal(ledger.getClaim(input.reference).resolution, 'Damage confirmed');
    assert.throws(() => ledger.updateClaim(input.reference, 'rejected', 'Changed', 3), error => error.getStatus() === 409);
  } finally { ledger.close(); }
});
