import { authenticate } from "../../shopify.server";
import { prismaBase } from "../../db.server";
import { runWithTenant } from "../db/tenancy";
import type { StaffMember, Shop } from "@prisma/client";

type AdminAuthResult = Awaited<ReturnType<typeof authenticate.admin>>;

export interface AdminWithShopContext extends AdminAuthResult {
  shop: Shop;
  staffMember: StaffMember | null;
}

// New token-exchange embedded auth issues offline-only sessions, so
// `auth.session.onlineAccessInfo` is null. The session token JWT still
// carries the user id in `sub`, so we extract it and fetch the staff
// member's name/email/avatar from the Admin API (cached locally).
function extractUserIdFromRequest(request: Request): string | null {
  // SSR loads ship the JWT as `?id_token=...`; fetches use the
  // `Authorization: Bearer ...` header.
  const url = new URL(request.url);
  const idToken =
    url.searchParams.get("id_token") ||
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    null;
  if (!idToken) return null;
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(
      Buffer.from(padded, "base64").toString("utf8"),
    ) as { sub?: string | number };
    return payload.sub != null ? String(payload.sub) : null;
  } catch {
    return null;
  }
}

interface AdminGqlClient {
  graphql: (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>;
}

async function fetchStaffMemberFromAdmin(
  admin: AdminGqlClient,
  userId: string,
): Promise<{ name: string | null; email: string | null } | null> {
  try {
    const res = await admin.graphql(
      `#graphql
       query StaffMember($id: ID!) {
         staffMember(id: $id) {
           id
           firstName
           lastName
           email
         }
       }`,
      { variables: { id: `gid://shopify/StaffMember/${userId}` } },
    );
    const json = (await res.json()) as {
      data?: {
        staffMember?: {
          firstName: string | null;
          lastName: string | null;
          email: string | null;
        } | null;
      };
    };
    const sm = json.data?.staffMember;
    if (!sm) return null;
    const name =
      [sm.firstName, sm.lastName].filter(Boolean).join(" ") || null;
    return { name, email: sm.email ?? null };
  } catch (err) {
    console.error("[with-shop] staffMember GraphQL fetch failed", err);
    return null;
  }
}

export async function authenticateAdminWithShop(
  request: Request,
): Promise<AdminWithShopContext> {
  const auth = await authenticate.admin(request);

  const shop = await prismaBase.shop.upsert({
    where: { shopifyDomain: auth.session.shop },
    create: { shopifyDomain: auth.session.shop },
    update: {},
  });

  // Path 1: legacy/online sessions populate associated_user directly.
  const user = auth.session.onlineAccessInfo?.associated_user;
  let staffMember: StaffMember | null = null;
  if (user) {
    const fullName =
      [user.first_name, user.last_name]
        .filter((s): s is string => Boolean(s))
        .join(" ") || null;

    staffMember = await prismaBase.staffMember.upsert({
      where: {
        shopId_shopifyStaffId: {
          shopId: shop.id,
          shopifyStaffId: String(user.id),
        },
      },
      create: {
        shopId: shop.id,
        shopifyStaffId: String(user.id),
        name: fullName,
        email: user.email ?? null,
      },
      update: {
        ...(fullName !== null ? { name: fullName } : {}),
        ...(user.email ? { email: user.email } : {}),
        lastSeenAt: new Date(),
      },
    });
  } else {
    // Path 2: token-exchange offline sessions. Extract user id from the
    // session token JWT and fetch details from the Admin API on first
    // sight, caching to the StaffMember row keyed by (shopId, userId).
    const userId = extractUserIdFromRequest(request);
    if (userId) {
      const cached = await prismaBase.staffMember.findUnique({
        where: {
          shopId_shopifyStaffId: { shopId: shop.id, shopifyStaffId: userId },
        },
      });
      if (cached?.name) {
        staffMember = await prismaBase.staffMember.update({
          where: { id: cached.id },
          data: { lastSeenAt: new Date() },
        });
      } else {
        const remote = await fetchStaffMemberFromAdmin(auth.admin, userId);
        staffMember = await prismaBase.staffMember.upsert({
          where: {
            shopId_shopifyStaffId: { shopId: shop.id, shopifyStaffId: userId },
          },
          create: {
            shopId: shop.id,
            shopifyStaffId: userId,
            name: remote?.name ?? null,
            email: remote?.email ?? null,
          },
          update: {
            ...(remote?.name ? { name: remote.name } : {}),
            ...(remote?.email ? { email: remote.email } : {}),
            lastSeenAt: new Date(),
          },
        });
      }
    }
  }

  return { ...auth, shop, staffMember };
}

// Wrap a loader/action body in the tenant context so all Prisma calls
// inside `fn` are auto-scoped to this shop by the multi-tenant extension.
export async function withTenant<T>(
  request: Request,
  fn: (ctx: AdminWithShopContext) => Promise<T>,
): Promise<T> {
  const ctx = await authenticateAdminWithShop(request);
  return runWithTenant(ctx.shop.id, () => fn(ctx));
}
