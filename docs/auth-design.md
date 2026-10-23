# FairSlot – Authentication & Authorization Design

**Version:** 1.1  
**Status:** Approved for Implementation
**Architecture:** Modular Monolith  
**Module:** Authentication & User Management  
**Database:** PostgreSQL 17

---

## 1. Overview

This document defines the authentication, email verification, and authorization architecture for the FairSlot Booking Engine.

The authentication module is responsible for:

- Registering new users.
- Hashing and securely storing passwords.
- Verifying registered email addresses using one-time passcodes (OTP).
- Preventing unverified accounts from signing in.
- Authenticating users with email and password.
- Issuing and verifying JWT access tokens.
- Enforcing role-based access control (RBAC).
- Protecting authentication endpoints against abuse.

The design prioritizes security, correctness, maintainability, and testability.

## 2. Technology Decisions

| Component | Technology |
|---|---|
| Backend | Node.js, TypeScript, Express |
| Database | PostgreSQL 17 |
| Validation | Zod |
| Password Hashing | Argon2id |
| Authentication | JWT Bearer Token |
| JWT Algorithm | HS256 |
| Access Token Lifetime | 15 minutes |
| Email Verification | Numeric OTP |
| OTP Generation | Node.js crypto |
| OTP Protection | HMAC-SHA256 |
| Email Delivery | SMTP / Email Provider |
| Authorization | Role-Based Access Control |
| Architecture | Controller–Service–Repository |

Redis and BullMQ are planned as later enhancements for rate limiting and asynchronous email processing.

The initial implementation must not depend on Redis or BullMQ.

## 3. Authentication Architecture

The authentication module follows this architecture:

```text
Client
  |
  v
Express Routes
  |
  v
Controller
  |
  v
Service
  |
  +-- Password Hashing (Argon2id)
  |
  +-- OTP Generation / Verification
  |
  +-- JWT Signing / Verification
  |
  +-- Email Service
  |
  v
Repository
  |
  v
PostgreSQL
```

Responsibilities:

- **Routes:** Define HTTP endpoints and attach middleware.
- **Controller:** Handle HTTP input and output.
- **Service:** Implement authentication business logic.
- **Repository:** Execute parameterized database queries.
- **Email Service:** Send verification messages through a configurable email provider.
- **Middleware:** Authenticate tokens and authorize access.

Controllers must not contain database queries or password hashing logic.

## 4. Database Design

Authentication uses the existing `users` table and introduces one new table for email verification.

### 4.1 Existing Users Table

Current fields:

| Column | Type |
|---|---|
| id | UUID |
| email | VARCHAR(255) |
| password_hash | TEXT |
| role | VARCHAR(20) |
| created_at | TIMESTAMPTZ |
| updated_at | TIMESTAMPTZ |

New column:

| Column | Type | Default |
|---|---|---|
| email_verified_at | TIMESTAMPTZ | NULL |

Rules:

- `NULL` indicates an unverified email.
- A non-null value records successful verification.
- The timestamp is assigned by the backend using PostgreSQL.
- Only trusted backend operations may update this column.
- A public registration always creates a user with `email_verified_at = NULL`.

Existing accounts, if any, must have an explicit migration policy. They must not be automatically marked verified without justification.

### 4.2 New Email Verification Codes Table

Table name: `email_verification_codes`

| Column | Type | Constraints |
|---|---|---|
| id | UUID | PRIMARY KEY |
| user_id | UUID | NOT NULL, FK → users.id |
| code_hash | TEXT | NOT NULL |
| expires_at | TIMESTAMPTZ | NOT NULL |
| attempts | INTEGER | NOT NULL, DEFAULT 0 |
| consumed_at | TIMESTAMPTZ | NULL |
| revoked_at | TIMESTAMPTZ | NULL |
| created_at | TIMESTAMPTZ | NOT NULL, DEFAULT now() |

Required constraints:

- `attempts >= 0`
- `attempts <= 5`
- `expires_at > created_at`
- `user_id` references an existing user.
- A challenge cannot be both consumed and revoked.
- At most one unconsumed, unrevoked challenge may exist for each user.

