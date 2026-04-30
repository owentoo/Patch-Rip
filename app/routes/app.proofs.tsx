import { useEffect, useMemo } from "react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData, useNavigate } from "@remix-run/react";
import {
  Card,
  IndexTable,
  Text,
  Badge,
  ChoiceList,
  Filters,
  Button,
  EmptyState,
  InlineStack,
  BlockStack,
  Box,
  type IndexTableProps,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";

import { withTenant } from "../lib/auth/with-shop";
import prisma from "../db.server";
import { isDevMode } from "../lib/env";
import {
  PROOF_STATUS_LABEL,
  PROOF_STATUS_TONE,
  deriveOrderProofStatus,
  type ProofStatus,
} from "../lib/proofs/status-display";
import { HeaderShell } from "../lib/header-shell";
import orderDetailStyles from "../styles/order-detail.css?url";

export const links = () => [{ rel: "stylesheet", href: orderDetailStyles }];

interface DashboardOrder {
  id: string;
  shopifyOrderId: string;
  orderName: string;
  customerName: string | null;
  customerEmail: string | null;
  fulfillmentStatus: string | null;
  proofRequested: boolean;
  proofPaid: boolean;
  proofStatus: string;
  totalPrice: string | null;
  currencyCode: string | null;
  itemCount: number | null;
  tags: string[];
  shopifyCreatedAt: string;
  lastActivityBy: string | null;
}

const PAGE_SIZE = 50;

export const loader = async ({ request }: LoaderFunctionArgs) =>
  withTenant(request, async ({ shop }) => {
    const url = new URL(request.url);
    const status = url.searchParams.get("status") ?? "";
    const q = url.searchParams.get("q")?.trim() ?? "";
    const pageRaw = parseInt(url.searchParams.get("page") ?? "1", 10);
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;

    // Default ("inbox") view hides fulfilled/cancelled orders. Same
    // for the action-needed status filters — once an order is
    // fulfilled, the proof flow is moot regardless of the proof's
    // recorded state. Only show fulfilled when the user is looking at
    // a terminal historical view (APPROVED / CANCELLED).
    const where: Record<string, unknown> = { proofRequested: true, AND: [] };
    const hasStatusFilter =
      Boolean(status) && Boolean(PROOF_STATUS_LABEL[status as ProofStatus]);
    const isHistoricalStatus = status === "APPROVED" || status === "CANCELLED";
    const hideFulfilled = !isHistoricalStatus;
    if (hideFulfilled) {
      (where.AND as unknown[]).push({
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
      });
    }
    if (hasStatusFilter) {
      // AWAITING_PROOF includes orders with no proofs yet (proofs.none
      // is true) plus ones whose proofs are all AWAITING.
      if (status === "AWAITING_PROOF") {
        (where.AND as unknown[]).push({
          OR: [
            { proofs: { none: {} } },
            { proofs: { every: { status: "AWAITING_PROOF" } } },
          ],
        });
      } else {
        where.proofs = { some: { status } };
      }
    }
    if (q) {
      (where.AND as unknown[]).push({
        OR: [
          { orderName: { contains: q, mode: "insensitive" } },
          { customerName: { contains: q, mode: "insensitive" } },
          { customerEmail: { contains: q, mode: "insensitive" } },
        ],
      });
    }

    const [orders, matchingCount, totalProofRequested] = await Promise.all([
      prisma.order.findMany({
        where,
        include: { proofs: { select: { status: true } } },
        orderBy: [{ proofPaid: "desc" }, { shopifyCreatedAt: "desc" }],
        take: PAGE_SIZE,
        skip: (page - 1) * PAGE_SIZE,
      }),
      prisma.order.count({ where }),
      prisma.order.count({ where: { proofRequested: true } }),
    ]);

    const dashboardOrders: DashboardOrder[] = orders.map((o) => ({
      id: o.id,
      shopifyOrderId: o.shopifyOrderId,
      orderName: o.orderName,
      customerName: o.customerName,
      customerEmail: o.customerEmail,
      fulfillmentStatus: o.fulfillmentStatus,
      proofRequested: o.proofRequested,
      proofPaid: o.proofPaid,
      proofStatus: deriveOrderProofStatus(o.proofs.map((p) => p.status)),
      totalPrice: o.totalPrice,
      currencyCode: o.currencyCode,
      itemCount: o.itemCount,
      tags: (o.tags ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      shopifyCreatedAt: o.shopifyCreatedAt.toISOString(),
      lastActivityBy: o.lastActivityByStaffId,
    }));

    return {
      orders: dashboardOrders,
      shopDomain: shop.shopifyDomain,
      totalProofRequested,
      matchingCount,
      page,
      pageSize: PAGE_SIZE,
      activeStatus: status,
      activeQuery: q,
      devMode: isDevMode(),
    };
  });

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatTotal(amount: string | null, currency: string | null): string {
  if (!amount) return "—";
  const n = Number(amount);
  if (Number.isFinite(n) && currency) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
      }).format(n);
    } catch {
      return `${currency} ${amount}`;
    }
  }
  return amount;
}

