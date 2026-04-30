import { prismaBase } from "../../db.server";
import { detectProofTrigger, type LineItemForDetection } from "./trigger-detection";

// A normalized shape we accept from both webhooks (REST payload) and
// GraphQL backfill (Admin API). Keep it loose — Shopify webhooks ship
// REST-style snake_case, GraphQL ships camelCase, both feed in here.

export interface IngestOrderInput {
  shopifyOrderId: string;
  orderName: string;
  customerEmail: string | null;
  customerName: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  totalPrice: string | null;
  currencyCode: string | null;
  itemCount: number | null;
  tags: string | null;
  shopifyCreatedAt: Date;
  cancelled: boolean;
  lineItems: LineItemForDetection[];
}

export async function ingestOrderForShop(
  shopId: string,
  input: IngestOrderInput,
): Promise<void> {
  const { proofRequested, proofPaid } = detectProofTrigger(input.lineItems);

  await prismaBase.order.upsert({
    where: {
      shopId_shopifyOrderId: {
        shopId,
        shopifyOrderId: input.shopifyOrderId,
      },
    },
    create: {
      shopId,
      shopifyOrderId: input.shopifyOrderId,
      orderName: input.orderName,
      customerEmail: input.customerEmail,
      customerName: input.customerName,
      financialStatus: input.financialStatus,
      fulfillmentStatus: input.cancelled ? "cancelled" : input.fulfillmentStatus,
      totalPrice: input.totalPrice,
      currencyCode: input.currencyCode,
      itemCount: input.itemCount,
      tags: input.tags,
      shopifyCreatedAt: input.shopifyCreatedAt,
      proofRequested,
      proofPaid,
    },
    update: {
      orderName: input.orderName,
      customerEmail: input.customerEmail ?? undefined,
      customerName: input.customerName ?? undefined,
      financialStatus: input.financialStatus ?? undefined,
      fulfillmentStatus: input.cancelled ? "cancelled" : input.fulfillmentStatus ?? undefined,
      totalPrice: input.totalPrice ?? undefined,
      currencyCode: input.currencyCode ?? undefined,
      itemCount: input.itemCount ?? undefined,
      tags: input.tags ?? undefined,
      proofRequested,
      proofPaid,
    },
  });
}

export async function findShopByDomain(shopifyDomain: string) {
  return prismaBase.shop.findUnique({ where: { shopifyDomain } });
}
