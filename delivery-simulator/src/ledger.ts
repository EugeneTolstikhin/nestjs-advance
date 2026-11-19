import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { ConflictException, NotFoundException } from "@nestjs/common";
import {
  transitions,
  type CarrierClaim,
  type DeliveryStatus,
  type Shipment,
  type ShipmentRequest,
} from "./contracts";
export class DeliveryLedger {
  private db: DatabaseSync;
  constructor(database: string) {
    this.db = new DatabaseSync(database);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS shipments (reference TEXT PRIMARY KEY, trackingNumber TEXT NOT NULL UNIQUE, data TEXT NOT NULL)",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS carrier_claims (reference TEXT PRIMARY KEY, data TEXT NOT NULL)",
    );
  }
  createClaim(request: {
    reference: string;
    shipmentReference: string;
    notes: string;
  }): CarrierClaim {
    this.get(request.shipmentReference);
    const existing = this.db
      .prepare("SELECT data FROM carrier_claims WHERE reference=?")
      .get(request.reference);
    if (existing) {
      const claim: CarrierClaim = JSON.parse(existing.data as string);
      if (
        claim.shipmentReference !== request.shipmentReference ||
        claim.notes !== request.notes
      )
        throw new ConflictException("Claim reference already used");
      return claim;
    }
    const claim: CarrierClaim = {
      ...request,
      status: "open",
      resolution: "",
      version: 1,
    };
    this.db
      .prepare("INSERT INTO carrier_claims VALUES (?, ?)")
      .run(request.reference, JSON.stringify(claim));
    return claim;
  }
  getClaim(reference: string): CarrierClaim {
    const row = this.db
      .prepare("SELECT data FROM carrier_claims WHERE reference=?")
      .get(reference);
    if (!row) throw new NotFoundException("Claim not found");
    return JSON.parse(row.data as string);
  }
  claims(): CarrierClaim[] {
    return this.db
      .prepare("SELECT data FROM carrier_claims ORDER BY rowid DESC LIMIT 100")
      .all()
      .map((row) => JSON.parse(row.data as string));
  }
  updateClaim(
    reference: string,
    status: CarrierClaim["status"],
    resolution: string,
    version: number,
  ) {
    const claim = this.getClaim(reference);
    if (
      claim.version !== version ||
      ["approved", "rejected"].includes(claim.status) ||
      !["investigating", "approved", "rejected"].includes(status) ||
      status === claim.status ||
      !resolution.trim()
    )
      throw new ConflictException("Invalid or stale claim decision");
    const previous = JSON.stringify(claim);
    claim.status = status;
    claim.resolution = resolution;
    claim.version++;
    const update = this.db
      .prepare("UPDATE carrier_claims SET data=? WHERE reference=? AND data=?")
      .run(JSON.stringify(claim), reference, previous);
    if (update.changes !== 1) throw new ConflictException("Claim changed");
    return claim;
  }
  create(request: ShipmentRequest): Shipment {
    const existing = this.db
      .prepare("SELECT data FROM shipments WHERE reference=?")
      .get(request.reference);
    if (existing) {
      const stored: Shipment = JSON.parse(existing.data as string);
      if (
        stored.method !== request.method ||
        stored.country !== request.country ||
        (stored.direction ?? "outbound") !==
          (request.direction ?? "outbound") ||
        stored.relatedReference !== request.relatedReference
      )
        throw new ConflictException(
          "Shipment reference already has different details",
        );
      return stored;
    }
    const shipment: Shipment = {
      ...request,
      trackingNumber: `NS-${randomBytes(8).toString("hex").toUpperCase()}`,
      status: "label_created",
      version: 1,
      events: [
        { sequence: 1, status: "label_created", occurredAt: Date.now() },
      ],
    };
    this.db
      .prepare("INSERT INTO shipments VALUES (?, ?, ?)")
      .run(
        shipment.reference,
        shipment.trackingNumber,
        JSON.stringify(shipment),
      );
    return shipment;
  }
  get(reference: string): Shipment {
    const row = this.db
      .prepare("SELECT data FROM shipments WHERE reference=?")
      .get(reference);
    if (!row) throw new NotFoundException("Shipment not found");
    return JSON.parse(row.data as string);
  }
  tracking(number: string): Shipment {
    const row = this.db
      .prepare("SELECT reference FROM shipments WHERE trackingNumber=?")
      .get(number);
    if (!row) throw new NotFoundException("Shipment not found");
    return this.get(row.reference as string);
  }
  list(): Shipment[] {
    return this.db
      .prepare("SELECT data FROM shipments ORDER BY rowid DESC LIMIT 100")
      .all()
      .map((row) => JSON.parse(row.data as string));
  }
  update(number: string, status: DeliveryStatus, version: number): Shipment {
    const shipment = this.tracking(number);
    if (shipment.version !== version)
      throw new ConflictException("Shipment changed. Reload the dashboard.");
    if (!transitions[shipment.status].includes(status))
      throw new ConflictException(
        "This delivery status transition is not allowed",
      );
    const previous = JSON.stringify(shipment);
    shipment.version++;
    shipment.status = status;
    shipment.events.push({
      sequence: shipment.version,
      status,
      occurredAt: Date.now(),
    });
    const result = this.db
      .prepare("UPDATE shipments SET data=? WHERE reference=? AND data=?")
      .run(JSON.stringify(shipment), shipment.reference, previous);
    if (result.changes !== 1)
      throw new ConflictException("Shipment changed. Reload the dashboard.");
    return shipment;
  }
  close() {
    this.db.close();
  }
}
