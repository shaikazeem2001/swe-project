import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FactUnavailableError,
  getOrGenerateFact,
  type FactRecord,
  type FactStore,
  type FactTx,
} from "@/lib/facts";

/**
 * In-memory FactStore that mimics the guarantees of the Postgres one:
 *  - withUserLock serialises callers per user (like pg_advisory_xact_lock)
 *  - the lock is released even if the callback throws
 *  - every read is scoped by userId
 *  - "now" is a single clock (Date, which we control with fake timers)
 */
class InMemoryFactStore implements FactStore {
  rows: (FactRecord & { userId: string; movieTitle: string })[] = [];
  private tails = new Map<string, Promise<void>>();
  private seq = 0;

  async withUserLock<T>(userId: string, fn: (tx: FactTx) => Promise<T>): Promise<T> {
    const previous = this.tails.get(userId) ?? Promise.resolve();
    let release!: () => void;
    this.tails.set(
      userId,
      new Promise<void>((r) => (release = r)),
    );
    await previous;
    try {
      return await fn(this.tx());
    } finally {
      release();
    }
  }

  private tx(): FactTx {
    const newest = (userId: string, movieTitle: string) =>
      this.rows
        .filter((r) => r.userId === userId && r.movieTitle === movieTitle)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
    return {
      findFreshFact: async (userId, movieTitle, windowSeconds) => {
        const row = newest(userId, movieTitle);
        const fresh = row && Date.now() - row.createdAt.getTime() < windowSeconds * 1000;
        return fresh ? row : null;
      },
      findLatestFact: async (userId, movieTitle) => newest(userId, movieTitle),
      insertFact: async (userId, movieTitle, content) => {
        const row = { id: `fact-${++this.seq}`, userId, movieTitle, content, createdAt: new Date() };
        this.rows.push(row);
        return row;
      },
    };
  }
}

const T0 = new Date("2026-01-01T00:00:00Z");
const MOVIE = "Inception";

describe("getOrGenerateFact — 60 second cache window", () => {
  let store: InMemoryFactStore;
  let generate: ReturnType<typeof vi.fn<(title: string) => Promise<string>>>;

  const run = (userId = "user-a", movieTitle = MOVIE) =>
    getOrGenerateFact({ userId, movieTitle, store, generate });

  beforeEach(() => {
    // Only fake Date so promises/timers behave normally.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    store = new InMemoryFactStore();
    let n = 0;
    generate = vi.fn(async () => `fact #${++n}`);
  });
  afterEach(() => vi.useRealTimers());

  it("generates and stores a fact when none exists", async () => {
    const res = await run();
    expect(res.source).toBe("generated");
    expect(res.fact.content).toBe("fact #1");
    expect(store.rows).toHaveLength(1);
  });

  it("returns the cached fact when the latest one is < 60s old", async () => {
    const first = await run();
    vi.setSystemTime(new Date(T0.getTime() + 59_000));

    const second = await run();

    expect(second.source).toBe("cache");
    expect(second.fact.id).toBe(first.fact.id);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(store.rows).toHaveLength(1);
  });

  it("treats exactly 60s as expired (window is strictly < 60s)", async () => {
    await run();
    vi.setSystemTime(new Date(T0.getTime() + 60_000));

    const res = await run();

    expect(res.source).toBe("generated");
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("generates a new fact once the latest one is older than 60s", async () => {
    const first = await run();
    vi.setSystemTime(new Date(T0.getTime() + 61_000));

    const second = await run();

    expect(second.source).toBe("generated");
    expect(second.fact.id).not.toBe(first.fact.id);
    expect(store.rows).toHaveLength(2); // history is kept, not overwritten
  });

  it("measures the window from the NEWEST fact, not the first one", async () => {
    await run(); // t=0
    vi.setSystemTime(new Date(T0.getTime() + 61_000));
    const second = await run(); // t=61 -> new fact
    vi.setSystemTime(new Date(T0.getTime() + 61_000 + 30_000));

    const third = await run(); // 30s after the 2nd fact -> cached

    expect(third.source).toBe("cache");
    expect(third.fact.id).toBe(second.fact.id);
    expect(generate).toHaveBeenCalledTimes(2);
  });
});

describe("getOrGenerateFact — burst / idempotency protection", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  it("calls OpenAI once when many requests arrive at the same time (multi-tab)", async () => {
    const store = new InMemoryFactStore();
    const generate = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 25)); // slow LLM => real overlap
      return "a single fact";
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        getOrGenerateFact({ userId: "user-a", movieTitle: MOVIE, store, generate }),
      ),
    );

    expect(generate).toHaveBeenCalledTimes(1);
    expect(store.rows).toHaveLength(1);
    expect(new Set(results.map((r) => r.fact.id)).size).toBe(1); // everyone sees the same fact
    expect(results.filter((r) => r.source === "generated")).toHaveLength(1);
    expect(results.filter((r) => r.source === "cache")).toHaveLength(4);
  });

  it("does not make different users wait on / share each other's generation", async () => {
    const store = new InMemoryFactStore();
    const generate = vi.fn(async (title: string) => `fact about ${title}`);

    const [a, b] = await Promise.all([
      getOrGenerateFact({ userId: "user-a", movieTitle: MOVIE, store, generate }),
      getOrGenerateFact({ userId: "user-b", movieTitle: MOVIE, store, generate }),
    ]);

    expect(generate).toHaveBeenCalledTimes(2);
    expect(a.fact.id).not.toBe(b.fact.id);
  });
});