The last rule will use a PostgreSQL partial unique index.

An expired code remains stored for auditing until a retention or cleanup policy removes it. When issuing a replacement, the previous pending code must first be revoked.

Foreign key deletion behavior follows the existing restrictive policy.

### 4.3 Database Migration Policy

The previous initial schema migration must not be modified.

A new versioned migration will:

1. Add `users.email_verified_at`.
2. Create `email_verification_codes`.
3. Add the required foreign key and CHECK constraints.
4. Add the partial unique index.
5. Add an index supporting verification-code lookup and cleanup.

This migration belongs to Task 3.2.

Both `docs/erd.md` and `docs/database-design.md` must be updated when the migration is introduced.

## 5. Email Verification Design

### 5.1 OTP Configuration

| Property | Initial Value |
|---|---|
| Format | Numeric |
| Length | 8 digits |
| Expiration | 5 minutes |
| Maximum incorrect attempts | 5 per code |
| Resend cooldown | 60 seconds |
| OTP reuse | Forbidden |
| Multiple active OTPs | Forbidden |
| Secure generation | Cryptographic random generator |

These values are initial MVP configuration choices and may be adjusted based on testing and abuse risk.

### 5.2 OTP Generation

OTP generation must use a cryptographically secure random number generator.

The OTP must:

- Contain exactly eight digits, including leading zeros if generated.
- Be unpredictable.
- Be valid only for its specific verification challenge.
- Never be stored in plaintext.
- Never appear in application logs.
- Never be returned through public API responses.

### 5.3 OTP Storage Security

The system will store an HMAC-SHA256 digest instead of the raw OTP.

The HMAC input must bind the code to its verification context, including:

- User identifier
- Verification challenge identifier
- Verification purpose
- OTP value

The HMAC key must be a strong secret stored separately from the database.

Configuration:

`OTP_HMAC_SECRET`

This secret must not be the same as the JWT signing secret.

Verification must use a timing-safe comparison of equal-length digests.

Plain SHA-256 hashing is not sufficient protection for short numeric OTPs if the database is exposed.

### 5.4 OTP Validation Rules

Verification succeeds only when:

1. The user exists.
2. The email is not already verified.
3. A pending verification challenge exists.
4. The challenge has not expired.
5. The challenge has not been consumed or revoked.
6. The attempt limit has not been exceeded.
7. The submitted OTP matches the stored HMAC.

After successful verification:

- Set `users.email_verified_at`.
- Mark the challenge as consumed.
- Do not issue a JWT automatically.
- Require the user to log in normally.

After an incorrect OTP:

- Increase the failed-attempt counter atomically.
- Reject further attempts once the limit is reached.
- Avoid revealing whether a specific email address exists.

Verification must use PostgreSQL transactions and row locking to prevent a code from being consumed twice.

The expiration check must use the database's current time after obtaining the required locks.

## 6. Authentication API Contract

Base URL:

`/api/v1`

### 6.1 User Registration

**POST /api/v1/auth/register**

Authentication: Public

Request:

```json
{
  "email": "user@example.com",
  "password": "ExampleSecurePass123!"
}
```

Validation:

- Email must be valid and no longer than 255 characters.
- Email is trimmed and normalized to lowercase.
- Password length must be 12–128 characters.
- Password must not be silently trimmed or normalized.
- Unexpected fields, including `role`, are rejected.

Business flow:

1. Validate request data.
2. Normalize email.
3. Hash the password using Argon2id.
4. Begin a database transaction.
5. Insert a user with role `USER`.
6. Create an email verification challenge.
7. Commit the transaction.
8. Attempt to send the verification email.
9. Return the registration result.

The user and initial verification challenge must be committed atomically.

Email must not be sent while holding the database transaction open.

Successful response:

**HTTP 201 Created**

```json
{
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "user@example.com",
    "role": "USER",
    "emailVerified": false,
    "verificationRequired": true,
    "emailDispatchStatus": "accepted"
  }
}
```

`emailDispatchStatus = accepted` means the email provider accepted the sending request, not that delivery to the inbox is guaranteed.

If the provider fails after the database transaction commits, the account remains unverified. The API must not claim the email was sent. The registration response may indicate `temporarily_unavailable`, allowing the user to request another code.

