import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticateAdminWithShop } from "../lib/auth/with-shop";
import { ingestOrderForShop } from "../lib/orders/ingest";

interface OrdersBackfillResponse {
  data: {
    orders: {
      edges: Array<{
        cursor: string;
        node: {
          id: string;
          name: string;
          createdAt: string;
          email: string | null;
          cancelledAt: string | null;
          displayFinancialStatus: string | null;
          displayFulfillmentStatus: string | null;
          tags: string[];
          totalPriceSet: {
            shopMoney: { amount: string; currencyCode: string };
          } | null;
          customer: {
            firstName: string | null;
            lastName: string | null;
            email: string | null;
          } | null;
          lineItems: {
            edges: Array<{
              node: {
                title: string;
                product: { handle: string; title: string } | null;
              };
            }>;
          };
        };
      }>;
      pageInfo: { hasNextPage: boolean };
    };
  };
}

const BACKFILL_LIMIT = 50;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, shop } = await authenticateAdminWithShop(request);

  const response = await admin.graphql(
    `#graphql
      query BackfillOrders($first: Int!) {
        orders(first: $first, sortKey: CREATED_AT, reverse: true) {
          edges {
            cursor
            node {
              id
              name
              createdAt
              email
              cancelledAt
              displayFinancialStatus
              displayFulfillmentStatus
              tags
              totalPriceSet { shopMoney { amount currencyCode } }
              customer { firstName lastName email }
              lineItems(first: 50) {
                edges {
                  node {
                    title
                    product { handle title }
                  }
                }
              }
            }
          }
          pageInfo { hasNextPage }
        }
      }
    `,
    { variables: { first: BACKFILL_LIMIT } },
  );

  const result = (await response.json()) as OrdersBackfillResponse;
  const edges = result.data?.orders?.edges ?? [];

  let count = 0;
  for (const { node: o } of edges) {
    const customerName =
      [o.customer?.firstName, o.customer?.lastName]
        .filter((s): s is string => Boolean(s))
        .join(" ") || null;

    const numericId = o.id.replace("gid://shopify/Order/", "");

    const lineItemEdges = o.lineItems.edges;
    const tagsJoined = (o.tags ?? []).filter(Boolean).join(", ");

    await ingestOrderForShop(shop.id, {
      shopifyOrderId: numericId,
      orderName: o.name,
      customerEmail: o.customer?.email ?? o.email ?? null,
      customerName,
      financialStatus: o.displayFinancialStatus ?? null,
      fulfillmentStatus: o.displayFulfillmentStatus ?? null,
      totalPrice: o.totalPriceSet?.shopMoney.amount ?? null,
      currencyCode: o.totalPriceSet?.shopMoney.currencyCode ?? null,
      itemCount: lineItemEdges.length,
      tags: tagsJoined.length > 0 ? tagsJoined : null,
      shopifyCreatedAt: new Date(o.createdAt),
      cancelled: Boolean(o.cancelledAt),
      lineItems: lineItemEdges.map((e) => ({
        productTitle: e.node.product?.title ?? e.node.title ?? null,
        productHandle: e.node.product?.handle ?? null,
      })),
    });
    count += 1;
  }

  return json({ ok: true, count });
};
