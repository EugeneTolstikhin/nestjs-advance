// Separate provider ledger: the shop can only observe outcomes through its API.
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type {
  PaymentRequest,
  ProviderPayment,
  ProviderStatus,
} from "./contracts";

export class SimulatorLedger {
  private readonly db: DatabaseSync;
  constructor(
    database: string,
    private readonly origin: string,
    private readonly shopOrigin: string,
  ) {
    this.db = new DatabaseSync(database);
    this.db.exec(`CREATE TABLE IF NOT EXISTS payments (
      reference TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, request TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', unavailableUntil INTEGER NOT NULL DEFAULT 0
    )`);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS refunds (reference TEXT PRIMARY KEY, paymentReference TEXT NOT NULL, amountCents INTEGER NOT NULL)",
    );
  }
  refund(input: {
    reference: string;
    paymentReference: string;
    amountCents: number;
  }) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db
        .prepare(
          "SELECT paymentReference, amountCents FROM refunds WHERE reference=?",
        )
        .get(input.reference);
      if (previous) {
        if (
          previous.paymentReference !== input.paymentReference ||
          previous.amountCents !== input.amountCents
        )
          throw new ConflictException("Refund reference already used");
      } else {
        const payment = this.get(input.paymentReference);
        const total = this.db
          .prepare(
            "SELECT COALESCE(SUM(amountCents),0) AS amount FROM refunds WHERE paymentReference=?",
          )
          .get(input.paymentReference)!;
        if (
          payment.status !== "succeeded" ||
          !Number.isSafeInteger(input.amountCents) ||
          input.amountCents <= 0 ||
          Number(total.amount) + input.amountCents > payment.amountCents
        )
          throw new ConflictException("Invalid refund amount or payment");
        this.db
          .prepare("INSERT INTO refunds VALUES (?,?,?)")
          .run(input.reference, input.paymentReference, input.amountCents);
      }
      this.db.exec("COMMIT");
      return { ...input, status: "succeeded" as const };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  create(request: PaymentRequest): ProviderPayment {
    const target = new URL(request.returnUrl);
    if (
      (request.method !== undefined &&
        !/^[a-z][a-z0-9_]{1,39}$/.test(request.method)) ||
      target.origin !== this.shopOrigin ||
      target.pathname !== "/checkout" ||
      request.currency !== "EUR" ||
      !Number.isSafeInteger(request.amountCents) ||
      request.amountCents < 0 ||
      !Number.isSafeInteger(request.expiresAt) ||
      request.expiresAt > Date.now() + 16 * 60_000
    )
      throw new ConflictException("Invalid payment request");
    const serialized = JSON.stringify(request);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO payments (reference, token, request) VALUES (?, ?, ?)",
      )
      .run(request.reference, randomBytes(32).toString("hex"), serialized);
    const row = this.row(request.reference);
    if (row.request !== serialized)
      throw new ConflictException(
        "Payment reference already has different details",
      );
    return this.get(request.reference);
  }
  private row(reference: string) {
    const row = this.db
      .prepare("SELECT * FROM payments WHERE reference = ?")
      .get(reference) as
      | {
          reference: string;
          token: string;
          request: string;
          status: ProviderStatus;
          unavailableUntil: number;
        }
      | undefined;
    if (!row) throw new NotFoundException("Payment not found");
    const request: PaymentRequest = JSON.parse(row.request);
    if (row.status === "pending" && request.expiresAt <= Date.now()) {
      this.db
        .prepare(
          "UPDATE payments SET status = 'expired' WHERE reference = ? AND status = 'pending'",
        )
        .run(reference);
      row.status = "expired";
    }
    return row;
  }
  get(reference: string): ProviderPayment {
    const row = this.row(reference);
    if (row.unavailableUntil > Date.now())
      throw new ServiceUnavailableException(
        "Simulated temporary provider outage",
      );
    return {
      ...JSON.parse(row.request),
      status: row.status,
      paymentUrl: `${this.origin}/pay/${row.token}`,
    };
  }
  cancel(reference: string) {
    this.row(reference);
    this.db
      .prepare(
        "UPDATE payments SET status = 'cancelled' WHERE reference = ? AND status = 'pending'",
      )
      .run(reference);
    return this.get(reference);
  }
  hosted(token: string) {
    const row = this.db
      .prepare("SELECT reference FROM payments WHERE token = ?")
      .get(token) as { reference: string } | undefined;
    if (!row) throw new NotFoundException("Payment not found");
    const stored = this.row(row.reference);
    return {
      ...JSON.parse(stored.request),
      status: stored.status,
    } as PaymentRequest & { status: ProviderStatus };
  }
  decide(token: string, decision: string) {
    const payment = this.hosted(token);
    const status =
      decision === "approve" || decision === "delayed"
        ? "succeeded"
        : decision === "decline"
          ? "failed"
          : "cancelled";
    this.db
      .prepare(
        "UPDATE payments SET status = ?, unavailableUntil = ? WHERE token = ? AND status = 'pending'",
      )
      .run(status, decision === "delayed" ? Date.now() + 10_000 : 0, token);
    return payment.returnUrl;
  }
  close() {
    this.db.close();
  }
}
