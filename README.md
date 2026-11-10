# Movie Memory

Sign in with Google, tell the app your favorite movie, and get an OpenAI-generated fun fact about it.

**Variant chosen: A — Backend-focused (caching + correctness).**

Stack: TypeScript · Next.js 15 (App Router) · React 19 + Tailwind 4 · Postgres · Prisma 6 · Auth.js (Google OAuth) · OpenAI SDK · Vitest

## Requirements coverage

| Requirement (from the brief) | Where / how |
|---|---|
| Landing page with "Sign in with Google" when unauthenticated | `src/app/page.tsx` |
| First-time users → onboarding, returning users → dashboard | `src/app/dashboard/page.tsx` redirects to `/onboarding` when the user has no `FavoriteMovie` row |
| Onboarding: server-side validation (trim, min/max), stored in Postgres, tied to the user | `src/lib/validation.ts`, `src/app/onboarding/actions.ts`, `FavoriteMovie.userId @unique` |
| Dashboard: name, email, photo, favorite movie (DB), logout | `src/app/dashboard/page.tsx` (fallbacks for missing name/photo) |
| Logged-out `/dashboard` → login | Server-side `auth()` check → redirect to `/` |
| Fun fact via OpenAI, facts stored in DB | `src/lib/openai.ts`, `Fact` table |
| **Variant A:** 60-second cache window | `src/lib/facts.ts` + `src/lib/fact-store.ts` (DB clock) |
| **Variant A:** burst / idempotency protection | Per-user Postgres advisory lock + re-check after lock |
| **Variant A:** failure handling (cached fact, else friendly error) | `stale` fallback, otherwise `FactUnavailableError` → HTTP 503 |
| **Variant A:** tests for cache logic + authorization | `src/lib/__tests__/facts.test.ts`, `src/app/api/fact/__tests__/route.test.ts` |
| Users can't access/modify other users' data | User id comes only from the signed session; every query is scoped by it |
| No secrets exposed to the client | Server-only env vars; `server-only` imports |
| Graceful missing Google name/photo | Email-prefix name, initials avatar |

---

## Setup

