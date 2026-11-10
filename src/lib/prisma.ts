import "server-only";
import { PrismaClient } from "@prisma/client";

// Reuse one client across hot reloads in dev (otherwise each reload opens a
// new connection pool and you eventually exhaust Postgres connections).
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
