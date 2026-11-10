/**
 * Fact service — the heart of Variant A.
 *
 * This file is deliberately free of Prisma / OpenAI imports. It only depends on
 * two small interfaces (FactStore, generate fn), so the cache + concurrency
 * logic can be unit-tested without a database or network.
 *
 * Flow for getOrGenerateFact(userId, movieTitle):
 *
 *   1. Take a per-user lock            (serialises concurrent requests)
 *   2. Is there a fact < 60s old?      -> return it            (source: "cache")
 *   3. Otherwise ask OpenAI, store it  -> return it            (source: "generated")
 *   4. OpenAI failed?
 *        - any older fact exists       -> return it            (source: "stale")
 *        - nothing at all              -> throw FactUnavailableError
 *
 * Why step 2 runs AFTER the lock: two tabs can both arrive while the cache is
 * empty. Tab A gets the lock and generates; tab B waits. When B finally gets
 * the lock it re-checks the cache, sees A's fresh fact and returns it without
 * calling OpenAI. (Double-checked locking.) Result: one OpenAI call, same fact
 * in both tabs.
 */

export const CACHE_WINDOW_SECONDS = 60;

export interface FactRecord {
  id: string;
  content: string;
  createdAt: Date;
}

/** Operations available while the per-user lock is held. All scoped by userId. */
export interface FactTx {
  /** Newest fact younger than `windowSeconds`, measured on the DB clock. */
  findFreshFact(
    userId: string,
    movieTitle: string,
    windowSeconds: number,
  ): Promise<FactRecord | null>;
  /** Newest fact regardless of age (used as fallback when OpenAI fails). */
  findLatestFact(userId: string, movieTitle: string): Promise<FactRecord | null>;
  insertFact(
    userId: string,
    movieTitle: string,
    content: string,
  ): Promise<FactRecord>;
}

export interface FactStore {
  /** Runs `fn` while holding an exclusive lock for this user. */
  withUserLock<T>(userId: string, fn: (tx: FactTx) => Promise<T>): Promise<T>;
}

export type FactSource = "cache" | "generated" | "stale";

export interface FactResult {
  fact: FactRecord;
  source: FactSource;
}

export class FactUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("Fact generation is currently unavailable", options);
    this.name = "FactUnavailableError";
  }
}

export interface GetFactArgs {
  userId: string;
  movieTitle: string;
  store: FactStore;
  /** Calls the LLM. Must reject on timeout/error. */
  generate: (movieTitle: string) => Promise<string>;
  windowSeconds?: number;
}

export async function getOrGenerateFact({
  userId,
  movieTitle,
  store,
  generate,
  windowSeconds = CACHE_WINDOW_SECONDS,
}: GetFactArgs): Promise<FactResult> {
  return store.withUserLock(userId, async (tx) => {
    const fresh = await tx.findFreshFact(userId, movieTitle, windowSeconds);
    if (fresh) return { fact: fresh, source: "cache" };

    // Only the OpenAI call is wrapped in try/catch. DB errors must propagate:
    // inside a Postgres transaction a failed statement aborts the whole tx, so
    // "falling back" with another query would not work anyway.
    let content: string;
    try {
      content = await generate(movieTitle);
    } catch (err) {
      const stale = await tx.findLatestFact(userId, movieTitle);
      if (stale) return { fact: stale, source: "stale" };
      throw new FactUnavailableError({ cause: err });
    }

    const fact = await tx.insertFact(userId, movieTitle, content);
    return { fact, source: "generated" };
  });
}
