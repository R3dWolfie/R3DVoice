import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __r3dvoice_prisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  globalThis.__r3dvoice_prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "test" ? [] : ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__r3dvoice_prisma = prisma;
}
