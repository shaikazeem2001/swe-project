import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/prisma";

// Reads AUTH_SECRET, AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET from the environment.
export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  // JWT sessions: the cookie is signed + encrypted with AUTH_SECRET, so we don't
  // need a Session table. The user is still persisted via the adapter.
  session: { strategy: "jwt" },
  providers: [Google],
  pages: { signIn: "/" },
  callbacks: {
    // With the adapter, token.sub is our User.id. Expose it on the session so
    // server code can read the authenticated user id. It comes from the signed
    // cookie, never from the client's request body.
    session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      return session;
    },
  },
});
