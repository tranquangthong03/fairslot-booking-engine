
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Pool, type PoolClient } from "pg";
import { env } from "../src/config/env.js";

// Never run constraint tests against the main database.
if (env.DB_NAME !== "fairslot_test") {
    throw new Error(
        "Database tests must use fairslot_test"
    );
}

const pool = new Pool({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
});

after(async () => {
    await pool.end();
});

type Fixture = {
    organizerId: string;
    userId: string;
    userEmail: string;
    eventId: string;
    ticketId: string;
};

// Create valid test data inside a transaction.
// Every test rolls back its changes.
async function withFixture(
    callback: (
        db: PoolClient,
        fixture: Fixture
    ) => Promise<void>
): Promise<void> {
    const db = await pool.connect();

    try {
        await db.query("BEGIN");

        const organizer = await db.query<{ id: string }>(
            `INSERT INTO users (email, password_hash, role)
       VALUES ($1, 'test-hash', 'ORGANIZER')
       RETURNING id`,
            [`organizer-${randomUUID()}@example.test`]
        );

        const userEmail =
            `user-${randomUUID()}@example.test`;

        const user = await db.query<{ id: string }>(
            `INSERT INTO users (email, password_hash)
       VALUES ($1, 'test-hash')
       RETURNING id`,
            [userEmail]
        );

        const organizerId = organizer.rows[0].id;
        const userId = user.rows[0].id;

        const event = await db.query<{ id: string }>(
            `INSERT INTO events (
         organizer_id, title, starts_at, ends_at
       )
       VALUES (
         $1, 'Test Event',
         NOW() + INTERVAL '7 days',
         NOW() + INTERVAL '8 days'
       )
       RETURNING id`,
            [organizerId]
        );

        const eventId = event.rows[0].id;

        const ticket = await db.query<{ id: string }>(
            `INSERT INTO ticket_types (
         event_id, name, capacity
       )
       VALUES ($1, 'Standard', 2)
       RETURNING id`,
            [eventId]
        );

        await callback(db, {
            organizerId,
            userId,
            userEmail,
            eventId,
            ticketId: ticket.rows[0].id,
        });
    } finally {
        try {
            await db.query("ROLLBACK");
        } finally {
            db.release();
        }
    }
}

async function expectDbError(
    operation: Promise<unknown>,
    code: string,
    constraint?: string
): Promise<void> {
    await assert.rejects(operation, (error: unknown) => {
        if (typeof error !== "object" || error === null) {
            return false;
        }

        const dbError = error as {
            code?: string;
            constraint?: string;
        };

        return (
            dbError.code === code &&
            (!constraint || dbError.constraint === constraint)
        );
    });
}

// ---------- USERS ----------

test("DB-01: duplicate email is rejected", async () => {
    await withFixture(async (db, f) => {
        await expectDbError(
            db.query(
                `INSERT INTO users (email, password_hash)
         VALUES ($1, 'test-hash')`,
                [f.userEmail]
            ),
            "23505",
            "uq_users_email"
        );
    });
});

test("DB-02: invalid user role is rejected", async () => {
    await withFixture(async (db) => {
        await expectDbError(
            db.query(
                `INSERT INTO users (
           email, password_hash, role
         )
         VALUES ($1, 'test-hash', 'SUPERUSER')`,
                [`invalid-${randomUUID()}@example.test`]
            ),
            "23514",
            "chk_users_role"
        );
    });
});

test("DB-03: non-normalized email is rejected", async () => {
    await withFixture(async (db) => {
        await expectDbError(
            db.query(
                `INSERT INTO users (email, password_hash)
         VALUES ('UpperCase@example.test', 'test-hash')`
            ),
            "23514",
            "chk_users_email_normalized"
        );
    });
});

// ---------- EVENTS ----------

test("DB-04: invalid event dates are rejected", async () => {
    await withFixture(async (db, f) => {
        await expectDbError(
            db.query(
                `INSERT INTO events (
           organizer_id, title, starts_at, ends_at
         )
         VALUES (
           $1, 'Invalid Event',
           NOW() + INTERVAL '8 days',
           NOW() + INTERVAL '7 days'
         )`,
                [f.organizerId]
            ),
            "23514",
            "chk_events_time"
        );
    });
});

test("DB-05: nonexistent organizer is rejected", async () => {
    await withFixture(async (db) => {
        await expectDbError(
            db.query(
                `INSERT INTO events (
           organizer_id, title, starts_at, ends_at
         )
         VALUES (
           $1, 'Invalid Event',
           NOW() + INTERVAL '7 days',
           NOW() + INTERVAL '8 days'
         )`,
                [randomUUID()]
            ),
            "23503"
        );
    });
});

// ---------- TICKET TYPES ----------

test("DB-06: zero capacity is rejected", async () => {
    await withFixture(async (db, f) => {
        await expectDbError(
            db.query(
                `INSERT INTO ticket_types (
           event_id, name, capacity
         )
         VALUES ($1, 'VIP', 0)`,
                [f.eventId]
            ),
            "23514",
            "chk_ticket_types_capacity"
        );
    });
});

test("DB-07: negative held count is rejected", async () => {
    await withFixture(async (db, f) => {
        await expectDbError(
            db.query(
                `UPDATE ticket_types
         SET held_count = -1
         WHERE id = $1`,
                [f.ticketId]
            ),
            "23514",
            "chk_ticket_types_held"
        );
    });
});

test("DB-08: negative confirmed count is rejected", async () => {
    await withFixture(async (db, f) => {
        await expectDbError(
            db.query(
                `UPDATE ticket_types
         SET confirmed_count = -1
         WHERE id = $1`,
                [f.ticketId]
            ),
            "23514",
            "chk_ticket_types_confirmed"
        );
    });
});

