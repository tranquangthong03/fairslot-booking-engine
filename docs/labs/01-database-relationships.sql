
-- FairSlot - Database Relationships Lab
-- Temporary learning tables only.

BEGIN;

-- 1. Users
CREATE TEMP TABLE lab_users (
    id INTEGER PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE
);

-- 2. Events
CREATE TEMP TABLE lab_events (
    id INTEGER PRIMARY KEY,
    organizer_id INTEGER NOT NULL
        REFERENCES lab_users(id),
    title VARCHAR(255) NOT NULL
);

-- 3. Ticket types
CREATE TEMP TABLE lab_ticket_types (
    id INTEGER PRIMARY KEY,
    event_id INTEGER NOT NULL
        REFERENCES lab_events(id),
    name VARCHAR(100) NOT NULL,
    capacity INTEGER NOT NULL CHECK (capacity > 0),
    held_count INTEGER NOT NULL DEFAULT 0,
    confirmed_count INTEGER NOT NULL DEFAULT 0,

    CHECK (held_count >= 0),
    CHECK (confirmed_count >= 0),
    CHECK (held_count + confirmed_count <= capacity)
);

-- 4. Reservations
CREATE TEMP TABLE lab_reservations (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL
        REFERENCES lab_users(id),
    ticket_type_id INTEGER NOT NULL
        REFERENCES lab_ticket_types(id),
    status VARCHAR(20) NOT NULL
        CHECK (status IN ('HELD', 'CONFIRMED',
                         'EXPIRED', 'CANCELLED'))
);

-- Insert sample users
INSERT INTO lab_users (id, email)
VALUES
    (1, 'admin@example.com'),
    (2, 'an@example.com'),
    (3, 'binh@example.com');

-- Insert sample event
INSERT INTO lab_events (id, organizer_id, title)
VALUES (10, 1, 'Tech Conference 2026');

-- Insert ticket types
-- Counters represent the sample reservations below.
INSERT INTO lab_ticket_types
(id, event_id, name, capacity, held_count, confirmed_count)
VALUES
    (100, 10, 'Standard', 2, 0, 1),
    (101, 10, 'VIP', 1, 1, 0);

-- Insert sample reservations
INSERT INTO lab_reservations
(id, user_id, ticket_type_id, status)
VALUES
    (1000, 2, 100, 'CONFIRMED'),
    (1001, 3, 101, 'HELD');

-- QUERY 1: Who booked which ticket?
SELECT
    r.id AS reservation_id,
    u.email,
    e.title AS event_title,
    t.name AS ticket_type,
    r.status
FROM lab_reservations r
JOIN lab_users u
    ON r.user_id = u.id
JOIN lab_ticket_types t
    ON r.ticket_type_id = t.id
JOIN lab_events e
    ON t.event_id = e.id
ORDER BY r.id;

-- QUERY 2: How many tickets are available?
SELECT
    name,
    capacity,
    held_count,
    confirmed_count,
    capacity - held_count - confirmed_count AS available
FROM lab_ticket_types
ORDER BY id;

-- Roll back the whole exercise.
-- Nothing is permanently saved.
ROLLBACK;
