import { json, type LoaderFunctionArgs } from "@remix-run/node";

import { withTenant } from "../lib/auth/with-shop";
import prisma from "../db.server";

// The not-fulfilled / not-cancelled OR has to live inside an AND clause —
// spreading it into a sibling where: { ...ACTIVE_ORDER_WHERE, OR: [...] }
// would overwrite the OR with the second list, silently dropping the
// active-only filter. That bug is what made `awaitingProofOrders` count
// fulfilled orders too (646 instead of ~355).
const ACTIVE_ORDER_FULFILLMENT = [
  {
    OR: [
      { fulfillmentStatus: null },
      {
        fulfillmentStatus: {
          notIn: [
            "fulfilled",
            "FULFILLED",
            "cancelled",
            "CANCELLED",
            "restocked",
            "RESTOCKED",
          ],
        },
      },
    ],
  },
];

const ACTIVE_ORDER_WHERE = {
  proofRequested: true,
  AND: ACTIVE_ORDER_FULFILLMENT,
};

const DAY_MS = 24 * 60 * 60 * 1000;

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS));
}

// JSON-only loader that the PatchSensei mega-component fetches via
// useFetcher to render the proofs-analytics blocks inside the Home
// and Analytics tabs. Keeping the loader logic outside the components
// module so it can also be reused by a standalone analytics route
// later if needed.
export const loader = async ({ request }: LoaderFunctionArgs) =>
  withTenant(request, async () => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * DAY_MS);

    const [
      activeOrders,
      awaitingProofOrders,
      draftedProofs,
      awaitingCustomerProofs,
      revisionsRequestedProofs,
      approvedProofs30dList,
      approvedTotal,
      oldestAwaitingProofOrders,
      oldestAwaitingReviewOrders,
    ] = await Promise.all([
      prisma.order.count({ where: ACTIVE_ORDER_WHERE }),
      prisma.order.count({
        where: {
          proofRequested: true,
          AND: [
            ...ACTIVE_ORDER_FULFILLMENT,
            {
              OR: [
                { proofs: { none: {} } },
                { proofs: { every: { status: "AWAITING_PROOF" } } },
              ],
            },
          ],
        },
      }),
      prisma.proof.count({
        where: { status: "DRAFTED", order: ACTIVE_ORDER_WHERE },
      }),
      prisma.proof.count({
        where: {
          status: { in: ["AWAITING_CUSTOMER", "SENT_TO_CUSTOMER"] },
          order: ACTIVE_ORDER_WHERE,
        },
      }),
      prisma.proof.count({
        where: { status: "REVISIONS_REQUESTED", order: ACTIVE_ORDER_WHERE },
      }),
      prisma.proof.findMany({
        where: { status: "APPROVED", updatedAt: { gte: thirtyDaysAgo } },
        select: { updatedAt: true },
      }),
      prisma.proof.count({ where: { status: "APPROVED" } }),
      prisma.order.findMany({
        where: {
          proofRequested: true,
          AND: [
            ...ACTIVE_ORDER_FULFILLMENT,
            {
              OR: [
                { proofs: { none: {} } },
                { proofs: { every: { status: "AWAITING_PROOF" } } },
              ],
            },
          ],
        },
        select: {
          id: true,
          orderName: true,
          customerName: true,
          customerEmail: true,
          shopifyCreatedAt: true,
        },
        orderBy: { shopifyCreatedAt: "asc" },
        take: 5,
      }),
      prisma.order.findMany({
        where: {
          proofRequested: true,
          AND: ACTIVE_ORDER_FULFILLMENT,
          proofs: {
            some: {
              status: { in: ["AWAITING_CUSTOMER", "SENT_TO_CUSTOMER"] },
            },
          },
        },
        select: {
          id: true,
          orderName: true,
          customerName: true,
          customerEmail: true,
          customerReviewSentAt: true,
          shopifyCreatedAt: true,
        },
        orderBy: { customerReviewSentAt: "asc" },
        take: 5,
      }),
    ]);

    const buckets = new Map<string, number>();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now.getTime() - i * DAY_MS);
      d.setHours(0, 0, 0, 0);
      buckets.set(dateKey(d), 0);
    }
    for (const p of approvedProofs30dList) {
      const k = dateKey(p.updatedAt);
      if (buckets.has(k)) buckets.set(k, (buckets.get(k) ?? 0) + 1);
    }
    const dailyApprovals = Array.from(buckets.entries()).map(
      ([date, count]) => ({ date, count }),
    );

    return json({
      activeOrders,
      awaitingProofOrders,
      draftedProofs,
      awaitingCustomerProofs,
      revisionsRequestedProofs,
      approvedProofs30d: approvedProofs30dList.length,
      approvedTotal,
      dailyApprovals,
      bottlenecks: {
        awaitingProof: oldestAwaitingProofOrders.map((o) => ({
          id: o.id,
          orderName: o.orderName,
          customerName: o.customerName,
          customerEmail: o.customerEmail,
          daysWaiting: daysBetween(o.shopifyCreatedAt, now),
        })),
        awaitingReview: oldestAwaitingReviewOrders.map((o) => ({
          id: o.id,
          orderName: o.orderName,
          customerName: o.customerName,
          customerEmail: o.customerEmail,
          daysWaiting: daysBetween(
            o.customerReviewSentAt ?? o.shopifyCreatedAt,
            now,
          ),
        })),
      },
    });
  });
