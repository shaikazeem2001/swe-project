import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";

export default async function LandingPage() {
  const session = await auth();
  // Signed in: /dashboard decides between onboarding (first-time) and dashboard.
  if (session?.user?.id) redirect("/dashboard");

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 px-6 text-center">
      <div className="space-y-3">
        <h1 className="text-4xl font-bold tracking-tight">🎬 Movie Memory</h1>
        <p className="max-w-md text-neutral-600 dark:text-neutral-400">
          Tell us your favorite movie and we&apos;ll serve you a fun fact about it.
        </p>
      </div>

      <form
        action={async () => {
          "use server";
          await signIn("google", { redirectTo: "/dashboard" });
        }}
      >
        <button
          type="submit"
          className="rounded-lg bg-neutral-900 px-6 py-3 font-medium text-white transition hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          Sign in with Google
        </button>
      </form>
    </main>
  );
}
