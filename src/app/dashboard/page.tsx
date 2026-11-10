import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { prisma } from "@/lib/prisma";
import { FactCard } from "@/components/fact-card";

export default async function DashboardPage() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) redirect("/"); // logged out -> back to the sign-in landing page

  // Read from the DB rather than trusting the JWT: always fresh, and it tells
  // us whether this is a first-time user.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      name: true,
      email: true,
      image: true,
      favoriteMovie: { select: { title: true } },
    },
  });
  if (!user) redirect("/");
  if (!user.favoriteMovie) redirect("/onboarding");

  // Google might not give us a name or a photo.
  const displayName = user.name?.trim() || user.email.split("@")[0];
  const initials = displayName.slice(0, 2).toUpperCase();

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-8 px-6 py-12">
      <header className="flex items-center gap-4">
        {user.image ? (
          // Plain <img>: avoids configuring next/image remote hosts for Google's CDN.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={user.image}
            alt=""
            width={56}
            height={56}
            referrerPolicy="no-referrer"
            className="h-14 w-14 rounded-full object-cover"
          />
        ) : (
          <div
            aria-hidden
            className="flex h-14 w-14 items-center justify-center rounded-full bg-neutral-200 font-semibold text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
          >
            {initials}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-lg font-semibold">{displayName}</p>
          <p className="truncate text-sm text-neutral-600 dark:text-neutral-400">
            {user.email}
          </p>
        </div>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/" });
          }}
        >
          <button
            type="submit"
            className="rounded-lg border border-neutral-300 px-4 py-2 text-sm transition hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Log out
          </button>
        </form>
      </header>

      <section className="space-y-1">
        <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500">
          Favorite movie
        </h2>
        <p className="text-2xl font-bold">{user.favoriteMovie.title}</p>
      </section>

      <FactCard />
    </main>
  );
}