describe("getOrGenerateFact — OpenAI failure handling", () => {
  let store: InMemoryFactStore;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    store = new InMemoryFactStore();
  });
  afterEach(() => vi.useRealTimers());

  it("falls back to the most recent (stale) fact when OpenAI fails", async () => {
    const ok = vi.fn(async () => "old fact");
    const first = await getOrGenerateFact({ userId: "user-a", movieTitle: MOVIE, store, generate: ok });
    vi.setSystemTime(new Date(T0.getTime() + 120_000)); // cache expired

    const failing = vi.fn(async () => {
      throw new Error("timeout");
    });
    const res = await getOrGenerateFact({ userId: "user-a", movieTitle: MOVIE, store, generate: failing });

    expect(res.source).toBe("stale");
    expect(res.fact.id).toBe(first.fact.id);
    expect(store.rows).toHaveLength(1); // nothing bogus was stored
  });

  it("throws a user-safe FactUnavailableError when OpenAI fails and nothing is cached", async () => {
    const failing = vi.fn(async () => {
      throw new Error("500 from OpenAI");
    });

    await expect(
      getOrGenerateFact({ userId: "user-a", movieTitle: MOVIE, store, generate: failing }),
    ).rejects.toBeInstanceOf(FactUnavailableError);
    expect(store.rows).toHaveLength(0);
  });

  it("releases the lock after a failure so the next request can succeed", async () => {
    const failing = vi.fn(async () => {
      throw new Error("boom");
    });
    await getOrGenerateFact({ userId: "user-a", movieTitle: MOVIE, store, generate: failing }).catch(() => {});

    const ok = vi.fn(async () => "recovered");
    const res = await getOrGenerateFact({ userId: "user-a", movieTitle: MOVIE, store, generate: ok });

    expect(res.source).toBe("generated");
    expect(res.fact.content).toBe("recovered");
  });
});

describe("getOrGenerateFact — authorization / data isolation", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  it("never returns another user's fact, even for the same movie", async () => {
    const store = new InMemoryFactStore();
    const alice = await getOrGenerateFact({
      userId: "alice",
      movieTitle: MOVIE,
      store,
      generate: async () => "alice's private fact",
    });

    // Bob has the same favorite movie, moments later (alice's fact is fresh).
    const bob = await getOrGenerateFact({
      userId: "bob",
      movieTitle: MOVIE,
      store,
      generate: async () => "bob's own fact",
    });

    expect(bob.source).toBe("generated");
    expect(bob.fact.id).not.toBe(alice.fact.id);
    expect(bob.fact.content).toBe("bob's own fact");
  });

  it("does not fall back to another user's fact when OpenAI fails", async () => {
    const store = new InMemoryFactStore();
    await getOrGenerateFact({
      userId: "alice",
      movieTitle: MOVIE,
      store,
      generate: async () => "alice's private fact",
    });

    await expect(
      getOrGenerateFact({
        userId: "bob",
        movieTitle: MOVIE,
        store,
        generate: async () => {
          throw new Error("down");
        },
      }),
    ).rejects.toBeInstanceOf(FactUnavailableError);
  });
});
