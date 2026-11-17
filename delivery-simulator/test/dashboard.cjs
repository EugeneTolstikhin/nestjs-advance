require("reflect-metadata");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const hbs = require("hbs");
const { shipmentView } = require("../dist/dashboard-view");
const { DeliveryLedger } = require("../dist/ledger");
const template = hbs.handlebars.compile(
  readFileSync(join(__dirname, "../dist/views/dashboard.hbs"), "utf8"),
);

test("dashboard shows all statuses and unlocks subsequent delivery steps", () => {
  const ledger = new DeliveryLedger(":memory:");
  try {
    let shipment = ledger.create({
      reference: "test-order",
      method: "standard",
      country: "DE",
    });
    const initial = shipmentView(shipment, "test-token");
    assert.equal(initial.choices.length, 9);
    assert.deepEqual(
      initial.choices
        .filter((value) => !value.disabled)
        .map((value) => value.value),
      ["picked_up", "cancelled"],
    );
    const html = template({ shipments: [initial] });
    assert.match(html, /In transit/);
    assert.match(html, /Out for delivery/);
    assert.match(html, /Delivery failed/);
    assert.match(html, /value="in_transit"\s+disabled/);
    assert.match(html, /aria-current="step"/);
    for (const status of [
      "picked_up",
      "in_transit",
      "delivery_failed",
      "in_transit",
      "out_for_delivery",
      "delivered",
    ]) {
      assert.ok(
        shipmentView(shipment, "test-token").choices.some(
          (value) => value.value === status && !value.disabled,
        ),
      );
      shipment = ledger.update(
        shipment.trackingNumber,
        status,
        shipment.version,
      );
    }
    const finished = shipmentView(shipment, "test-token");
    assert.equal(finished.canUpdate, false);
    assert.equal(finished.statusLabel, "Delivered");
    assert.match(
      template({ shipments: [finished] }),
      /No further status changes/,
    );
    assert.ok(
      finished.events.every((event) => event.label && event.time.endsWith("Z")),
    );
  } finally {
    ledger.close();
  }
});

test("public tracking view has history and lifecycle without an update form", () => {
  const shipment = {
    reference: "test",
    trackingNumber: "NS-TEST",
    status: "label_created",
    version: 1,
    method: "standard",
    country: "DE",
    events: [{ sequence: 1, status: "label_created", occurredAt: Date.now() }],
  };
  const html = template({
    readOnly: true,
    shipments: [shipmentView(shipment)],
  });
  assert.match(html, /Label created/);
  assert.match(html, /Tracking history/);
  assert.doesNotMatch(html, /<form/);
});
