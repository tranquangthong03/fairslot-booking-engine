
# FairSlot – Database Design Specification

**Version:** 1.0  
**Database:** PostgreSQL 17  
**Architecture:** Modular Monolith  
**Status:** Approved for Migration  
**Scope:** MVP Booking Engine

---

## 1. Purpose

FairSlot is a high-concurrency event booking engine.

The system must support concurrent reservation requests
without exceeding ticket capacity or creating duplicate
active reservations.

The database design focuses on:

1. Data consistency
2. Referential integrity
3. Transactional inventory management
4. Concurrency control
5. Idempotent booking operations
6. Reservation lifecycle management
7. Reliable expiration processing

PostgreSQL is the authoritative source of truth.

Redis and background workers may be introduced later,
but they must not replace database consistency guarantees.

## 2. Database Overview

The initial schema contains four tables:

| Table | Responsibility |
|---|---|
| users | Stores accounts and roles |
| events | Stores events managed by organizers |
| ticket_types | Defines ticket categories and inventory |
| reservations | Records the booking lifecycle |

Entity relationships:

- users (1) -> events (N)
- users (1) -> reservations (N)
- events (1) -> ticket_types (N)
- ticket_types (1) -> reservations (N)

See [Entity Relationship Diagram](./erd.md).

## 3. Table Specifications

### 3.1 users

Stores registered user accounts.

| Column | Data Type | Constraints |
|---|---|---|
| id | UUID | PK, DEFAULT gen_random_uuid() |
| email | VARCHAR(255) | NOT NULL, UNIQUE |
| password_hash | TEXT | NOT NULL |
| role | VARCHAR(20) | NOT NULL, DEFAULT 'USER' |
| created_at | TIMESTAMPTZ | NOT NULL, DEFAULT now() |
| updated_at | TIMESTAMPTZ | NOT NULL, DEFAULT now() |

Allowed roles:

- USER
- ORGANIZER
- ADMIN

Business rules:

1. Every user must have a unique email.
2. Email must be trimmed and converted to lowercase.
3. Passwords must be stored as secure password hashes.
4. The default role is USER.
5. Users cannot assign privileged roles to themselves.
6. Only ORGANIZER or ADMIN may create events.
7. Users referenced by reservations or events cannot
   be hard-deleted in the MVP.

Database constraints:

- PRIMARY KEY (id)
- UNIQUE (email)
- CHECK role IN ('USER', 'ORGANIZER', 'ADMIN')
- CHECK normalized email is non-empty and lowercase

Role authorization is enforced by the application.

### 3.2 events

Stores events created by organizers.

| Column | Data Type | Constraints |
|---|---|---|
| id | UUID | PK, DEFAULT gen_random_uuid() |
| organizer_id | UUID | NOT NULL, FK |
| title | VARCHAR(255) | NOT NULL |
| description | TEXT | NULLABLE |
| status | VARCHAR(20) | NOT NULL, DEFAULT 'DRAFT' |
| starts_at | TIMESTAMPTZ | NOT NULL |
| ends_at | TIMESTAMPTZ | NOT NULL |
| created_at | TIMESTAMPTZ | NOT NULL, DEFAULT now() |
| updated_at | TIMESTAMPTZ | NOT NULL, DEFAULT now() |

Foreign key:

`organizer_id REFERENCES users(id) ON DELETE RESTRICT`

Allowed statuses:

- DRAFT
- PUBLISHED
- CANCELLED

Business rules:

1. Every event belongs to one organizer.
2. Event title must not be blank.
3. ends_at must be later than starts_at.
4. New reservations require PUBLISHED status.
5. New reservations are rejected after starts_at.
6. CANCELLED events cannot receive new reservations.
7. A valid existing hold may be confirmed until its
   expiration time, even if the event has just started.
8. Confirmation is rejected if the event is CANCELLED.
9. In the MVP, event cancellation is only allowed when
   no HELD or CONFIRMED reservations remain.
10. Event schedule changes are restricted after
    publication to avoid invalidating existing holds.

Database constraints:

- PRIMARY KEY (id)
- FOREIGN KEY (organizer_id)
- CHECK (ends_at > starts_at)
- CHECK status IN ('DRAFT', 'PUBLISHED', 'CANCELLED')
- CHECK title is non-empty after trimming

Application rules involving current time, user role,
or other tables must be enforced transactionally.

### 3.3 ticket_types

Defines ticket categories and maintains inventory.

