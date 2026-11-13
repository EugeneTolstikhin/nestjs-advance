# nestjs-advance

Personal project for learning NestJS.

- `backend/`: NestJS shop API, Handlebars UI and background workers.
- `payment-simulator/`: independent local payment provider API, UI and SQLite ledger.
- `frontend/`: planned frontend application (to be added later).

## Node.js version

Use the repository-pinned Node.js version before installing dependencies or
starting either application:

```sh
nvm install
nvm use
```

Run `nvm use` in each terminal. The backend uses native SQLite bindings compiled
for that Node version; switching to a different Node major requires rebuilding
native dependencies under that version.

## Backend

Run these commands from the repository root:

```sh
npm --prefix backend ci
npm --prefix backend run start:dev
```

Build the backend:

```sh
npm --prefix backend run build
```

## Payment simulator

Run it independently in another terminal:

```sh
npm --prefix payment-simulator ci
npm --prefix payment-simulator run start:dev
```

Configure matching `PAYMENT_SIMULATOR_SECRET` values in the two applications.
See [provider setup](payment-simulator/README.md) and the
[shop payment flow](backend/PAYMENTS.md). The simulator uses no real money and has
its own dependencies, build, environment and database.