const FULFILLMENT_LABEL: Record<string, string> = {
  FULFILLED: "Fulfilled",
  fulfilled: "Fulfilled",
  PARTIALLY_FULFILLED: "Partially fulfilled",
  partial: "Partially fulfilled",
  UNFULFILLED: "Unfulfilled",
  unfulfilled: "Unfulfilled",
  ON_HOLD: "On hold",
  SCHEDULED: "Scheduled",
  RESTOCKED: "Restocked",
  cancelled: "Cancelled",
};

const FULFILLMENT_TONE: Record<
  string,
  "info" | "success" | "warning" | "attention" | "critical" | undefined
> = {
  FULFILLED: "success",
  fulfilled: "success",
  PARTIALLY_FULFILLED: "warning",
  partial: "warning",
  UNFULFILLED: "attention",
  unfulfilled: "attention",
  ON_HOLD: "warning",
  SCHEDULED: "info",
  RESTOCKED: undefined,
  cancelled: "critical",
};

function fulfillmentDisplay(s: string | null): {
  label: string;
  tone:
    | "info"
    | "success"
    | "warning"
    | "attention"
    | "critical"
    | undefined;
} {
  if (!s) return { label: "Unfulfilled", tone: "attention" };
  return {
    label: FULFILLMENT_LABEL[s] ?? s,
    tone: FULFILLMENT_TONE[s],
  };
}

