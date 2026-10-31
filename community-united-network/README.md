# Community United Network

A platform for people to give, receive, learn, work, and grow together. This repository is the
first working version (MVP) of the concept.

## What is included

- **Accounts:** sign-up with an 18+ age check, login, logout. Passwords are hashed with scrypt.
  Sessions use an HttpOnly, SameSite=Strict cookie. Only a hash of the session token is stored.
- **Roles:** Need Help, Can Help, or Both. Switch at any time.
- **Profiles:** skills, tools and equipment owned, ZIP and city, availability, bio.
- **Tasks:** paid or volunteer. Scheduling options (ASAP through recurring), one to three helpers,
  supplies responsibility (requester, helper, either, not sure).
- **Matching:** ranked suggestions for helpers (`/api/me/matches`) and for requesters (`/api/tasks/:id/candidates`).
  Suggestions only. Every eligible person and task is still returned, so users can browse everything.
- **Task lifecycle:** open, accepted, in progress, awaiting confirmation, completed, partially completed,
  continue later, paused for safety, disputed, cancelled.
- **Payments (test mode):** the requester's full amount is held when the task is posted. Money moves only
  when the requester confirms. The helper receives the rate minus a 10% platform fee. Every movement is
  recorded in an append-only ledger.
- **Cancellation compensation:** more than 24 hours' notice pays nothing. 4–24 hours pays 25%. Under 4 hours
  pays 50%. Once the helper has arrived, pay is in full. A genuine emergency waives compensation.
  Helper withdrawal forfeits pay and reopens the slot.
- **Change requests:** price, helper count, schedule, location, supplies, and scope. The other party must
  approve. Each approved change is saved as a new version in the agreement history.
- **Safety concerns:** kept in their own table and queue, separate from payment disputes. A stop report
  pauses the task until an admin resolves it.
- **Reviews** after completion.
- **Privacy:** exact addresses are shown only to the requester and assigned helpers. Public listings show
  city and ZIP only.

## Not yet built (deliberate MVP limits)

- Real payment processing. Wire `payment_events` to a processor such as Stripe Connect with manual capture
  before taking real money. This needs legal review first.
- Identity verification provider. Admins currently set verification manually.
- Minors. The platform is 18+ only for now.
- Before-and-after photos, community-funded help, team pay rates, and hourly billing.
- Email or push notifications.

## Running it locally

Requirements: Node.js 22 or newer, and PostgreSQL 16 (or `docker compose up -d` using the included file).

```bash
npm install
cp .env.example .env            # optional; defaults match docker-compose.yml
npm run migrate                 # creates the schema
npm run dev                     # http://localhost:3000
```

Register an account in the app, then make yourself an admin:

```bash
npm run make-admin -- you@example.com
```

## Tests

```bash
createdb cun_test                # once
npm test
```

Tests cover the fee math, cancellation rules, the state machine, matching, and full API flows. Each flow
checks that the escrow ledger balances.

## Layout

```
src/domain.ts          pure rules: fees, cancellation, state machine
src/matching.ts        pure ranking
src/services/tasks.ts  transactional task, payment, change, and safety logic
src/routes/            HTTP layer
public/                browser UI (no build step)
test/                  unit and API tests
```

## Security notes

- Parameterized SQL everywhere. Profile update columns come from a fixed whitelist.
- All state changes that touch money run in a transaction with `SELECT ... FOR UPDATE` row locks.
- Requests must be JSON. Combined with SameSite=Strict cookies, this blocks cross-site form CSRF.
- Strict CSP via helmet. The UI never inserts user text as HTML.
- Login and registration are rate-limited. Login returns the same error for unknown emails and wrong passwords.
- Inputs are validated with zod. Error responses do not expose stack traces.
