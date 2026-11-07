# nestjs-advance

See [AUTH.md](./AUTH.md) for JWT setup, registration/login examples, product
permissions, and authentication tests.

See [STOCK.md](./STOCK.md) for seller stock counts, restocking and future checkout integration.

## Handlebars UI

The HTML UI is rendered by NestJS inside `backend/`; no separate frontend project
is needed. The JWT secret is loaded automatically from `backend/.env`. Run
`npm run start:dev` and open `http://localhost:3000/shop`.

- `src/products/products-page.controller.ts`: public HTML page, using `@Render('products')`.
- `src/views/products.hbs`: Handlebars template.
- `src/views/includes/navbar.hbs`: shared navigation, included with `{{> navbar}}`.
- `src/public/styles.css`: stylesheet, served at `/assets/styles.css`.
- `src/views.config.ts`: Express view engine and static asset setup.

### Browser TypeScript

Edit browser behavior in `src/client/*.ts`. These scripts have a separate strict
configuration (`tsconfig.client.json`) with DOM types and no Node.js globals.
`src/public` contains static CSS and images; generated JavaScript and source maps
go to `dist/public`. The existing Handlebars script URLs stay the same.

- `npm run start:dev`: compile the browser scripts, then watch both browser and NestJS code.
- `npm run typecheck:client`: check browser types without generating files.
- `npm run build:client`: compile only the browser scripts.
- `npm run build`: build NestJS and the browser scripts for production.

Restart an existing development server once after this migration to activate both
watchers. Development preserves the shared `dist` directory; production builds
still clean it before building. Stop development watchers before running a full
production build.

The browser scripts remain classic scripts, using the existing local SurveyJS
and tus bundles. `src/client/globals.d.ts` describes those globals using the
installed packages' types. No frontend framework or bundler is required.
Browser tests compile their TypeScript source before evaluating it in Happy DOM.

The shop lists products from SQLite and shows an empty state until products are
added. Buyer/seller registration is available at `/auth/register` through SurveyJS,
with OTP verification before MongoDB persistence. SurveyJS login at `/auth/login`
supports email/password, email/code and phone/code. Sellers can add, edit and
delete catalog products through the UI. JSON product endpoints remain under `/products`; `/` redirects
to `/shop`.

The navbar logo links to `/`. Without a `user` in the server-rendered view model,
it displays Login and Register links to `/auth/login` and `/auth/register`. With
`user: { name: 'Eugene' }`, it displays a generic avatar and the escaped name;
`user.username` is the fallback when `name` is absent. The shop and authentication
page load their user context from the verified HttpOnly session cookie and MongoDB.
Registration sets the cookie only after all supplied contacts pass OTP verification.
Login sets the same cookie and redirects to `/shop`. Logout clears it and returns
to the guest navbar. Development email codes appear in Mailpit at
`http://localhost:8025`; SMS codes appear in SMSpit at `http://localhost:4301`.
See [AUTH.md](./AUTH.md) for API payloads and limits, [EMAIL.md](./EMAIL.md) for SMTP
setup and [SMS.md](./SMS.md) for the local SMS inbox (`npm run sms:start`).