export default function OrdersDashboard() {
  const {
    orders,
    totalProofRequested,
    matchingCount,
    page,
    pageSize,
    activeStatus,
    activeQuery,
    devMode,
  } = useLoaderData<typeof loader>();
  const syncFetcher = useFetcher<{ ok: boolean; count: number }>();
  const shopify = useAppBridge();
  const navigate = useNavigate();

  const isSyncing = syncFetcher.state !== "idle";

  useEffect(() => {
    if (syncFetcher.state === "idle" && syncFetcher.data?.ok) {
      shopify.toast.show(`Synced ${syncFetcher.data.count} orders from Shopify`);
    }
  }, [syncFetcher.state, syncFetcher.data, shopify]);

  const onSync = () => {
    syncFetcher.submit({}, { method: "POST", action: "/app/orders/sync" });
  };

  const updateUrl = (nextStatus: string, nextQuery: string) => {
    // Filter or query change — reset to page 1.
    const params = new URLSearchParams();
    if (nextStatus) params.set("status", nextStatus);
    if (nextQuery) params.set("q", nextQuery);
    navigate(
      params.toString() ? `/app/proofs?${params.toString()}` : "/app/proofs",
      { replace: true },
    );
  };

  const goToPage = (nextPage: number) => {
    const params = new URLSearchParams();
    if (activeStatus) params.set("status", activeStatus);
    if (activeQuery) params.set("q", activeQuery);
    if (nextPage > 1) params.set("page", String(nextPage));
    navigate(
      params.toString() ? `/app/proofs?${params.toString()}` : "/app/proofs",
    );
  };

  const totalPages = Math.max(1, Math.ceil(matchingCount / pageSize));
  const rangeStart = matchingCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(matchingCount, page * pageSize);
  const hasPrevious = page > 1;
  const hasNext = page < totalPages;

  const filters = [
    {
      key: "status",
      label: "Status",
      filter: (
        <ChoiceList
          title="Status"
          titleHidden
          choices={Object.entries(PROOF_STATUS_LABEL).map(([k, label]) => ({
            label,
            value: k,
          }))}
          selected={activeStatus ? [activeStatus] : []}
          onChange={(v) => updateUrl(v[0] ?? "", activeQuery)}
        />
      ),
      shortcut: true,
    },
  ];

  const appliedFilters = activeStatus
    ? [
        {
          key: "status",
          label: `Status: ${PROOF_STATUS_LABEL[activeStatus as ProofStatus] ?? activeStatus}`,
          onRemove: () => updateUrl("", activeQuery),
        },
      ]
    : [];

  const resourceName = useMemo(
    () => ({ singular: "order", plural: "orders" }),
    [],
  );

  const rowMarkup: IndexTableProps["children"] = orders.map((o, index) => {
    const fulfillment = fulfillmentDisplay(o.fulfillmentStatus);
    const visibleTags = o.tags.slice(0, 3);
    const hiddenTagCount = Math.max(0, o.tags.length - visibleTags.length);
    return (
      <IndexTable.Row
        id={o.id}
        key={o.id}
        position={index}
        onClick={() => navigate(`/app/orders/${o.id}`)}
      >
        <IndexTable.Cell>
          <Text as="span" variant="bodyMd" fontWeight="semibold">
            {o.orderName}
          </Text>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <BlockStack gap="050">
            <Text as="span" variant="bodyMd">
              {o.customerName ?? "—"}
            </Text>
            {o.customerEmail ? (
              <Text as="span" variant="bodySm" tone="subdued">
                {o.customerEmail}
              </Text>
            ) : null}
          </BlockStack>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Badge tone={fulfillment.tone}>{fulfillment.label}</Badge>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Badge tone={PROOF_STATUS_TONE[o.proofStatus as ProofStatus]}>
            {PROOF_STATUS_LABEL[o.proofStatus as ProofStatus] ?? o.proofStatus}
          </Badge>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Text as="span" variant="bodyMd">
            {formatTotal(o.totalPrice, o.currencyCode)}
          </Text>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Text as="span" variant="bodyMd">
            {o.itemCount ?? "—"}
          </Text>
        </IndexTable.Cell>
        <IndexTable.Cell>
          {o.tags.length === 0 ? (
            <Text as="span" variant="bodySm" tone="subdued">
              —
            </Text>
          ) : (
            <InlineStack gap="100" wrap={false}>
              {visibleTags.map((t) => (
                <Badge key={t}>{t}</Badge>
              ))}
              {hiddenTagCount > 0 ? (
                <Text as="span" variant="bodySm" tone="subdued">
                  +{hiddenTagCount}
                </Text>
              ) : null}
            </InlineStack>
          )}
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Text as="span" variant="bodySm" tone="subdued">
            {formatDate(o.shopifyCreatedAt)}
          </Text>
        </IndexTable.Cell>
      </IndexTable.Row>
    );
  });

  const empty = orders.length === 0;

  return (
    <>
      <TitleBar title="PatchSensei — Proofs" />
      <HeaderShell activeTab="proofs" />
      <div className="content">
        <BlockStack gap="400">
          <Card>
            <InlineStack align="space-between" blockAlign="center" wrap>
              <BlockStack gap="050">
                <Text as="h2" variant="headingLg">
                  Proofs
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Customer proof workflow — orders that requested a custom
                  mockup, drafted, sent for review, and tracked through
                  approval or revisions.
                  {totalProofRequested > 0
                    ? ` · ${totalProofRequested} order${totalProofRequested === 1 ? "" : "s"} requested a proof`
                    : ""}
                </Text>
              </BlockStack>
              <Button
                variant="primary"
                onClick={onSync}
                loading={isSyncing}
                disabled={isSyncing}
              >
                {isSyncing ? "Syncing…" : "Sync from Shopify"}
              </Button>
            </InlineStack>
          </Card>

          {devMode ? (
            <Box
              background="bg-surface-warning"
              padding="300"
              borderRadius="200"
              borderColor="border-warning"
              borderWidth="025"
            >
              <Text as="p" variant="bodyMd">
                <strong>DEV_MODE on</strong> — emails to customers and Shopify
                tag writes are suppressed.
              </Text>
            </Box>
          ) : null}

          <Card padding="0">
            <Box padding="300">
              <Filters
                queryValue={activeQuery}
                queryPlaceholder="Search by order # or customer"
                onQueryChange={(v) => updateUrl(activeStatus, v)}
                onQueryClear={() => updateUrl(activeStatus, "")}
                onClearAll={() => updateUrl("", "")}
                filters={filters}
                appliedFilters={appliedFilters}
              />
            </Box>
            {empty ? (
              <Box padding="400">
                <EmptyState
                  heading="No orders yet"
                  action={{
                    content: isSyncing ? "Syncing…" : "Sync from Shopify",
                    onAction: onSync,
                    loading: isSyncing,
                  }}
                  image=""
                >
                  <p>
                    Pull recent orders from Shopify so they appear here. Future
                    orders will land automatically via webhooks.
                  </p>
                </EmptyState>
              </Box>
            ) : (
              <IndexTable
                resourceName={resourceName}
                itemCount={orders.length}
                selectable={false}
                headings={[
                  { title: "Order" },
                  { title: "Customer" },
                  { title: "Fulfillment Status" },
                  { title: "Proof Status" },
                  { title: "Total" },
                  { title: "Items" },
                  { title: "Tags" },
                  { title: "Created" },
                ]}
                pagination={{
                  hasNext,
                  hasPrevious,
                  onNext: () => goToPage(page + 1),
                  onPrevious: () => goToPage(page - 1),
                  label:
                    matchingCount === 0
                      ? "No orders"
                      : `${rangeStart}–${rangeEnd} of ${matchingCount}`,
                }}
              >
                {rowMarkup}
              </IndexTable>
            )}
          </Card>
        </BlockStack>
      </div>
    </>
  );
}
