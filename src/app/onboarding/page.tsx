import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { OnboardingForm } from "./onboarding-form";

export default async function OnboardingPage() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) redirect("/");

  // Onboarding is first-time only.
  const existing = await prisma.favoriteMovie.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (existing) redirect("/dashboard");

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-6">
      <div className="w-full max-w-md space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">Welcome 👋</h1>
        <p className="text-neutral-600 dark:text-neutral-400">
          What&apos;s your favorite movie?
        </p>
      </div>
      <OnboardingForm />
    </main>
  );
}