### 1. Prerequisites
- Node 20+ (developed on 22)
- A Postgres database (local, or a free [Neon](https://neon.tech) project)
- A Google OAuth client (Google Cloud Console → APIs & Services → Credentials → *OAuth client ID* → *Web application*)
  - Authorized redirect URI: `http://localhost:3000/api/auth/callback/google`
  - If the OAuth consent screen is in *Testing* mode, add your Google account under **Audience → Test users**
- An OpenAI API key (or any OpenAI-compatible provider, see [LLM provider](#llm-provider))

### 2. Install and configure
```bash
npm install            # also runs `prisma generate`
cp .env.example .env   # then fill in the values below
```

### 3. Environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `AUTH_SECRET` | Signs/encrypts the session cookie. Generate with `npx auth secret` or `openssl rand -base64 32` |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | Google OAuth credentials |
| `OPENAI_API_KEY` | **Server-only.** Never prefix with `NEXT_PUBLIC_` |
| `OPENAI_MODEL` | Optional, defaults to `gpt-4o-mini` |
| `OPENAI_BASE_URL` | Optional. Leave unset to use OpenAI. Set it to use an OpenAI-compatible provider (read automatically by the OpenAI SDK) |

#### LLM provider
The app uses the official `openai` SDK and defaults to OpenAI (`gpt-4o-mini`). Because the SDK reads `OPENAI_BASE_URL`, any OpenAI-compatible provider works with **no code changes**, only env vars. During development I ran it against Groq's free tier (`OPENAI_BASE_URL=https://api.groq.com/openai/v1`, `OPENAI_MODEL=openai/gpt-oss-120b`) because my OpenAI account had no credits. To use OpenAI, set a real OpenAI key and remove `OPENAI_BASE_URL`.

### 4. Database migrations
```bash
npm run db:migrate        # prisma migrate deploy — applies prisma/migrations/0001_init
# or, while developing the schema:
npm run db:migrate:dev
```

### 5. Run
```bash
npm run dev      # http://localhost:3000
npm test         # unit tests (no database or network needed)
RUN_INTEGRATION=1 npx vitest run fact-store.integration   # optional: real-Postgres concurrency test
npm run typecheck
npm run build
```

---

## Architecture overview

### Request flow
```
/                  landing page ("Sign in with Google"); signed-in users are redirected on
   └─ Google OAuth ──► /dashboard
/dashboard         no session            -> redirect to /
                   session, no movie     -> redirect to /onboarding   (first-time user)
                   session + movie       -> dashboard
/onboarding        server action validates + stores the movie, then -> /dashboard
                   (already has a movie -> redirect to /dashboard)
GET /api/fact      session -> user's movie -> getOrGenerateFact() -> JSON
```

"First-time user" is not a flag: it is simply *a user with no `FavoriteMovie` row*. That is derived from the data, so it can't drift out of sync.

### Code layout
| Path | Responsibility |
|---|---|
| `prisma/schema.prisma` | Data model |
| `src/auth.ts` | Auth.js config (Google, Prisma adapter, JWT sessions) |
| `src/lib/facts.ts` | **The Variant A logic**: cache window, locking flow, failure fallback. Pure — depends only on two interfaces |
| `src/lib/fact-store.ts` | Postgres implementation of the store (advisory lock, DB-clock queries) |
| `src/lib/openai.ts` | OpenAI call (10s timeout, no retries, `server-only`) |
| `src/lib/validation.ts` | Zod schema for the movie title |
| `src/app/api/fact/route.ts` | Thin HTTP layer: auth → call service → map errors to status codes |
| `src/app/onboarding/actions.ts` | Server action: auth, validation, insert |
| `src/components/fact-card.tsx` | Client component with loading / error / ready states |

`facts.ts` knows nothing about Prisma or OpenAI. That separation is why the cache and concurrency tests run in milliseconds with an in-memory store.

### Data model
- **`User` / `Account`** — Auth.js tables. `name` and `image` are nullable (Google may omit them); the UI falls back to the email prefix and initials.
- **`FavoriteMovie`** — `userId @unique`. "One movie per user" is enforced by the database, so a double-submit or a second tab cannot create two rows (we catch `P2002` and carry on).
- **`Fact`** — append-only history: `(id, userId, movieTitle, content, createdAt timestamptz)`.
  - *Append-only* means no updates and no races on a "current fact" row. The current fact is just the newest row, and old rows are the fallback when OpenAI is down.
  - `movieTitle` is a snapshot rather than a foreign key, so history stays correct if the favorite movie changes.
  - Index `(userId, movieTitle, createdAt DESC)` turns "latest fact for this user + movie" into one index lookup (equality columns first, sort column last).
  - `createdAt` is `timestamptz` so comparisons with `clock_timestamp()` are not affected by the server's timezone.

### The 60-second cache and burst protection

```
getOrGenerateFact(userId, movieTitle):
  BEGIN
  pg_advisory_xact_lock(hash(userId))             -- 1. serialise this user's requests
  fresh = newest fact where age < 60s             -- 2. check AFTER taking the lock
  if fresh            -> return it  (source: cache)
  try   content = openai(movieTitle)              -- 3. 10s timeout
  catch -> newest fact of any age?  return it     (source: stale)
           else throw FactUnavailableError        -> HTTP 503, friendly message
  insert fact (createdAt = clock_timestamp())
  COMMIT                                          -- releases the lock
```

**Why the check is after the lock.** Two tabs arrive together while the cache is empty. Tab A takes the lock and calls OpenAI; tab B blocks. When B gets the lock it re-checks, finds A's fresh fact, and returns it. One OpenAI call, same fact in both tabs. (Double-checked locking.)

**Why an advisory lock** (vs. the alternatives in the brief):
- *In-memory lock* — simplest, but only works inside one process. On serverless or multiple instances two tabs can hit different processes. Not safe.
- *Unique constraint per 60s window* — prevents duplicate rows but not duplicate OpenAI calls (the loser has already paid for the call), and window bucketing creates edge effects at bucket boundaries.
- *"In progress" flag/row* — works across instances, but needs stale-flag cleanup if a request crashes mid-generation.
- *`pg_advisory_xact_lock`* — lives in the DB (works across instances), is released automatically on commit/rollback/connection loss (no stuck locks), and needs no extra table or infrastructure. Chosen.

**One clock.** All age comparisons use the database's `clock_timestamp()`, never `Date.now()` on an app server, so instances with skewed clocks agree. `clock_timestamp()` rather than `now()`, because `now()` is frozen at transaction start — i.e. *before* we waited for the lock. Inserts also use `clock_timestamp()`, so a fact's age counts from when it was stored, not from when the transaction began.

**Window semantics.** A fact is fresh if its age is strictly `< 60s`; at exactly 60s a new one is generated (covered by a test).

### Security
- **Authorization:** `GET /api/fact` accepts no user id. The user comes from the signed session cookie and the movie is read from *that user's* row. Every store method takes `userId` and filters by it. There is no parameter to tamper with (no IDOR surface).
- **Server actions re-check auth** — they are public POST endpoints.
- **Validation is server-side:** trimmed, 2–100 chars, no control characters (`zod`). The `maxLength` on the input is UX only.
- **Secrets:** `OPENAI_API_KEY` and OAuth secrets are read only in server code; `openai.ts`, `prisma.ts`, and `fact-store.ts` import `server-only`, so a client import fails the build.
- **Prompt injection:** the movie title is user input that goes into an LLM prompt. It's passed as quoted data, the system prompt says to ignore instructions in it, output length is capped (`max_tokens`), and the result is rendered as plain text (React escapes it).
- **Errors:** the API returns friendly messages; internals are logged server-side only.
- **Missing name/photo:** handled with fallbacks in the dashboard.

### Tests (`npm test`)
- `src/lib/__tests__/facts.test.ts` — cache hit at 59s, miss at exactly 60s and at 61s, window measured from the newest fact, **5 concurrent requests → 1 OpenAI call and one shared fact**, failure fallback (stale fact / friendly error / lock released after failure), and **user isolation** (same movie, different users never share facts, including in the failure fallback).
- `src/app/api/fact/__tests__/route.test.ts` — 401 when signed out, the route acts only on the session user's id and movie, 409 before onboarding, 503 without leaking error details.

`src/lib/__tests__/fact-store.integration.test.ts` (opt-in) runs the same scenarios against a real Postgres: 5 concurrent requests → 1 generation and 1 row, cache vs. >60s on the DB clock, stale fallback, and user isolation.

The in-memory test store mimics the Postgres one (per-user lock serialisation, lock released on throw, all reads scoped by user).

---

## Why Variant A

It puts the interesting engineering in one small, well-defined place — `getOrGenerateFact` — where correctness can be *demonstrated* (tests) rather than just claimed, and the questions it raises (data modelling, clocks, concurrency, failure modes) are the ones I can reason about from first principles.

## Key tradeoffs

- **DB lock held during the OpenAI call.** Simple and correct, but one connection stays busy for up to ~10s per generating request, and waiters hold a connection too. Fine at this scale; at higher scale I'd move generation to a queue/background job and have requests poll an "in progress" row.
- **Per-user lock, not per-user-and-movie.** Coarser than necessary, but a user has one movie, so there's no practical cost and it's easy to reason about.
- **Fall back to *stale* facts on failure** rather than erroring, because showing an older fact is better UX than an error page. The UI says so explicitly.
- **JWT sessions** (no Session table): fewer queries and moving parts; the downside is that sessions can't be revoked server-side before they expire.
- **Raw SQL in two spots** (fresh-fact query, insert) so both use the DB clock. Prisma's query builder can't express `clock_timestamp()`. The raw SQL is small, parameterised (tagged templates, so no injection), and isolated in one file.
- **Client fetches the fact via `/api/fact`** (instead of rendering it in the server component) so the dashboard paints immediately and the fact has real loading/error states.
- **Prisma 6, not 7** — v7 requires driver adapters and a new config file; v6 is simpler and well documented.

## What I'd improve with 2 more hours

1. **Run the Postgres integration test in CI** (Testcontainers/CI service). It exists and passes locally, but isn't wired into automated runs.
2. **Per-user rate limit** on `/api/fact` (e.g. 10/min) to cap OpenAI spend — separate from the 60s cache.
3. **Move generation off the request path** (queue + "in progress" state) so no DB connection is held during the LLM call.
4. **Edit-favorite-movie flow** with cache keyed by movie (the schema already supports it).
5. **Structured logging / metrics** for cache hit rate, OpenAI latency and failures.
6. **Pruning old facts** (cron) and encrypting stored OAuth tokens in `Account`.
7. **E2E test** (Playwright) for the sign-in → onboarding → dashboard path.

---

## AI usage note

- Used Claude (Claude Code) as a pair-programmer to scaffold the Next.js project, draft the Prisma schema, and write the first version of the fact service, API route, UI components and tests.
- Used it to compare locking strategies (in-memory vs. unique-window vs. in-progress flag vs. Postgres advisory lock) before choosing one.
- Used it to debug integration issues (OpenAI quota error, switching to an OpenAI-compatible provider, reasoning models returning empty output at a low `max_tokens`).
- Verified the result with the type checker, linter, unit tests, an opt-in real-Postgres integration test, a production build, and manual testing of the sign-in → onboarding → dashboard flow.
- I can explain every part of the submission, including the schema, the locking approach and the failure handling.