The service must not attempt to undo an already committed registration because email delivery failed.

Expected errors:

| HTTP | Code |
|---|---|
| 400 | VALIDATION_ERROR |
| 409 | EMAIL_ALREADY_EXISTS |
| 429 | RATE_LIMITED |
| 500 | INTERNAL_ERROR |

Returning 409 for an existing email may expose account existence. This is an acknowledged MVP tradeoff that requires rate limiting and further review before public deployment.

Registration does not automatically log the user in.

### 6.2 Verify Email

**POST /api/v1/auth/verify-email**

Authentication: Public

Request:

```json
{
  "email": "user@example.com",
  "code": "12345678"
}
```

The code above is illustrative.

Business flow:

1. Validate and normalize the email.
2. Find the user and current pending verification challenge.
3. Acquire the required database locks.
4. Check verification state, expiration, and attempt count.
5. Compare the submitted code securely.
6. If invalid, increment the attempt counter and commit.
7. If valid, mark the challenge as consumed.
8. Update `users.email_verified_at`.
9. Commit the transaction.
10. Return the verification result.

The verification timestamp and OTP consumption must be committed atomically.

Successful response:

**HTTP 200 OK**

```json
{
  "data": {
    "emailVerified": true,
    "message": "Email verified successfully"
  }
}
```

Expected errors:

| HTTP | Code |
|---|---|
| 400 | VALIDATION_ERROR |
| 400 | INVALID_OR_EXPIRED_CODE |
| 429 | TOO_MANY_ATTEMPTS |
| 429 | RATE_LIMITED |
| 500 | INTERNAL_ERROR |

Incorrect, expired, revoked, and nonexistent challenges should produce a generic verification failure response rather than revealing sensitive account details.

### 6.3 Resend Verification Code

**POST /api/v1/auth/resend-verification**

Authentication: Public

Request:

```json
{
  "email": "user@example.com"
}
```

Business flow:

1. Validate and normalize email.
2. Apply IP-based and account/email-based rate limits.
3. Look up the user.
4. If the user is missing or already verified, return a generic response.
5. Enforce the resend cooldown and total send quotas.
6. Begin a database transaction.
7. Lock the user's verification state.
8. Revoke any previous pending challenge.
9. Create a new OTP challenge.
10. Commit the transaction.
11. Attempt to send the new OTP.

The old OTP must become invalid once the new challenge is committed.

Successful public response:

**HTTP 202 Accepted**

```json
{
  "message": "If verification is required for this email, a new code may be sent."
}
```

The public response must not disclose whether an email is registered.

The HTTP 202 response does not guarantee actual inbox delivery.

Rate limiting and resend cooldown must also prevent an attacker from continually replacing another user's code.

### 6.4 User Login

**POST /api/v1/auth/login**

Authentication: Public

Request:

```json
{
  "email": "user@example.com",
  "password": "ExampleSecurePass123!"
}
```

Business flow:

1. Validate request body.
2. Normalize email.
3. Find user by email.
4. Verify password using Argon2id.
5. Reject invalid credentials.
6. Check `email_verified_at`.
7. Reject login if the email is unverified.
8. Generate a JWT access token.
9. Return token and public user information.

A JWT must never be issued before successful email verification.

Successful response:

**HTTP 200 OK**

```json
{
  "data": {
    "accessToken": "<signed-jwt>",
    "tokenType": "Bearer",
    "expiresIn": 900,
    "user": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "email": "user@example.com",
      "role": "USER",
      "emailVerified": true
    }
  }
}
```

Expected errors:

| HTTP | Code |
|---|---|
| 400 | VALIDATION_ERROR |
| 401 | INVALID_CREDENTIALS |
| 403 | EMAIL_NOT_VERIFIED |
| 429 | RATE_LIMITED |
| 500 | INTERNAL_ERROR |

`EMAIL_NOT_VERIFIED` may only be returned after the correct password has been verified. Unknown emails and incorrect passwords must share the generic `INVALID_CREDENTIALS` response.

### 6.5 Get Current User

**GET /api/v1/users/me**

