import prisma, { prismaBase } from "../../db.server";
import { generateNonce, signCustomerToken } from "./token";

// Each (order, line item) pair has its own Proof.
export async function ensureProofForLineItem(args: {
  orderId: string;
  shopId: string;
  lineItemId: string;
  lineItemTitle: string;
  lineItemVariantTitle: string | null;
  lineItemQuantity: number;
  artworkUrl: string | null;
}) {
  const existing = await prisma.proof.findFirst({
    where: { orderId: args.orderId, lineItemId: args.lineItemId },
  });
  if (existing) {
    // Refresh denormalized fields on every upload in case the merchant
    // edited the line item or quantity in Shopify.
    return prisma.proof.update({
      where: { id: existing.id },
      data: {
        lineItemTitle: args.lineItemTitle,
        lineItemVariantTitle: args.lineItemVariantTitle,
        lineItemQuantity: args.lineItemQuantity,
        artworkUrl: args.artworkUrl ?? existing.artworkUrl,
      },
    });
  }
  return prisma.proof.create({
    data: {
      shopId: args.shopId,
      orderId: args.orderId,
      lineItemId: args.lineItemId,
      lineItemTitle: args.lineItemTitle,
      lineItemVariantTitle: args.lineItemVariantTitle,
      lineItemQuantity: args.lineItemQuantity,
      artworkUrl: args.artworkUrl,
      status: "AWAITING_PROOF",
    },
  });
}

export async function nextVersionNumber(proofId: string): Promise<number> {
  const last = await prisma.proofVersion.findFirst({
    where: { proofId },
    orderBy: { versionNumber: "desc" },
    select: { versionNumber: true },
  });
  return (last?.versionNumber ?? 0) + 1;
}

// Lazily create the order-level customer review nonce.
export async function ensureOrderCustomerToken(orderId: string): Promise<string> {
  const order = await prismaBase.order.findUnique({ where: { id: orderId } });
  if (!order) throw new Error(`Order ${orderId} not found`);
  if (order.signedCustomerToken) return order.signedCustomerToken;
  const nonce = generateNonce();
  await prismaBase.order.update({
    where: { id: orderId },
    data: { signedCustomerToken: nonce },
  });
  return nonce;
}

export function buildCustomerReviewUrl(args: {
  appUrl: string;
  orderId: string;
  nonce: string;
}): string {
  const token = signCustomerToken(args.orderId, args.nonce);
  return `${args.appUrl.replace(/\/$/, "")}/proof/${token}`;
}
