import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { findShopByDomain, ingestOrderForShop } from "../lib/orders/ingest";

interface ShopifyOrderWebhook {
  id: number | string;
  name: string;
  email?: string | null;
  customer?: {
    first_name?: string | null;
    last_name?: string | null;
    email?: string | null;
  } | null;
  financial_status?: string | null;
  fulfillment_status?: string | null;
  cancelled_at?: string | null;
  created_at: string;
  total_price?: string | null;
  currency?: string | null;
  tags?: string | null;
  line_items: Array<{
    title?: string;
    name?: string;
    product_id?: number | string;
    handle?: string;
  }>;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  const order = payload as ShopifyOrderWebhook;
  console.log(`[webhook] ${topic} for ${shop} order=${order.id}`);

  const shopRecord = await findShopByDomain(shop);
  if (!shopRecord) return new Response();

  const customerName = order.customer
    ? [order.customer.first_name, order.customer.last_name]
        .filter(Boolean)
        .join(" ") || null
    : null;

  const lineItems = order.line_items ?? [];

  await ingestOrderForShop(shopRecord.id, {
    shopifyOrderId: String(order.id),
    orderName: order.name,
    customerEmail: order.customer?.email ?? order.email ?? null,
    customerName,
    financialStatus: order.financial_status ?? null,
    fulfillmentStatus: order.fulfillment_status ?? null,
    totalPrice: order.total_price ?? null,
    currencyCode: order.currency ?? null,
    itemCount: lineItems.length,
    tags: order.tags && order.tags.trim().length > 0 ? order.tags : null,
    shopifyCreatedAt: new Date(order.created_at),
    cancelled: Boolean(order.cancelled_at),
    lineItems: lineItems.map((li) => ({
      productTitle: li.title ?? li.name ?? null,
      productHandle: li.handle ?? null,
    })),
  });

  return new Response();
};
