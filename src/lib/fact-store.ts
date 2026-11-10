import "server-only";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { FactRecord, FactStore, FactTx } from "@/lib/facts";

// An interactive transaction wraps lock wait + OpenAI call + insert, so the
// Prisma default (5s) is too short. OpenAI itself is capped at 10s (see
// openai.ts); the extra headroom covers waiting behind another request.
const TX_TIMEOUT_MS = 25_000;
const TX_MAX_WAIT_MS = 5_000;

type Row = { id: string; content: string; createdAt: Date };

/**
 * Postgres-backed FactStore.
 *
 * Concurrency: pg_advisory_xact_lock(key) is an application-level lock held
 * until the transaction commits/rolls back. Properties we rely on:
 *   - works across any number of app instances (it lives in the DB);
 *   - released automatically on commit, rollback, or connection loss, so a
 *     crashed request can never leave the user locked out;
 *   - keyed per user, so different users never block each other.
 *
 * Clock: all time comparisons use the DB's clock_timestamp(), never the app
 * server's Date.now(), so multiple instances with skewed clocks agree.
 * clock_timestamp() (not now()) because now() is frozen at transaction start,
 * i.e. BEFORE we waited for the lock.
 */
export const prismaFactStore: FactStore = {
  withUserLock(userId, fn) {
    return prisma.$transaction(
      async (db) => {
        await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`;

        const tx: FactTx = {
          async findFreshFact(uid, movieTitle, windowSeconds) {
            const rows = await db.$queryRaw<Row[]>`
              SELECT id, content, "createdAt"
              FROM "Fact"
              WHERE "userId" = ${uid}
                AND "movieTitle" = ${movieTitle}
                AND "createdAt" > clock_timestamp() - (${windowSeconds}::double precision * interval '1 second')
              ORDER BY "createdAt" DESC
              LIMIT 1`;
            return rows[0] ?? null;
          },

          async findLatestFact(uid, movieTitle) {
            return db.fact.findFirst({
              where: { userId: uid, movieTitle },
              orderBy: { createdAt: "desc" },
              select: { id: true, content: true, createdAt: true },
            });
          },

          async insertFact(uid, movieTitle, content): Promise<FactRecord> {
            // Raw insert so createdAt = clock_timestamp() at the moment of
            // insert (after the OpenAI call), not the transaction start time.
            const rows = await db.$queryRaw<Row[]>`
              INSERT INTO "Fact" (id, "userId", "movieTitle", content, "createdAt")
              VALUES (${randomUUID()}, ${uid}, ${movieTitle}, ${content}, clock_timestamp())
              RETURNING id, content, "createdAt"`;
            return rows[0];
          },
        };

        return fn(tx);
      },
      { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS },
    );
  },
};
