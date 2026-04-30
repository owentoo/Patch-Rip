import { json, redirect, type ActionFunctionArgs } from "@remix-run/node";
import { withTenant } from "../lib/auth/with-shop";
import prisma from "../db.server";
import {
  buildCustomerReviewUrl,
  ensureOrderCustomerToken,
} from "../lib/proofs/state";
import { isDevMode } from "../lib/env";

export const action = async ({ request, params }: ActionFunctionArgs) =>
  withTenant(request, async ({ shop }) => {
    const orderId = params.id;
    if (!orderId) throw new Response("Not found", { status: 404 });

    const order = await prisma.order.findFirst({
      where: { id: orderId },
      include: { proofs: { include: { currentVersion: true } } },
    });
    if (!order) throw new Response("Not found", { status: 404 });

    const form = await request.formData();
    const selectedLineItemIds = new Set(
      form.getAll("selectedLineItemIds").map(String).filter(Boolean),
    );

    let sendable = order.proofs.filter(
      (p) =>
        p.currentVersion !== null &&
        p.currentVersion.sentToCustomerAt === null &&
        p.status !== "APPROVED" &&
        p.status !== "CANCELLED",
    );
    if (selectedLineItemIds.size > 0) {
      sendable = sendable.filter((p) => selectedLineItemIds.has(p.lineItemId));
    }
    if (sendable.length === 0) {
      return json(
        {
          ok: false,
          error:
            "No line item proofs are ready to send. Upload at least one proof first, then check the line items you want to include.",
        },
        { status: 400 },
      );
    }

    const now = new Date();

    for (const p of sendable) {
      if (!p.currentVersion) continue;
      await prisma.proofVersion.update({
        where: { id: p.currentVersion.id },
        data: { sentToCustomerAt: now },
      });
      await prisma.proof.update({
        where: { id: p.id },
        data: { status: "AWAITING_CUSTOMER" },
      });
    }

    await prisma.order.update({
      where: { id: order.id },
      data: { customerReviewSentAt: now },
    });

    const nonce = await ensureOrderCustomerToken(order.id);
    const reviewUrl = buildCustomerReviewUrl({
      appUrl: process.env.SHOPIFY_APP_URL ?? "http://localhost:3000",
      orderId: order.id,
      nonce,
    });

    if (isDevMode()) {
      console.log(
        `[DEV_MODE] would email ${order.customerEmail ?? "(no email)"} for ${order.orderName} with review URL: ${reviewUrl}`,
      );
    } else {
      console.log(
        `[email] would send proof_sent_to_customer to ${order.customerEmail} (Phase D not wired yet)`,
      );
    }

    await prisma.emailLog.create({
      data: {
        shopId: shop.id,
        orderId: order.id,
        templateKey: "proof_sent_to_customer",
        toEmail: order.customerEmail ?? "(none)",
        subject: `Your proof is ready for review — ${order.orderName}`,
      },
    });

    return redirect(`/app/orders/${orderId}`);
  });
