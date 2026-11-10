"use server";

import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { movieTitleSchema } from "@/lib/validation";

export type OnboardingState = { error?: string; value?: string };

export async function saveFavoriteMovie(
  _prev: OnboardingState,
  formData: FormData,
): Promise<OnboardingState> {
  // Server actions are public POST endpoints: always re-check auth here.
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) redirect("/");

  const raw = formData.get("title");
  const parsed = movieTitleSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "Invalid movie title.",
      value: typeof raw === "string" ? raw : "",
    };
  }

  try {
    // userId comes from the session, never from the form.
    await prisma.favoriteMovie.create({
      data: { userId, title: parsed.data },
    });
  } catch (err) {
    // P2002 = unique violation on userId: onboarding was already completed
    // (double submit / second tab). That's fine, just continue.
    const alreadyDone =
      err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
    if (!alreadyDone) {
      console.error("saveFavoriteMovie failed", err);
      return { error: "Could not save your movie. Please try again.", value: parsed.data };
    }
  }

  redirect("/dashboard"); // outside try/catch: redirect() works by throwing
}
