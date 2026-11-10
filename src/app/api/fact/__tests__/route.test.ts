import { beforeEach, describe, expect, it, vi } from "vitest";

// Route-level authorization tests. Everything the route talks to is mocked, so
// these verify only WHO the route acts on behalf of.
const authMock = vi.hoisted(() => vi.fn());
const findMovie = vi.hoisted(() => vi.fn());
const getOrGenerate = vi.hoisted(() => vi.fn());

vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/prisma", () => ({ prisma: { favoriteMovie: { findUnique: findMovie } } }));
vi.mock("@/lib/fact-store", () => ({ prismaFactStore: {} }));
vi.mock("@/lib/openai", () => ({ generateMovieFact: vi.fn() }));
vi.mock("@/lib/facts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/facts")>()),
  getOrGenerateFact: getOrGenerate,
}));

import { GET } from "@/app/api/fact/route";
import { FactUnavailableError } from "@/lib/facts";

const FACT = { id: "f1", content: "hello", createdAt: new Date("2026-01-01T00:00:00Z") };

describe("GET /api/fact — authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 and touches nothing when not signed in", async () => {
    authMock.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(401);
    expect(findMovie).not.toHaveBeenCalled();
    expect(getOrGenerate).not.toHaveBeenCalled();
  });

  it("acts only on the session user's id and that user's own movie", async () => {
    authMock.mockResolvedValue({ user: { id: "user-b" } });
    findMovie.mockResolvedValue({ title: "Heat" });
    getOrGenerate.mockResolvedValue({ fact: FACT, source: "generated" });

    const res = await GET(); // the handler accepts no userId from the client at all

    expect(res.status).toBe(200);
    expect(findMovie).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-b" } }),
    );
    expect(getOrGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-b", movieTitle: "Heat" }),
    );
  });

  it("returns 409 when onboarding is not finished", async () => {
    authMock.mockResolvedValue({ user: { id: "user-c" } });
    findMovie.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(409);
    expect(getOrGenerate).not.toHaveBeenCalled();
  });

  it("returns a friendly 503 (no internals leaked) when no fact can be produced", async () => {
    authMock.mockResolvedValue({ user: { id: "user-a" } });
    findMovie.mockResolvedValue({ title: "Heat" });
    getOrGenerate.mockRejectedValue(new FactUnavailableError({ cause: new Error("sk-secret leaked?") }));

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.error).toMatch(/try again/i);
    expect(JSON.stringify(body)).not.toContain("sk-secret");
  });
});
