import "./load-env";
import "reflect-metadata";
import {
  Body,
  Controller,
  Get,
  Headers,
  Module,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  ValidationPipe,
  UsePipes,
  ForbiddenException,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  IsInt,
  IsString,
  IsUUID,
  Min,
  MaxLength,
  Equals,
  IsIn,
  IsOptional,
  Matches,
} from "class-validator";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import hbs from "hbs";
import { readFileSync, mkdirSync } from "node:fs";
import type { Request, Response } from "express";
import { SimulatorLedger } from "./simulator";

class CreatePaymentDto {
  @IsUUID("4") reference: string;
  @IsOptional() @IsString() @Matches(/^[a-z][a-z0-9_]{1,39}$/) method?: string;
  @IsInt() @Min(0) amountCents: number;
  @Equals("EUR") currency: string;
  @IsInt() expiresAt: number;
  @IsString() @MaxLength(300) returnUrl: string;
}
class DecisionDto {
  @IsIn(["approve", "decline", "cancel", "delayed"]) decision: string;
}
const origin = process.env.PAYMENT_SIMULATOR_URL ?? "http://localhost:4400";
const secret = process.env.PAYMENT_SIMULATOR_SECRET ?? "";
const shopOrigin = process.env.SHOP_ORIGIN ?? "http://localhost:3000";
if (new URL(shopOrigin).origin !== shopOrigin) throw new Error("SHOP_ORIGIN must be an origin");
let ledger: SimulatorLedger;
const template = hbs.handlebars.compile(
  readFileSync(join(__dirname, "views/simulator.hbs"), "utf8"),
);
function authorize(value?: string) {
  const supplied = Buffer.from(value ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    throw new UnauthorizedException();
}
@Controller()
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
class SimulatorController {
  @Post("api/payments") create(
    @Headers("authorization") auth: string,
    @Body() body: CreatePaymentDto,
  ) {
    authorize(auth);
    return ledger.create(body);
  }
  @Get("api/payments/:id") get(
    @Headers("authorization") auth: string,
    @Param("id") id: string,
  ) {
    authorize(auth);
    return ledger.get(id);
  }
  @Post("api/payments/:id/cancel") cancel(
    @Headers("authorization") auth: string,
    @Param("id") id: string,
  ) {
    authorize(auth);
    return ledger.cancel(id);
  }
  @Get("pay/:token") hosted(
    @Param("token") token: string,
    @Res() response: Response,
  ) {
    const payment = ledger.hosted(token);
    response.set({
      "Cache-Control": "no-store",
      // Native form POSTs acquire Origin: null under no-referrer. Preserve
      // same-origin form submissions while hiding hosted tokens from the shop.
      "Referrer-Policy": "same-origin",
      "Content-Security-Policy":
        // Some browsers also apply form-action to the final 303 redirect.
        `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${shopOrigin}; frame-ancestors 'none'`,
    });
    response.type("html").send(
      template({
        ...payment,
        pending: payment.status === "pending",
        amount: new Intl.NumberFormat("en-IE", {
          style: "currency",
          currency: "EUR",
        }).format(payment.amountCents / 100),
      }),
    );
  }
  @Post("pay/:token") decide(
    @Param("token") token: string,
    @Body() body: DecisionDto,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    if (request.get("origin") !== origin)
      throw new ForbiddenException("Invalid origin");
    response
      .set("Cache-Control", "no-store")
      .redirect(303, ledger.decide(token, body.decision));
  }
}
@Module({ controllers: [SimulatorController] })
class SimulatorModule {}
async function start() {
  if (process.env.NODE_ENV === "production" || secret.length < 32)
    throw new Error(
      "Simulator requires development mode and a shared secret of at least 32 characters",
    );
  const parsed = new URL(origin);
  if (
    !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
    parsed.protocol !== "http:"
  )
    throw new Error("Simulator must listen locally");
  mkdirSync(join(__dirname, "../data"), { recursive: true });
  ledger = new SimulatorLedger(
    process.env.PAYMENT_SIMULATOR_DATABASE ??
      join(__dirname, "../data/payments.sqlite"),
    origin,
    shopOrigin,
  );
  const app = await NestFactory.create(SimulatorModule);
  app.enableShutdownHooks();
  await app.listen(Number(parsed.port || 4400), "127.0.0.1");
}
void start();
