import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { prismaFactStore } from "@/lib/fact-store";
import { generateMovieFact } from "@/lib/openai";
import { FactUnavailableError, getOrGenerateFact } from "@/lib/facts";

/**
 * GET /api/fact
 *
 * Takes NO user identifier from the client. The user is derived from the signed
 * session cookie, and the movie is read from that user's own row. There is
 * therefore no parameter an attacker could change to read someone else's facts.
 *
 * Responses
 *   200 { fact: { id, content, createdAt }, source: "cache" | "generated" | "stale" }
 *   401 not signed in
 *   409 signed in but onboarding not finished (no favorite movie yet)
 *   503 OpenAI failed AND there is no earlier fact to fall back to
 */
export async function GET() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return json({ error: "Unauthorized" }, 401);
  }

  const movie = await prisma.favoriteMovie.findUnique({
    where: { userId },
    select: { title: true },
  });
  if (!movie) {
    return json({ error: "Complete onboarding first" }, 409);
  }

  try {
    const { fact, source } = await getOrGenerateFact({
      userId,
      movieTitle: movie.title,
      store: prismaFactStore,
      generate: generateMovieFact,
    });
    return json({ fact, source }, 200);
  } catch (err) {
    if (err instanceof FactUnavailableError) {
      // Log the real OpenAI failure server-side (never sent to the client).
      console.error("OpenAI generation failed:", err.cause);
      return json(
        { error: "We couldn't generate a fact right now. Please try again in a moment." },
        503,
      );
    }
    console.error("GET /api/fact failed", err);
    return json({ error: "Something went wrong." }, 500);
  }
}

function json(body: unknown, status: number) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
