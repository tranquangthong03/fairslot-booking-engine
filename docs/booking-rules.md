# FairSlot – Booking Business Rules

## 1. Objective

Build a concurrency-safe booking engine that prevents overselling and supports reliable reservation processing.

## 2. Main Entities

- User: A person who creates or manages reservations.
- Event: An event created by an organizer.
- TicketType: A ticket category with a fixed capacity.
- Reservation: A record of a user's booking attempt and its lifecycle.

## 3. Reservation Lifecycle

- HELD: The ticket is temporarily reserved.
- CONFIRMED: The reservation has been confirmed.
- EXPIRED: The holding period has expired.
- CANCELLED: The reservation has been cancelled.

Allowed transitions:

- HELD → CONFIRMED
- HELD → EXPIRED
- HELD → CANCELLED
- CONFIRMED → CANCELLED (subject to cancellation policy)

## 4. Core Business Rules

1. A ticket type has a fixed non-negative capacity.
2. A user can hold at most one active reservation per ticket type.
3. The default reservation holding period is five minutes.
4. A confirmed reservation consumes one ticket.
5. An unexpired HELD reservation consumes one ticket.
6. An expired or cancelled reservation does not consume capacity.
7. Active reservations must never exceed ticket capacity.
8. Repeated requests with the same idempotency key must not create duplicate reservations.
9. Concurrent requests must not cause overselling.
10. The database is the source of truth for booking state.

## 5. Initial Scope

- Event management
- Ticket type management
- Reservation creation
- Reservation confirmation
- Reservation cancellation
- Reservation expiration

Payment integration, real-time waiting rooms and external notifications are outside the initial scope.

## 6. Technical Priorities

- PostgreSQL transactions
- Concurrency control
- Referential integrity
- Idempotent APIs
- Automated verification
