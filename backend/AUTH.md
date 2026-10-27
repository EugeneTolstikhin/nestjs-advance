# Authentication and product permissions

From `backend/`, set a random JWT secret and start the application:

```sh
export JWT_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
npm run start:dev
```

The application requires `JWT_SECRET` to contain at least 32 characters. Keep it
private and use the same secret across restarts if existing tokens should remain
valid. Generating a different secret invalidates those tokens.

## Get a token

Send `POST http://localhost:3000/auth/register` with JSON:

```json
{
  "user": {
    "username": "seller@example.com",
    "password": "Password1!",
    "confirmPassword": "Password1!",
    "firstName": "Test",
    "lastName": "Seller",
    "dob": "2000-01-01",
    "nationality": "Germany",
    "typeOfUser": "seller"
  }
}
```

Use `"buyer"` for buyer registration. Public registration rejects admin roles.
Registration returns `access_token`, `token_type`, `expires_in` and basic user
details. Passwords are hashed with bcrypt; password hashes are not returned.

To log in again, send `POST /auth/login`:

```json
{
  "user": {
    "username": "seller@example.com",
    "password": "Password1!"
  }
}
```

The role in the JWT comes from the stored user. Login does not accept a role.
Tokens expire after 15 minutes.

## Use the token in Posting

Add a header named `Authorization`, with value `Bearer <access_token>`.

| Operation | Access |
| --- | --- |
| GET `/products` and `/products/:id` | Public |
| POST `/products` | Seller |
| PUT, PATCH, DELETE `/products/:id` | Seller |

The token middleware checks the Bearer header format on product write requests
and attaches `request.accessToken`. The guard verifies the JWT signature, expiry,
issuer and audience, attaches verified claims to `request.user`, then checks
the route's `@Roles(TypeOfUser.Seller)` metadata. It returns 401 for invalid or
missing credentials and 403 for a valid token with an unauthorized role.

For future buyer-only routes, use both decorators:

```ts
@UseGuards(AuthGuard)
@Roles(TypeOfUser.Buyer)
```

Users are stored in memory and disappear on restart. Phone authentication routes
are still placeholders and do not issue tokens. Sellers can manage all products;
per-product ownership is not implemented.

## Verification

```sh
npm run test:auth       # Build, in-process checks, and HTTP integration tests
npm run test:auth:unit  # Build and in-process checks only
```