Authentication: Required

Request header:

`Authorization: Bearer <access_token>`

Successful response:

**HTTP 200 OK**

```json
{
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "user@example.com",
    "role": "USER",
    "emailVerified": true,
    "createdAt": "2026-10-23T08:00:00.000Z"
  }
}
```

The endpoint must not expose the password hash or verification-code data.

If the token is invalid, expired, or the referenced user no longer exists, return HTTP 401.

## 7. Registration and Verification Lifecycle

Account states:

```text
UNREGISTERED
    |
    | Register
    v
PENDING_VERIFICATION
    |
    | Valid OTP
    v
VERIFIED
    |
    | Valid Login Credentials
    v
AUTHENTICATED
```

The states are logical states derived from the database and authentication token. They are not an additional `users.status` column.

### Business Rules

- Registration creates an unverified account.
- Unverified accounts cannot receive JWT access tokens.
- Unverified accounts can request a replacement OTP, subject to limits.
- Verification codes expire after five minutes.
- Each code can be consumed at most once.
- Reissuing a code invalidates the previous challenge.
- Verification does not automatically grant an administrative role.
- Verification does not automatically sign the user in.

## 8. Database Consistency and Concurrency

Email verification introduces concurrency risks.

### 8.1 Concurrent Verification Requests

If two requests submit the same correct OTP simultaneously:

- Both may reach the backend.
- Only one transaction may consume the pending challenge.
- The second request must observe that the challenge has already been consumed.
- The verification timestamp must not be updated inconsistently.

Use a consistent lock order, starting with the user record, followed by the verification challenge.

### 8.2 Concurrent Resend Requests

If two resend requests arrive simultaneously:

- They must not leave two valid pending challenges.
- The newest successfully committed challenge replaces the previous one.
- The resend cooldown and quotas must be checked safely.
- The database partial unique index provides a final safeguard.

### 8.3 Wrong Attempt Counting

Failed OTP attempts must update the database atomically.

Concurrent guesses must not bypass the maximum attempt count.

Use transactions and row locking, or an equivalent conditional update strategy.

### 8.4 Delivery Failure

Email delivery is an external operation and cannot be rolled back with PostgreSQL.

Initial MVP:

- Persist the user and challenge transactionally.
- Send through the email adapter after commit.
- Preserve the unverified account when email sending fails.
- Support controlled resend.
- Record sanitized delivery failures for investigation.

A later reliability enhancement may use a transactional outbox with BullMQ to prevent loss of pending email work during process crashes.

## 9. Password Security

Passwords must use Argon2id.

Initial parameters:

| Parameter | Value |
|---|---|
| Memory | 19 MiB |
| Iterations | 2 |
| Parallelism | 1 |

These values must be reviewed against the actual deployment environment.

Rules:

- Do not store plaintext passwords.
- Do not hash passwords using plain SHA-256.
- Do not include passwords in JWT.
- Do not return password hashes.
- Do not log authentication credentials.
- Use safe verification routines.
- Do not silently modify submitted passwords.

## 10. JWT Design

### 10.1 Access Token

| Property | Value |
|---|---|
| Algorithm | HS256 |
| Lifetime | 15 minutes |
| Issuer | fairslot-api |
| Audience | fairslot-client |
| Subject | User UUID |

Expected claims:

- `sub`
- `iss`
- `aud`
- `iat`
- `exp`

JWTs must not contain passwords, OTPs, or confidential account details.

### 10.2 JWT Verification

The middleware must:

1. Extract the Bearer token.
2. Verify the signature.
3. Enforce HS256 explicitly.
4. Validate issuer and audience.
5. Validate expiration.
6. Validate the subject UUID.
7. Query PostgreSQL for the current user.
8. Verify account eligibility.
9. Attach authenticated user context to the request.

User roles must come from current database values rather than relying solely on an old token claim.

### 10.3 Required Configuration

- `JWT_SECRET`
- `JWT_ACCESS_EXPIRES_IN`
- `OTP_HMAC_SECRET`
- Email provider configuration

Secrets must be cryptographically strong, stored outside source control, and never logged.

Refresh tokens and immediate JWT revocation are outside the initial scope.