Signed-in users can open **My account** (`/account`) to enable buying and selling
on the same account and edit their separate profiles through SurveyJS. Contacts
remain unique across accounts. Existing single-role users migrate automatically;
new JWTs use a `roles` array. See [the account model](./AUTH.md#one-account-for-buying-and-selling).

In the SurveyJS forms, Enter from a single-line text field validates the current
page and activates Continue or the final action (login, verification or profile
save). Multiline fields retain Enter for newlines, while dropdowns and radio
groups keep their usual keyboard controls. Buttons remain usable with Tab and
their native Enter/Space activation.

### Managing products

Product editors now include bulk local photo/video uploads with tus resume,
ordering controls, and mixed-media buyer carousels. See [MEDIA.md](./MEDIA.md) for
formats, limits, FFmpeg setup, storage configuration and the upload API.

Sign in with the seller role enabled (use **My account** to enable selling).
On `/shop`, choose **Add product** to open `/shop/new`, or **Edit** on a product
to open `/shop/:id/edit`. SurveyJS collects a unique name, description, a
non-negative price with up to two decimal places. Photos and videos are managed
through the upload area. Save uses the existing `POST /products` or `PUT /products/:id` API;
removing uploaded items and saving removes them from the gallery. Enter in a single-line field
submits through normal validation. Cancel returns to the catalog.

**Delete** opens a confirmation dialog and calls `DELETE /products/:id` only
after confirmation. Cancel/Escape leaves the product unchanged. Failed writes
show an error and preserve the form/dialog for retry. Expired sessions show a
login message without discarding edits. Successful writes return to `/shop`.

Guests/buyers see the public catalog without management controls. Sellers can
manage the shared catalog; admins retain delete-only access. Products currently
have no owner/seller field, so edit/delete access is role-based across the catalog.
The server enforces permissions independently of the buttons. Browser writes use
the existing HttpOnly cookie with same-origin checks; API Bearer tokens also work.
POST/PUT/PATCH require JSON. No JWT is exposed in the page or browser storage.

Nest CLI copies templates and public assets into `dist/` during builds and watches
them during development. `npm run build` followed by `npm run start:prod` also
serves the UI. Handlebars `{{value}}` expressions escape user text; avoid triple
braces for user-supplied content.

Run `npm run test:views` to verify rendering with an isolated SQLite database and
the built templates. Consider a separate `frontend/` only if you later introduce
an independently built frontend application.

## Shopping cart

Buyers can add catalog products, change quantities and remove items at `/cart`.
The account cart is saved in MongoDB and follows the user between devices and
logins. Guests and seller-only accounts get an access message; empty carts show
an empty state. See [CART.md](./CART.md) for API details, synchronization and tests.

## OTP sender factory

OTP delivery and media processing run as BullMQ background jobs. Workers start
with the application and use local Redis. See [JOBS.md](./JOBS.md) for setup,
retries, processing status, and where to add future provider/media implementations.

`src/user-interaction/configs/otp.config.json` configures the `phone` provider.
Development phone delivery uses SMSpit, configured by `SMS_PROVIDER` and `SMSPIT_*`.
`SMS_PROVIDER=configured` uses JSON phone settings; missing providers/APIs then
fall back to LOG. Email uses Mailpit in development
and authenticated SMTP in production, configured by `EMAIL_PROVIDER` and `SMTP_*`
environment variables. See [EMAIL.md](./EMAIL.md) and the credential-free `.env`
examples. Malformed JSON or environment settings raise configuration errors.

Inject the abstract `OtpFactory` exported by `UserInteractionModule`:

```ts
constructor(private readonly otpFactory: OtpFactory) {}

async sendPhoneCode(phone: string) {
    const sender = await this.otpFactory.create('phone');
    return sender.sendOtp(phone);
}
```

Use `create('email')` for email, or `create()` / `create('LOG')` for LOG regardless
of the configured providers. `UserInteractionService.sendOtp(recipient)` detects
the channel automatically: E.164 phone numbers (for example `+4917612345678`)
select phone, email addresses select email, and an absent recipient selects LOG.
With `SMS_PROVIDER=configured`, an absent phone provider/API returns a LOG sender.
The development default is SMSpit. Email uses
the configured SMTP transport; `EMAIL_PROVIDER=LOG` explicitly enables local logging.
Invalid recipients return 400. Provider delivery failures are not silently retried
through LOG. LOG delivery is blocked when `NODE_ENV=production`.

Send `POST /user-interaction` with JSON:

```json
{ "recipient": "+4917612345678" }
```

Or use `{"recipient":"person@example.com"}` for email and `{}` for explicit
default behavior. The LOG sender writes a six-digit code to the development log
without returning it in the response.

For future provider integrations, a channel setting can look like:

```json
{
  "provider": "seven",
  "api": {
    "url": "https://gateway.seven.io/api/rcs/messages",
    "keyEnv": "SEVEN_API_KEY"
  }
}
```

Store API credentials in environment variables, not this JSON. Non-LOG phone
configuration selects `SmsOtpHandler`. Its SMSpit branch is implemented; the
external production-provider branch remains a placeholder returning 501.
Email selects the implemented SMTP `EmailOtpHandler`. Provider-specific SMS/RCS
payloads, authentication and routing must still be implemented in the phone adapter.
The standalone OTP endpoint is a delivery demo;
registration uses `RegistrationService` to manage hashed codes, expiry, verification
attempts, resend limits, and completion.

`EnvironmentOtpConfigSource` combines phone JSON with email environment settings
each time a sender is requested. To load
settings from database records later, implement `OtpConfigSource.load()` and
replace its provider binding in `UserInteractionModule`. The factory and its
callers stay unchanged. The JSON is copied into `dist` by the Nest CLI.

## SQLite database

`AppModule` connects TypeORM to `backend/database.sqlite` using `better-sqlite3`.
The file is created automatically when the application starts and is ignored by
Git, along with its journal files. No separate database server is needed.

Entity files matching `*.entity.ts` (or compiled `*.entity.js`) are discovered
under the application directory. The product entity maps to the `products` table.
All product CRUD operations use TypeORM repositories. Verified users are stored
in local MongoDB; short-lived registration/login challenges and rate limits use
Redis when `AUTH_STORAGE=redis`, or process memory when `AUTH_STORAGE=memory`.
The local `.env` selects Redis at `redis://127.0.0.1:6379`. Start it with
`brew services start redis`. See [AUTH.md](./AUTH.md#shared-authentication-storage-redis)
for setup, storage choices, connection parameters and shared-state tests.

Product reads support optional `limit` and `page` query parameters. Both must be
positive integers. `limit` alone returns the first page; `page` requires `limit`.
Without either parameter, all products are returned, ordered by creation time
and ID. PUT replaces editable product details, while
PATCH preserves omitted fields. DELETE returns the remaining products. Duplicate
names return 409, and reading, editing or deleting a missing product returns 404.

Run the SQLite CRUD regression tests with `npm run test:products`. These use an
isolated in-memory database and do not modify `database.sqlite`.

Schema synchronization is enabled for local development and disabled when
`NODE_ENV=production`. Use migrations for production schema changes.

## Response PII masking

`PiiInterceptor` masks responses globally by default. Import `MaskPii` from
`src/interceptor/pii/mask-pii.decorator` and use `@MaskPii(false)` on a route or
controller to return its response unchanged. Use `@MaskPii()` or `@MaskPii(true)`
to enable masking explicitly. A route's setting takes priority over its controller.

Unmasked routes must enforce authentication and ownership or role permissions
separately. The decorator only controls response presentation and does not grant
access. Query parameters and client headers cannot disable masking. Opting out
also skips password-field filtering, so return a safe response DTO that excludes
passwords and hashes. Existing routes remain masked by default.

<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ npm install
```

## Compile and run the project

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ npm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Observability

In production applications, observability is essential for understanding how your system behaves, detecting issues early, and maintaining reliable performance.

[NestJS Observe](https://observe.nestjs.com) automatically instruments your NestJS application, giving you deep visibility into your system with minimal setup:

- **Distributed tracing:** Follow requests across services and understand how they flow through your system.
- **Waterfall analysis:** Visualize request execution and identify slow operations, bottlenecks, and unexpected delays.
- **Performance analysis:** Analyze application performance in real time and quickly pinpoint areas that need optimization.
- **Metrics:** Track key application and infrastructure metrics to understand system health and performance trends.
- **Logging:** Centralize and correlate logs with traces and other telemetry to make debugging easier.
- **Error tracking:** Detect errors quickly and investigate their root causes with the surrounding context.
- **SLA monitoring:** Track service-level objectives and identify when your application is approaching or exceeding defined thresholds.
- **Alarms and alerts:** Set up alerts for critical errors, performance degradation, SLA violations, and other anomalies so your team can react quickly.

To add it to this project, run this and approve the code it prints at [observe.nestjs.com/link](https://observe.nestjs.com/link) - signing up for free if you have no account:

```bash
$ npx @nestjs/observe link
```

It installs `@nestjs/observe`, wires it into `AppModule` and `main.ts`, and writes the app key and secret into `.env`, which every `nest start` script (`start`, `start:dev`, `start:debug`) then loads. In production, set `OBSERVE_APP_KEY` and `OBSERVE_APP_SECRET` in the environment instead.

Or do it by hand:

```bash
$ npm install @nestjs/observe
```

Then follow the [setup guide](https://docs.nestjs.com/observability/sdk) - it takes a single import and an app key.

The free plan needs no payment details and covers 300,000 events a month. You can also browse the [live demo](https://www.observe-demo.nestjs.com/dashboard) first - the whole dashboard over a busy service's data, with nothing to install.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Auto-instrument your application with [NestJS Observe](https://observe.nestjs.com). Distributed tracing, metrics, and logging made easy. Error tracking and performance monitoring for your NestJS applications.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
