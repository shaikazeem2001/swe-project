import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Opt-in integration test against a REAL Postgres (DATABASE_URL).
 *   RUN_INTEGRATION=1 npx vitest run fact-store.integration
 * Uses a throwaway user (deleted afterwards, facts cascade) and a mocked
 * OpenAI, so it costs nothing. Skipped in normal `npm test`.
 */
const enabled = process.env.RUN_INTEGRATION === "1";
if (enabled && !process.env.DATABASE_URL) process.loadEnvFile(".env");

describe.skipIf(!enabled)("prismaFactStore against real Postgres", () => {
  const email = `it-${Date.now()}@example.test`;
  const other = `it-other-${Date.now()}@example.test`;
  let userId: string;
  let otherId: string;
  let prisma: typeof import("@/lib/prisma").prisma;
  let prismaFactStore: typeof import("@/lib/fact-store").prismaFactStore;
  let getOrGenerateFact: typeof import("@/lib/facts").getOrGenerateFact;

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    ({ prismaFactStore } = await import("@/lib/fact-store"));
    ({ getOrGenerateFact } = await import("@/lib/facts"));
    userId = (await prisma.user.create({ data: { email } })).id;
    otherId = (await prisma.user.create({ data: { email: other } })).id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: [email, other] } } });
    await prisma.$disconnect();
  });

  const run = (uid: string, generate: (t: string) => Promise<string>) =>
    getOrGenerateFact({ userId: uid, movieTitle: "Heat", store: prismaFactStore, generate });

  it("5 concurrent requests -> exactly one generation, one row, same fact", async () => {
    const generate = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 300));
      return "live fact";
    });

    const results = await Promise.all(Array.from({ length: 5 }, () => run(userId, generate)));

    expect(generate).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((r) => r.fact.id)).size).toBe(1);
    expect(results.filter((r) => r.source === "generated")).toHaveLength(1);
    expect(await prisma.fact.count({ where: { userId } })).toBe(1);
  }, 30_000);

  it("serves cache inside the window, regenerates once the fact is >60s old (DB clock)", async () => {
    const generate = vi.fn(async () => "second fact");
    expect((await run(userId, generate)).source).toBe("cache");
    expect(generate).not.toHaveBeenCalled();

    // Age the stored fact by 61s using the DB clock.
    await prisma.$executeRaw`UPDATE "Fact" SET "createdAt" = clock_timestamp() - interval '61 seconds' WHERE "userId" = ${userId}`;

    const res = await run(userId, generate);
    expect(res.source).toBe("generated");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(await prisma.fact.count({ where: { userId } })).toBe(2);
  }, 30_000);

  it("falls back to the newest stale fact when generation fails", async () => {
    await prisma.$executeRaw`UPDATE "Fact" SET "createdAt" = clock_timestamp() - interval '120 seconds' WHERE "userId" = ${userId}`;
    const res = await run(userId, async () => {
      throw new Error("openai down");
    });
    expect(res.source).toBe("stale");
  }, 30_000);

  it("never shares facts across users", async () => {
    const res = await run(otherId, async () => "other user's own fact");
    expect(res.source).toBe("generated");
    expect(res.fact.content).toBe("other user's own fact");
  }, 30_000);
});