## 11. Role-Based Access Control

### User Roles

| Role | Permissions |
|---|---|
| USER | Manage own reservations and profile |
| ORGANIZER | USER permissions plus manage owned events |
| ADMIN | Explicit administrative operations |

Rules:

1. Public registration always assigns `USER`.
2. Clients cannot self-assign elevated roles.
3. Role validation is performed server-side.
4. Resource ownership checks are required in addition to role checks.
5. Current role data is retrieved from PostgreSQL.
6. ADMIN and ORGANIZER provisioning requires a trusted process.

Email verification does not change the user's role.

## 12. Rate Limiting and Abuse Prevention

Authentication and email verification are abuse-sensitive endpoints.

The following controls are required before public deployment:

- Login rate limiting.
- Registration rate limiting.
- OTP request rate limiting.
- Resend cooldown.
- Per-email and per-IP quotas.
- Maximum OTP verification attempts.
- Monitoring for unusual sending or failure patterns.
- Generic responses for account-sensitive public endpoints.

The five-attempt limit is stored durably in PostgreSQL.

Additional request and resend quotas may later use Redis.

Resending an OTP must not allow unlimited resets of the attempt budget. A separate quota across challenges is required.

The system must avoid storing sensitive OTP values or credentials in logs.

## 13. Error Response Contract

All authentication errors use a consistent structure.

Example:

```json
{
  "error": {
    "code": "INVALID_CREDENTIALS",
    "message": "Invalid email or password"
  }
}
```

HTTP status mapping:

| Status | Meaning |
|---|---|
| 200 | Successful request |
| 201 | Account created |
| 202 | Resend request accepted |
| 400 | Invalid request or verification code |
| 401 | Missing or invalid authentication |
| 403 | Authenticated or credential-verified but ineligible |
| 409 | Resource conflict |
| 429 | Rate limit exceeded |
| 500 | Unexpected server failure |

Never expose SQL statements, provider credentials, OTP values, secret keys, or stack traces in public responses.

## 14. Proposed Source Code Structure

```text
src/
├── config/
│   └── env.ts
├── database/
│   └── pool.ts
├── middlewares/
│   ├── auth.middleware.ts
│   └── role.middleware.ts
├── modules/
│   ├── auth/
│   │   ├── auth.routes.ts
│   │   ├── auth.controller.ts
│   │   ├── auth.service.ts
│   │   ├── auth.repository.ts
│   │   └── auth.schemas.ts
│   ├── email-verification/
│   │   ├── verification.routes.ts
│   │   ├── verification.controller.ts
│   │   ├── verification.service.ts
│   │   └── verification.repository.ts
│   └── users/
│       ├── user.routes.ts
│       ├── user.controller.ts
│       └── user.repository.ts
├── services/
│   └── email.service.ts
├── app.ts
└── server.ts
```

The directory structure is a proposed implementation layout. Only the required files should be created during their corresponding tasks.

Shared logic such as password hashing, JWT signing, and OTP cryptography may use small dedicated utility modules.

Avoid excessive abstraction before concrete needs appear.

## 15. Testing Strategy

### 15.1 Registration Tests

| ID | Scenario |
|---|---|
| AUTH-01 | Register with valid data |
| AUTH-02 | Reject invalid email |
| AUTH-03 | Reject weak or short password |
| AUTH-04 | Reject duplicate normalized email |
| AUTH-05 | Reject client-supplied privileged role |
| AUTH-06 | Verify password stored as Argon2id hash |
| AUTH-07 | Verify new user is unverified |
| AUTH-08 | Verify OTP challenge is created |
| AUTH-09 | Verify database rollback on challenge creation failure |
| AUTH-10 | Verify concurrent duplicate registration cannot create multiple users |

### 15.2 Email Verification Tests

