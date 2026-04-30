import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma } from "@prisma/client";

type TenantContext = { shopId: string };

const tenantStore = new AsyncLocalStorage<TenantContext>();

export function runWithTenant<T>(shopId: string, fn: () => T): T {
  return tenantStore.run({ shopId }, fn);
}

export function currentShopId(): string | undefined {
  return tenantStore.getStore()?.shopId;
}

export class MissingTenantContextError extends Error {
  constructor(model: string, operation: string) {
    super(
      `[multi-tenant] ${model}.${operation} ran outside a tenant context. ` +
        `Wrap the call site in runWithTenant(shopId, ...).`,
    );
    this.name = "MissingTenantContextError";
  }
}

// Models that bypass tenant injection. Session is owned by Shopify's session
// storage. Shop *is* the tenant root; callers identify it by shopifyDomain.
const TENANT_BYPASS_MODELS = new Set(["Session", "Shop"]);

export const tenantExtension = Prisma.defineExtension({
  name: "multiTenant",
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (!model || TENANT_BYPASS_MODELS.has(model)) {
          return query(args);
        }

        const shopId = currentShopId();
        if (!shopId) {
          throw new MissingTenantContextError(model, operation);
        }

        const a = args as Record<string, unknown>;

        switch (operation) {
          case "findFirst":
          case "findFirstOrThrow":
          case "findMany":
          case "findUnique":
          case "findUniqueOrThrow":
          case "count":
          case "aggregate":
          case "groupBy":
          case "update":
          case "updateMany":
          case "delete":
          case "deleteMany":
            a.where = { ...(a.where as object | undefined), shopId };
            break;

          case "create":
            a.data = { ...(a.data as object | undefined), shopId };
            break;

          case "createMany":
          case "createManyAndReturn":
            if (Array.isArray(a.data)) {
              a.data = (a.data as Array<Record<string, unknown>>).map((d) => ({
                ...d,
                shopId,
              }));
            } else {
              a.data = { ...(a.data as object | undefined), shopId };
            }
            break;

          case "upsert":
            a.where = { ...(a.where as object | undefined), shopId };
            a.create = { ...(a.create as object | undefined), shopId };
            break;

          default:
            // Operations we don't recognize fall through with no injection.
            // Raw SQL ($queryRaw, $executeRaw) is not intercepted here.
            break;
        }

        return query(args);
      },
    },
  },
});