| Column | Data Type | Constraints |
|---|---|---|
| id | UUID | PK, DEFAULT gen_random_uuid() |
| event_id | UUID | NOT NULL, FK |
| name | VARCHAR(100) | NOT NULL |
| capacity | INTEGER | NOT NULL |
| held_count | INTEGER | NOT NULL, DEFAULT 0 |
| confirmed_count | INTEGER | NOT NULL, DEFAULT 0 |
| created_at | TIMESTAMPTZ | NOT NULL, DEFAULT now() |
| updated_at | TIMESTAMPTZ | NOT NULL, DEFAULT now() |

Foreign key:

`event_id REFERENCES events(id) ON DELETE RESTRICT`

Column meanings:

- capacity: Maximum number of tickets.
- held_count: Number of reservations in HELD status.
- confirmed_count: Number of confirmed reservations.

Required constraints:

- capacity > 0
- held_count >= 0
- confirmed_count >= 0
- held_count + confirmed_count <= capacity
- name must not be blank

Ticket type names must be unique within the same event,
ignoring case and leading/trailing whitespace.

A unique expression index on:

`(event_id, lower(btrim(name)))`

will enforce this rule.

Business rules:

1. Every ticket type belongs to one event.
2. Capacity must be positive.
3. Each reservation consumes exactly one ticket.
4. Inventory counters cannot be negative.
5. Used capacity cannot exceed total capacity.
6. Inventory counters must change atomically with
   reservation state changes.
7. Capacity changes are only allowed while the
   event is DRAFT in the MVP.

Available inventory:

`available = capacity - held_count - confirmed_count`

Inventory counters are authoritative for capacity
allocation, but their consistency with reservation
records must be verified.

### 3.4 reservations

Stores reservation ownership, status and expiration.

| Column | Data Type | Constraints |
|---|---|---|
| id | UUID | PK, DEFAULT gen_random_uuid() |
| user_id | UUID | NOT NULL, FK |
| ticket_type_id | UUID | NOT NULL, FK |
| status | VARCHAR(20) | NOT NULL, DEFAULT 'HELD' |
| idempotency_key | VARCHAR(128) | NOT NULL |
| expires_at | TIMESTAMPTZ | NOT NULL |
| confirmed_at | TIMESTAMPTZ | NULLABLE |
| created_at | TIMESTAMPTZ | NOT NULL, DEFAULT now() |
| updated_at | TIMESTAMPTZ | NOT NULL, DEFAULT now() |

Foreign keys:

`user_id REFERENCES users(id) ON DELETE RESTRICT`

`ticket_type_id REFERENCES ticket_types(id) ON DELETE RESTRICT`

Allowed statuses:

- HELD
- CONFIRMED
- EXPIRED
- CANCELLED

Business rules:

1. Each reservation belongs to one user.
2. Each reservation references one ticket type.
3. Each reservation represents exactly one ticket.
4. Newly created reservations start in HELD status.
5. The default holding duration is five minutes.
6. Only unexpired HELD reservations can be confirmed.
7. EXPIRED and CANCELLED reservations do not consume
   ticket capacity after their transitions commit.
8. CONFIRMED reservations consume one ticket.
9. CONFIRMED, EXPIRED and CANCELLED are terminal
   states in the MVP.
10. A user cannot hold or confirm more than one
    active reservation for the same ticket type.

Database constraints:

- PRIMARY KEY (id)
- FOREIGN KEY (user_id)
- FOREIGN KEY (ticket_type_id)
- UNIQUE (user_id, idempotency_key)
- CHECK (expires_at > created_at)
- CHECK status belongs to the allowed values
- CHECK confirmed_at is present exactly when
  status = 'CONFIRMED'

The expiration time is assigned by the backend
using PostgreSQL's database clock during reservation
creation.

confirmed_at remains NULL until confirmation.

The original expires_at value is retained after
confirmation for auditing and verification.

## 4. Reservation Lifecycle

Allowed transitions:

| From | To | Condition |
|---|---|---|
| NEW | HELD | Available capacity exists |
| HELD | CONFIRMED | Hold has not expired |
| HELD | EXPIRED | Expiration deadline has passed |
| HELD | CANCELLED | User cancels the hold |

Terminal states:

- CONFIRMED
- EXPIRED
- CANCELLED

No other transitions are allowed in the MVP.

State transitions cannot be guaranteed by a simple
CHECK constraint because CHECK only validates the
current row, not the previous state.

The application must enforce valid transitions
using conditional updates and transactions.

## 5. Inventory Invariants

The system must preserve the following properties.

### INV-01: Capacity Limit

`held_count + confirmed_count <= capacity`

### INV-02: Non-negative Counters

`held_count >= 0`

`confirmed_count >= 0`

### INV-03: Reservation Consistency

For each ticket type:

`held_count = COUNT(reservations WHERE status = 'HELD')`

`confirmed_count = COUNT(reservations WHERE status = 'CONFIRMED')`

These counts include all committed reservations with
the corresponding status.

