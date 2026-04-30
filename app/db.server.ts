import { PrismaClient } from "@prisma/client";
import { tenantExtension } from "./lib/db/tenancy";

const baseClient = new PrismaClient();
const extendedClient = baseClient.$extends(tenantExtension);

declare global {
  // eslint-disable-next-line no-var
  var __prismaBase: PrismaClient | undefined;
  // eslint-disable-next-line no-var
  var __prismaExtended: typeof extendedClient | undefined;
}

if (process.env.NODE_ENV !== "production") {
  if (!global.__prismaBase) global.__prismaBase = baseClient;
  if (!global.__prismaExtended) global.__prismaExtended = extendedClient;
}

// `prismaBase` bypasses the multi-tenant extension. Use only for Shopify
// session storage and bootstrapping the Shop record. Everything else must
// use `prisma` (the extended client).
export const prismaBase: PrismaClient = global.__prismaBase ?? baseClient;
export const prisma = global.__prismaExtended ?? extendedClient;

export default prisma;
