import "./load-env";
import "reflect-metadata";
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Module,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UsePipes,
  ValidationPipe,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { IsInt, IsIn, IsString, IsUUID, Matches, Min } from "class-validator";
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import hbs from "hbs";
import type { Request, Response } from "express";
import { DeliveryLedger } from "./ledger";
import { shipmentView } from "./dashboard-view";
import { transitions, type DeliveryStatus } from "./contracts";
const origin = process.env.DELIVERY_SIMULATOR_URL ?? "http://localhost:4500";
const secret = process.env.DELIVERY_SIMULATOR_SECRET ?? "";
const template = hbs.handlebars.compile(
  readFileSync(join(__dirname, "views/dashboard.hbs"), "utf8"),
);
let ledger: DeliveryLedger;
const equal = (a: string, b: string) =>
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const token = (number: string, version: number) =>
  createHmac("sha256", secret).update(`${number}:${version}`).digest("hex");
const auth = (header = "") => {
  if (!equal(header, `Bearer ${secret}`)) throw new UnauthorizedException();
};
class CreateShipmentDto {
  @IsUUID("4") reference: string;
  @IsString() @Matches(/^[a-z][a-z0-9_]{1,39}$/) method: string;
  @IsIn(["DE"]) country: string;
}
class UpdateStatusDto {
  @IsInt() @Min(1) version: number;
  @IsString() @Matches(/^[a-f0-9]{64}$/) csrf: string;
  @IsIn(Object.keys(transitions)) status: DeliveryStatus;
}
@Controller()
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  }),
)
class DeliveryController {
  @Post("api/shipments") create(
    @Headers("authorization") authorization: string,
    @Body() body: CreateShipmentDto,
  ) {
    auth(authorization);
    return ledger.create(body);
  }
  @Get("api/shipments/:reference") get(
    @Headers("authorization") authorization: string,
    @Param("reference") reference: string,
  ) {
    auth(authorization);
    return ledger.get(reference);
  }
  @Get() dashboard(@Res() response: Response) {
    response.set({
      "Cache-Control": "no-store",
      "Referrer-Policy": "same-origin",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    });
    response.type("html").send(
      template({
        shipments: ledger
          .list()
          .map((shipment) =>
            shipmentView(
              shipment,
              token(shipment.trackingNumber, shipment.version),
            ),
          ),
      }),
    );
  }
  @Get("track/:number") track(
    @Param("number") number: string,
    @Res() response: Response,
  ) {
    const shipment = ledger.tracking(number);
    response.set({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    });
    response
      .type("html")
      .send(template({ readOnly: true, shipments: [shipmentView(shipment)] }));
  }
  @Post("shipments/:number/status") update(
    @Param("number") number: string,
    @Body() body: UpdateStatusDto,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    if (
      request.get("origin") !== origin ||
      !equal(body.csrf, token(number, body.version))
    )
      throw new ForbiddenException("Invalid form origin or token");
    ledger.update(number, body.status, body.version);
    response.set("Cache-Control", "no-store").redirect(303, "/");
  }
}
@Module({ controllers: [DeliveryController] })
class DeliveryModule {}
async function main() {
  const url = new URL(origin);
  if (
    process.env.NODE_ENV === "production" ||
    secret.length < 32 ||
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    url.protocol !== "http:" ||
    url.origin !== origin
  )
    throw new Error(
      "Delivery simulator requires local development configuration and a shared secret",
    );
  mkdirSync(join(__dirname, "../data"), { recursive: true });
  ledger = new DeliveryLedger(
    process.env.DELIVERY_SIMULATOR_DATABASE ??
      join(__dirname, "../data/shipments.sqlite"),
  );
  const app = await NestFactory.create(DeliveryModule);
  app.enableShutdownHooks();
  await app.listen(Number(url.port || 4500), "127.0.0.1");
}
void main();