A HELD row remains counted even if expires_at has
passed, until the expiration transition commits.

Cross-table count consistency is not enforceable
through an ordinary row-level CHECK constraint.

Booking services must maintain it transactionally,
and verification jobs must check for inconsistencies.

### INV-04: Atomic Operations

The reservation record and ticket inventory must
be modified within the same database transaction.

If any operation fails, all changes must roll back.

### INV-05: No Duplicate Active Reservations

For each (user_id, ticket_type_id), at most one
reservation may have status HELD or CONFIRMED.

### INV-06: Valid Confirmation

A reservation can only be confirmed if:

- status = HELD
- the database clock is before expires_at
- the event has not been CANCELLED

The expiration check must occur while processing
the locked reservation inside the transaction.

## 6. Concurrency Control

### 6.1 Problem

Example:

- Ticket capacity: 100
- Concurrent booking attempts: 1,000

The system must never allocate more than 100 tickets.

### 6.2 Strategy

Use PostgreSQL transactions and conditional updates.

Booking workflow:

1. Begin a database transaction.
2. Validate event eligibility.
3. Atomically claim one available ticket using
   a conditional UPDATE on ticket_types.
4. Create a HELD reservation.
5. Commit the transaction.
6. Return the reservation result.

If no ticket is available, return a controlled
sold-out response without creating a reservation.

If inserting the reservation fails, roll back
the capacity update.

### 6.3 Conditional Inventory Update

The reservation service will use the equivalent of:

```sql
UPDATE ticket_types
SET
    held_count = held_count + 1,
    updated_at = NOW()
WHERE id = $1
  AND held_count + confirmed_count < capacity
RETURNING id;
```

This operation provides a concurrency-safe
capacity check and increment on the inventory row.

The reservation INSERT must use the same transaction
and database client.

### 6.4 Lock Ordering

Transactions that modify both inventory and
reservations must follow a consistent lock order.

The intended order is:

1. Event row, when event state must be protected
2. Ticket type row
3. Reservation row

Existing reservation identifiers may be read first
without locking to locate their ticket type.

After acquiring the required locks, the transaction
must recheck current state and eligibility.

This reduces deadlock risk, although the application
must still handle database deadlock and retry errors.

Transactions must remain short.

## 7. Idempotency Design

Booking requests use an idempotency key.

Required uniqueness:

`UNIQUE (user_id, idempotency_key)`

Expected behavior:

1. A new key creates at most one committed reservation.
2. Retrying an already committed request with the same
   user, key and ticket type returns the existing
   reservation's current state.
3. Reusing the same key for another ticket type returns
   HTTP 409 Conflict.
4. A new booking attempt after expiration or cancellation
   requires a new idempotency key.
5. Concurrent duplicate requests must not create
   multiple reservations.

The database UNIQUE constraint is the final safeguard.

This MVP guarantees idempotency for successfully
committed reservation records.

It does not persist and replay every failed API
response. Full HTTP request/response idempotency
may require a separate request ledger in the future.

## 8. Duplicate Reservation Prevention

A partial unique index is required:

```sql
CREATE UNIQUE INDEX uq_reservations_active_user_ticket
ON reservations (user_id, ticket_type_id)
WHERE status IN ('HELD', 'CONFIRMED');
```

This prevents a user from having multiple active
reservations for the same ticket type.

Important:

PostgreSQL partial indexes do not automatically
consider expires_at.

A HELD reservation whose time has passed still
occupies this unique slot until its status changes.

Expiration processing must transition it to EXPIRED
before another active reservation can be created.

## 9. Reservation Expiration

The default holding period is five minutes.

Expiration workflow:

1. Identify a HELD reservation whose expiration
   deadline has passed.
2. Begin a database transaction.
3. Lock and revalidate the relevant records.
4. Transition HELD to EXPIRED only if it is
   still HELD and actually expired.
5. Decrement held_count exactly once.
6. Commit the transaction.

If the reservation has already changed state,
the expiration attempt must not decrement inventory.

Expiration must be idempotent.

### Worker Failure Recovery

A background job may fail, be delayed, or run twice.

The system must not rely exclusively on job delivery.

A periodic recovery scan will identify expired HELD
reservations and process them safely.

In the MVP, capacity is not released merely because
the expiration timestamp has passed.

Capacity is released when the expiration transaction
commits.

This prioritizes consistency over immediate
capacity availability.

## 10. Inventory State Transitions

| Operation | held_count | confirmed_count |
|---|---|---|
| Create HELD | +1 | 0 |
| HELD -> CONFIRMED | -1 | +1 |
| HELD -> EXPIRED | -1 | 0 |
| HELD -> CANCELLED | -1 | 0 |
| Duplicate completed transition | 0 | 0 |

