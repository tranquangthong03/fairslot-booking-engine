
-- FairSlot Initial Schema V1.0
-- PostgreSQL 17
-- Do not add BEGIN/COMMIT here.
-- The migration runner manages transactions.

-- 1. USERS

CREATE TABLE public.users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    email VARCHAR(255) NOT NULL,
    password_hash TEXT NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'USER',

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_users_email UNIQUE (email),

    CONSTRAINT chk_users_email_normalized CHECK (
        email = LOWER(BTRIM(email))
        AND BTRIM(email) <> ''
    ),

    CONSTRAINT chk_users_password CHECK (
        BTRIM(password_hash) <> ''
    ),

    CONSTRAINT chk_users_role CHECK (
        role IN ('USER', 'ORGANIZER', 'ADMIN')
    )
);

-- 2. EVENTS

CREATE TABLE public.events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    organizer_id UUID NOT NULL
        REFERENCES public.users(id) ON DELETE RESTRICT,

    title VARCHAR(255) NOT NULL,
    description TEXT,

    status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',

    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_events_title CHECK (
        BTRIM(title) <> ''
    ),

    CONSTRAINT chk_events_status CHECK (
        status IN ('DRAFT', 'PUBLISHED', 'CANCELLED')
    ),

    CONSTRAINT chk_events_time CHECK (
        ends_at > starts_at
    )
);

-- 3. TICKET TYPES

CREATE TABLE public.ticket_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    event_id UUID NOT NULL
        REFERENCES public.events(id) ON DELETE RESTRICT,

    name VARCHAR(100) NOT NULL,

    capacity INTEGER NOT NULL,
    held_count INTEGER NOT NULL DEFAULT 0,
    confirmed_count INTEGER NOT NULL DEFAULT 0,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_ticket_types_name CHECK (
        BTRIM(name) <> ''
    ),

    CONSTRAINT chk_ticket_types_capacity CHECK (
        capacity > 0
    ),

    CONSTRAINT chk_ticket_types_held CHECK (
        held_count >= 0
    ),

    CONSTRAINT chk_ticket_types_confirmed CHECK (
        confirmed_count >= 0
    ),

    CONSTRAINT chk_ticket_types_inventory CHECK (
        held_count + confirmed_count <= capacity
    )
);

-- 4. RESERVATIONS

CREATE TABLE public.reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL
        REFERENCES public.users(id) ON DELETE RESTRICT,

    ticket_type_id UUID NOT NULL
        REFERENCES public.ticket_types(id) ON DELETE RESTRICT,

    status VARCHAR(20) NOT NULL DEFAULT 'HELD',

    idempotency_key VARCHAR(128) NOT NULL,

    expires_at TIMESTAMPTZ NOT NULL,
    confirmed_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_reservations_user_idempotency
        UNIQUE (user_id, idempotency_key),

    CONSTRAINT chk_reservations_key CHECK (
        BTRIM(idempotency_key) <> ''
    ),

    CONSTRAINT chk_reservations_status CHECK (
        status IN (
            'HELD',
            'CONFIRMED',
            'EXPIRED',
            'CANCELLED'
        )
    ),

    CONSTRAINT chk_reservations_expiration CHECK (
        expires_at > created_at
    ),

    CONSTRAINT chk_reservations_confirmation CHECK (
        (
            status = 'CONFIRMED'
            AND confirmed_at IS NOT NULL
        )
        OR
        (
            status <> 'CONFIRMED'
            AND confirmed_at IS NULL
        )
    )
);

-- 5. INDEXES

CREATE INDEX idx_events_organizer
ON public.events (organizer_id);

CREATE INDEX idx_ticket_types_event
ON public.ticket_types (event_id);

-- Case-insensitive ticket name per event.
CREATE UNIQUE INDEX uq_ticket_types_event_name
ON public.ticket_types (
    event_id,
    LOWER(BTRIM(name))
);

-- Prevent duplicate active reservations.
CREATE UNIQUE INDEX uq_reservations_active_user_ticket
ON public.reservations (
    user_id,
    ticket_type_id
)
WHERE status IN ('HELD', 'CONFIRMED');

-- User reservation history.
CREATE INDEX idx_reservations_user_history
ON public.reservations (
    user_id,
    created_at DESC
);

-- Inventory reconciliation.
CREATE INDEX idx_reservations_ticket_status
ON public.reservations (
    ticket_type_id,
    status
);

-- Expiration scanning.
CREATE INDEX idx_reservations_held_expiration
ON public.reservations (expires_at)
WHERE status = 'HELD';