test("DB-09: capacity overflow is rejected", async () => {
    await withFixture(async (db, f) => {
        await expectDbError(
            db.query(
                `UPDATE ticket_types
         SET held_count = 3
         WHERE id = $1`,
                [f.ticketId]
            ),
            "23514",
            "chk_ticket_types_inventory"
        );
    });
});

test("DB-10: duplicate ticket name is rejected", async () => {
    await withFixture(async (db, f) => {
        await expectDbError(
            db.query(
                `INSERT INTO ticket_types (
           event_id, name, capacity
         )
         VALUES ($1, ' standard ', 2)`,
                [f.eventId]
            ),
            "23505",
            "uq_ticket_types_event_name"
        );
    });
});

// ---------- RESERVATIONS ----------

test("DB-11: invalid reservation status is rejected", async () => {
    await withFixture(async (db, f) => {
        await expectDbError(
            db.query(
                `INSERT INTO reservations (
           user_id, ticket_type_id,
           status, idempotency_key, expires_at
         )
         VALUES (
           $1, $2, 'INVALID', 'key-11',
           NOW() + INTERVAL '5 minutes'
         )`,
                [f.userId, f.ticketId]
            ),
            "23514",
            "chk_reservations_status"
        );
    });
});

test("DB-12: invalid expiration is rejected", async () => {
    await withFixture(async (db, f) => {
        await expectDbError(
            db.query(
                `INSERT INTO reservations (
           user_id, ticket_type_id,
           idempotency_key, expires_at
         )
         VALUES (
           $1, $2, 'key-12',
           NOW() - INTERVAL '1 minute'
         )`,
                [f.userId, f.ticketId]
            ),
            "23514",
            "chk_reservations_expiration"
        );
    });
});

test("DB-13: confirmed status requires confirmed_at", async () => {
    await withFixture(async (db, f) => {
        await expectDbError(
            db.query(
                `INSERT INTO reservations (
           user_id, ticket_type_id,
           status, idempotency_key, expires_at
         )
         VALUES (
           $1, $2, 'CONFIRMED', 'key-13',
           NOW() + INTERVAL '5 minutes'
         )`,
                [f.userId, f.ticketId]
            ),
            "23514",
            "chk_reservations_confirmation"
        );
    });
});

test("DB-14: invalid ticket foreign key is rejected", async () => {
    await withFixture(async (db, f) => {
        await expectDbError(
            db.query(
                `INSERT INTO reservations (
           user_id, ticket_type_id,
           idempotency_key, expires_at
         )
         VALUES (
           $1, $2, 'key-14',
           NOW() + INTERVAL '5 minutes'
         )`,
                [f.userId, randomUUID()]
            ),
            "23503"
        );
    });
});

test("DB-15: duplicate idempotency key is rejected", async () => {
    await withFixture(async (db, f) => {
        await db.query(
            `INSERT INTO reservations (
         user_id, ticket_type_id,
         idempotency_key, expires_at
       )
       VALUES (
         $1, $2, 'same-key',
         NOW() + INTERVAL '5 minutes'
       )`,
            [f.userId, f.ticketId]
        );

        const vip = await db.query<{ id: string }>(
            `INSERT INTO ticket_types (
         event_id, name, capacity
       )
       VALUES ($1, 'VIP', 2)
       RETURNING id`,
            [f.eventId]
        );

        await expectDbError(
            db.query(
                `INSERT INTO reservations (
           user_id, ticket_type_id,
           idempotency_key, expires_at
         )
         VALUES (
           $1, $2, 'same-key',
           NOW() + INTERVAL '5 minutes'
         )`,
                [f.userId, vip.rows[0].id]
            ),
            "23505",
            "uq_reservations_user_idempotency"
        );
    });
});

test("DB-16: duplicate active reservation is rejected", async () => {
    await withFixture(async (db, f) => {
        await db.query(
            `INSERT INTO reservations (
         user_id, ticket_type_id,
         idempotency_key, expires_at
       )
       VALUES (
         $1, $2, 'first-key',
         NOW() + INTERVAL '5 minutes'
       )`,
            [f.userId, f.ticketId]
        );

        await expectDbError(
            db.query(
                `INSERT INTO reservations (
           user_id, ticket_type_id,
           idempotency_key, expires_at
         )
         VALUES (
           $1, $2, 'second-key',
           NOW() + INTERVAL '5 minutes'
         )`,
                [f.userId, f.ticketId]
            ),
            "23505",
            "uq_reservations_active_user_ticket"
        );
    });
});

test("DB-17: cancelled reservation allows new hold", async () => {
    await withFixture(async (db, f) => {
        await db.query(
            `INSERT INTO reservations (
         user_id, ticket_type_id,
         status, idempotency_key, expires_at
       )
       VALUES (
         $1, $2, 'CANCELLED', 'old-key',
         NOW() + INTERVAL '5 minutes'
       )`,
            [f.userId, f.ticketId]
        );

        await db.query(
            `INSERT INTO reservations (
         user_id, ticket_type_id,
         status, idempotency_key, expires_at
       )
       VALUES (
         $1, $2, 'HELD', 'new-key',
         NOW() + INTERVAL '5 minutes'
       )`,
            [f.userId, f.ticketId]
        );

        const result = await db.query<{ count: string }>(
            `SELECT COUNT(*) AS count
       FROM reservations
       WHERE user_id = $1
         AND ticket_type_id = $2`,
            [f.userId, f.ticketId]
        );

        assert.equal(Number(result.rows[0].count), 2);
    });
});