| ID | Scenario |
|---|---|
| AUTH-11 | Correct OTP verifies email |
| AUTH-12 | Incorrect OTP is rejected |
| AUTH-13 | Expired OTP is rejected |
| AUTH-14 | Used OTP cannot be reused |
| AUTH-15 | Five failed attempts exhaust challenge |
| AUTH-16 | Resend invalidates previous OTP |
| AUTH-17 | Resend cooldown is enforced |
| AUTH-18 | Unknown email receives generic resend response |
| AUTH-19 | Concurrent verification cannot consume OTP twice |
| AUTH-20 | Concurrent resend cannot produce multiple pending challenges |
| AUTH-21 | Provider failure leaves account unverified and recoverable |
| AUTH-22 | OTP is never stored or logged in plaintext |

### 15.3 Login Tests

| ID | Scenario |
|---|---|
| AUTH-23 | Valid verified user can log in |
| AUTH-24 | Invalid password is rejected |
| AUTH-25 | Unknown email returns generic error |
| AUTH-26 | Unverified user cannot receive JWT |
| AUTH-27 | JWT contains correct required claims |
| AUTH-28 | Login rate limiting is enforced |

### 15.4 Authentication and Authorization Tests

| ID | Scenario |
|---|---|
| AUTH-29 | Missing token is rejected |
| AUTH-30 | Invalid JWT signature is rejected |
| AUTH-31 | Expired JWT is rejected |
| AUTH-32 | Invalid issuer or audience is rejected |
| AUTH-33 | Valid JWT returns current user |
| AUTH-34 | USER cannot access ORGANIZER-only route |
| AUTH-35 | ORGANIZER can access permitted route |
| AUTH-36 | Changed database role affects authorization |
| AUTH-37 | Private resource ownership is enforced |

Tests requiring the event module will be implemented once those routes exist.

Integration tests must use an isolated PostgreSQL test database.

Real OTP values should be captured through a controlled test email adapter, not by exposing OTPs in production API responses.

## 16. Implementation Roadmap

### Task 3.1 – Authentication Design

- Finalize authentication API contracts.
- Finalize JWT design.
- Finalize email verification requirements.
- Review database changes.
- Define security and testing requirements.

### Task 3.2 – User Registration

- Add the new database migration.
- Implement registration validation.
- Implement password hashing.
- Persist unverified users and verification challenges.
- Integrate an initial email service adapter.

### Task 3.3 – Email Verification

- Implement OTP verification.
- Implement resend verification.
- Handle expiration and failed attempts.
- Implement concurrency protection.
- Add verification tests.

### Task 3.4 – Login and JWT

- Implement user login.
- Reject unverified accounts.
- Generate access tokens.
- Validate JWT claims.

### Task 3.5 – Authentication Middleware and RBAC

- Implement authentication middleware.
- Implement role authorization.
- Implement `/users/me`.
- Add ownership protection as related modules are built.

### Task 3.6 – Integration Testing

- Verify registration, OTP, login and middleware workflows.
- Test concurrency and failure cases.
- Review error handling and security.
- Prepare API documentation.

### Future Enhancement – Reliable Email Processing

- Redis-backed rate limiting.
- BullMQ background email delivery.
- Retry policies.
- Transactional outbox.
- Delivery monitoring and operational metrics.

## 17. Scope and Limitations

### In Scope

- User registration
- Email verification using OTP
- OTP resend
- Login with email and password
- JWT access token
- Current user profile
- Role-based authorization
- Database-backed verification state
- Automated tests

### Out of Scope

- Google/GitHub OAuth
- Password reset
- Multi-factor authentication
- Refresh tokens
- Immediate JWT revocation
- Email address changes
- Mobile phone verification
- Payment processing
- Distributed email infrastructure

Email verification is not considered multi-factor authentication.

## 18. Acceptance Criteria

Task 3.1 is complete when:

1. Registration and login contracts are documented.
2. Email verification and resend contracts are documented.
3. OTP expiration, attempts, and resend behavior are defined.
4. Password hashing and JWT security rules are established.
5. Database migration requirements are specified.
6. Concurrency and failure-handling rules are documented.
7. RBAC permissions are defined.
8. Test scenarios are documented.
9. Existing schema migrations remain unchanged.
10. The design is approved before implementation.

---

## Related Documents

- [Database Design](./database-design.md)
- [Database ERD](./erd.md)

**Design principle:** Prioritize security, consistency, and correctness before introducing Redis, BullMQ, or other infrastructure components.