All counter adjustments and status updates must
occur atomically.

The system must never decrement inventory twice
for the same state transition.

## 11. Database Index Strategy

The following indexes are planned.

### users

- Unique index on email, provided by UNIQUE(email).

### events

- Index on organizer_id.

### ticket_types

- Index on event_id.
- Unique expression index on
  (event_id, lower(btrim(name))).

### reservations

- Unique constraint on (user_id, idempotency_key).
- Partial unique index on
  (user_id, ticket_type_id) for HELD and CONFIRMED.
- Index on (user_id, created_at DESC) for user history.
- Index on (ticket_type_id, status) for reconciliation.
- Partial index on (expires_at) WHERE status = 'HELD'
  for expiration processing.

Index effectiveness must be measured later
using EXPLAIN ANALYZE and realistic test data.

## 12. Referential Integrity

All primary keys use UUID.

All relationship foreign keys are NOT NULL.

Foreign key deletion behavior:

- events.organizer_id: RESTRICT
- ticket_types.event_id: RESTRICT
- reservations.user_id: RESTRICT
- reservations.ticket_type_id: RESTRICT

Hard deletion of referenced records is not supported
in the MVP.

This protects reservation history.

## 13. Timestamp Policy

- Store timestamps using TIMESTAMPTZ.
- Use PostgreSQL timestamps for database-generated values.
- Use UTC for API serialization and external communication.
- created_at is immutable after creation.
- updated_at changes when a row is modified.
- confirmed_at is assigned only upon confirmation.
- expires_at is fixed when the hold is created.

The MVP assigns updated_at explicitly in write
operations. A database trigger is not required yet.

Expiration checks should use the database's actual
current time while holding the required row locks,
rather than relying on a transaction-start timestamp
that may be stale after waiting for locks.

## 14. Verification Requirements

Task 2.4 must verify the following cases.

| ID | Scenario | Expected Result |
|---|---|---|
| DB-01 | Duplicate email | Rejected |
| DB-02 | Invalid user role | Rejected |
| DB-03 | Event ends before start | Rejected |
| DB-04 | Invalid event status | Rejected |
| DB-05 | Ticket capacity is zero | Rejected |
| DB-06 | Negative held_count | Rejected |
| DB-07 | Negative confirmed_count | Rejected |
| DB-08 | Counters exceed capacity | Rejected |
| DB-09 | Invalid reservation status | Rejected |
| DB-10 | Invalid foreign key | Rejected |
| DB-11 | Duplicate idempotency key for user | Rejected |
| DB-12 | Duplicate active reservation | Rejected |
| DB-13 | Different-case duplicate ticket name | Rejected |
| DB-14 | Invalid confirmed_at/status combination | Rejected |
| DB-15 | Expiration before creation | Rejected |

Later booking integration tests must also verify:

- Concurrent booking requests never oversell.
- Reservation confirmation changes counters once.
- Reservation expiration releases inventory once.
- Duplicate request retries do not create new bookings.
- Confirmation and expiration racing cannot both succeed.
- Failed transactions leave inventory unchanged.
- Inventory counters match reservation status counts.
- Worker restarts do not permanently lose expiration work.

These integration behaviors are not guaranteed by
schema constraints alone.

## 15. Out of Scope

The initial MVP does not include:

- Real payment processing
- Refund processing
- Multiple-seat reservations
- Distributed waiting rooms
- Dynamic ticket pricing
- Payment transaction entities
- External notification services
- Microservices

Additional tables or technologies should only
be introduced when justified by new requirements.

## 16. Final Design Decisions

| Area | Decision |
|---|---|
| Database | PostgreSQL 17 |
| Primary Keys | UUID |
| Timestamp Type | TIMESTAMPTZ |
| Status Representation | VARCHAR + CHECK |
| Architecture | Modular Monolith |
| Inventory Strategy | Stored counters |
| Concurrency | Transaction + conditional UPDATE |
| Idempotency | User-scoped idempotency key |
| Duplicate Prevention | Partial unique index |
| Expiration | Transactional worker + recovery scan |
| Referential Integrity | Foreign keys + RESTRICT |
| Migration | Versioned raw SQL |
| ORM | Not used in MVP |

## 17. Next Steps

### Task 2.3 – PostgreSQL Migration

- Create versioned migration files.
- Create tables and relationships.
- Apply CHECK and UNIQUE constraints.
- Create required indexes.
- Run migrations against PostgreSQL.

### Task 2.4 – Database Verification

- Verify constraints.
- Test invalid data.
- Verify indexes.
- Document results.

### Future Booking Engine Tasks

- Implement transactional booking services.
- Add concurrent reservation tests.
- Integrate Redis and background workers.
- Implement expiration recovery.
- Perform load testing with k6.
