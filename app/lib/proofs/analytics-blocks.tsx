import { useEffect } from "react";
import { Link, useFetcher } from "@remix-run/react";
import {
  Card,
  Text,
  BlockStack,
  InlineGrid,
  InlineStack,
  Box,
  Icon,
  Button,
} from "@shopify/polaris";
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  CheckCircleIcon,
  ClockIcon,
  EmailIcon,
  OrderIcon,
  SendIcon,
} from "@shopify/polaris-icons";
import type { IconProps } from "@shopify/polaris";

// Shape returned by the /app/proofs/analytics-data loader.
interface BottleneckRow {
  id: string;
  orderName: string;
  customerName: string | null;
  customerEmail: string | null;
  daysWaiting: number;
}
interface AnalyticsData {
  activeOrders: number;
  awaitingProofOrders: number;
  draftedProofs: number;
  awaitingCustomerProofs: number;
  revisionsRequestedProofs: number;
  approvedProofs30d: number;
  approvedTotal: number;
  dailyApprovals: Array<{ date: string; count: number }>;
  bottlenecks: {
    awaitingProof: BottleneckRow[];
    awaitingReview: BottleneckRow[];
  };
}

// ─── Stat card ────────────────────────────────────────────────────────────

type StatTone = "warning" | "success" | "info" | "default";

function StatCard({
  label,
  value,
  hint,
  tone = "default",
  icon,
  href,
}: {
  label: string;
  value: number;
  hint?: string;
  tone?: StatTone;
  icon: IconProps["source"];
  href?: string;
}) {
  const accentClass =
    tone === "warning"
      ? "ps-stat-warning"
      : tone === "success"
        ? "ps-stat-success"
        : "";
  const card = (
    <div className={`ps-stat-card ps-stat-card-${tone}`}>
      <div className="ps-stat-head">
        <span className={`ps-stat-icon-sm tone-${tone}`} aria-hidden>
          <Icon source={icon} />
        </span>
        {href ? (
          <span className="ps-stat-arrow" aria-hidden>
            <Icon source={ArrowRightIcon} tone="subdued" />
          </span>
        ) : null}
      </div>
      <div className="ps-stat-content">
        <Text as="span" variant="bodySm" tone="subdued">
          {label}
        </Text>
        <Text as="span" variant="heading2xl">
          <span className={accentClass}>{value.toLocaleString()}</span>
        </Text>
        {hint ? (
          <Text as="span" variant="bodySm" tone="subdued">
            {hint}
          </Text>
        ) : null}
      </div>
    </div>
  );
  if (!href) return card;
  return (
    <Link to={href} className="ps-stat-link">
      {card}
    </Link>
  );
}

// ─── Hero strip (Home-tab top) ─────────────────────────────────────────────

function HeroStrip({ actionNeeded }: { actionNeeded: number }) {
  return (
    <div className="ps-hero">
      <Card>
        <div className="ps-hero-inner">
          <BlockStack gap="100">
            <Text as="span" variant="bodyMd" tone="subdued">
              Proofs · Action needed
            </Text>
            <span className="ps-hero-number">
              {actionNeeded.toLocaleString()}
            </span>
            <Text as="span" variant="bodyMd" tone="subdued">
              {actionNeeded === 1
                ? "proof item waiting for your team"
                : "proof items waiting for your team"}
            </Text>
          </BlockStack>
          {actionNeeded > 0 ? (
            <Button variant="primary" url="/app/proofs?status=AWAITING_PROOF">
              Open inbox
            </Button>
          ) : (
            <span className="ps-hero-clear" aria-label="All clear">
              All clear
            </span>
          )}
        </div>
      </Card>
    </div>
  );
}

// ─── Pipeline bar (Home-tab top) ──────────────────────────────────────────

interface PipelineSegment {
  key: string;
  label: string;
  value: number;
  toneClass: string;
}

function PipelineBar({ segments }: { segments: PipelineSegment[] }) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">
            Proofs · Pipeline
          </Text>
          <Text as="span" variant="bodySm" tone="subdued">
            {total.toLocaleString()} total
          </Text>
        </InlineStack>
        {total === 0 ? (
          <div className="ps-pipeline-empty">
            No active proofs in the pipeline yet.
          </div>
        ) : (
          <div className="ps-pipeline-bar" role="img" aria-label="Pipeline distribution">
            {segments.map((s) =>
              s.value > 0 ? (
                <div
                  key={s.key}
                  className={`ps-pipeline-seg ${s.toneClass}`}
                  style={{ flex: s.value }}
                  title={`${s.label}: ${s.value}`}
                />
              ) : null,
            )}
          </div>
        )}
        <InlineStack gap="400" wrap>
          {segments.map((s) => (
            <span key={s.key} className="ps-pipeline-legend">
              <span className={`ps-pipeline-dot ${s.toneClass}`} />
              <span>
                {s.label} · <strong>{s.value.toLocaleString()}</strong>
              </span>
            </span>
          ))}
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

// ─── 30-day throughput chart ──────────────────────────────────────────────

function ThroughputChart({
  data,
  total,
}: {
  data: Array<{ date: string; count: number }>;
  total: number;
}) {
  const max = Math.max(1, ...data.map((d) => d.count));
  const avgPerDay = total / 30;
  const W = 600;
  const H = 120;
  const barW = W / data.length;
  const gap = 2;
  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">
            Proofs · Throughput (30 days)
          </Text>
          <Text as="span" variant="bodySm" tone="subdued">
            {total.toLocaleString()} approved · avg{" "}
            {avgPerDay.toFixed(avgPerDay >= 10 ? 0 : 1)}/day
          </Text>
        </InlineStack>
        <div className="ps-chart">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            aria-hidden
            style={{ width: "100%", height: 140 }}
          >
            {data.map((d, i) => {
              const h = (d.count / max) * (H - 8);
              return (
                <rect
                  key={d.date}
                  x={i * barW + gap}
                  y={H - h}
                  width={Math.max(1, barW - gap * 2)}
                  height={h}
                  rx={2}
                  className="ps-chart-bar"
                />
              );
            })}
          </svg>
          <div className="ps-chart-axis">
            <span>{data[0]?.date.slice(5)}</span>
            <span>Today</span>
          </div>
        </div>
      </BlockStack>
    </Card>
  );
}

// ─── Bottleneck card (oldest items per state) ─────────────────────────────

function BottleneckCard({
  title,
  rows,
  emptyText,
}: {
  title: string;
  rows: BottleneckRow[];
  emptyText: string;
}) {
  return (
    <Card>
      <BlockStack gap="200">
        <Text as="h2" variant="headingMd">
          {title}
        </Text>
        {rows.length === 0 ? (
          <Text as="p" variant="bodyMd" tone="subdued">
            {emptyText}
          </Text>
        ) : (
          <div className="ps-bottleneck-list">
            {rows.map((r) => (
              <Link
                key={r.id}
                to={`/app/orders/${r.id}`}
                className="ps-bottleneck-row"
              >
                <div className="ps-bottleneck-meta">
                  <Text as="span" variant="bodyMd" fontWeight="semibold">
                    {r.orderName}
                  </Text>
                  <Text as="span" variant="bodySm" tone="subdued">
                    {r.customerName ?? r.customerEmail ?? "—"}
                  </Text>
                </div>
                <span
                  className={`ps-bottleneck-days ${
                    r.daysWaiting >= 7 ? "stale" : ""
                  }`}
                >
                  {r.daysWaiting === 0
                    ? "today"
                    : r.daysWaiting === 1
                      ? "1 day"
                      : `${r.daysWaiting} days`}
                </span>
              </Link>
            ))}
          </div>
        )}
      </BlockStack>
    </Card>
  );
}

// ─── Wrapper components for the PatchSensei mega-component ────────────────

function useAnalyticsFetcher(active: boolean) {
  const fetcher = useFetcher<AnalyticsData>();
  useEffect(() => {
    if (active && fetcher.state === "idle" && !fetcher.data) {
      fetcher.load("/app/proofs/analytics-data");
    }
  }, [active, fetcher]);
  return fetcher;
}

/**
 * Top-of-Home overview blocks: hero "action needed" headline + the
 * segmented pipeline bar with legend. Loads its own data the first
 * time the Home tab becomes active.
 */
export function ProofsHomeOverview({ active }: { active: boolean }) {
  const fetcher = useAnalyticsFetcher(active);
  const data = fetcher.data;
  if (!data) {
    return active ? (
      <div className="ps-hero">
        <Card>
          <Text as="p" variant="bodyMd" tone="subdued">
            Loading proofs overview…
          </Text>
        </Card>
      </div>
    ) : null;
  }
  const actionNeeded =
    data.awaitingProofOrders +
    data.draftedProofs +
    data.revisionsRequestedProofs;
  const pipelineSegments: PipelineSegment[] = [
    {
      key: "AWAITING_PROOF",
      label: "Awaiting proof",
      value: data.awaitingProofOrders,
      toneClass: "tone-warning",
    },
    {
      key: "DRAFTED",
      label: "Ready to send",
      value: data.draftedProofs,
      toneClass: "tone-warning-light",
    },
    {
      key: "AWAITING_CUSTOMER",
      label: "Awaiting review",
      value: data.awaitingCustomerProofs,
      toneClass: "tone-info",
    },
    {
      key: "REVISIONS_REQUESTED",
      label: "Revisions requested",
      value: data.revisionsRequestedProofs,
      toneClass: "tone-warning-dark",
    },
  ];
  return (
    <BlockStack gap="400">
      <HeroStrip actionNeeded={actionNeeded} />
      <PipelineBar segments={pipelineSegments} />
    </BlockStack>
  );
}

/**
 * Detailed Analytics blocks: stat cards (Action Needed / Waiting on
 * Customer / Throughput), 30-day throughput chart, oldest-stuck
 * bottleneck lists. Loads its own data the first time the Analytics
 * tab becomes active.
 */
export function ProofsAnalyticsDetails({ active }: { active: boolean }) {
  const fetcher = useAnalyticsFetcher(active);
  const data = fetcher.data;
  if (!data) {
    return active ? (
      <Card>
        <Text as="p" variant="bodyMd" tone="subdued">
          Loading proofs analytics…
        </Text>
      </Card>
    ) : null;
  }
  return (
    <BlockStack gap="400">
      <Box>
        <Text as="h2" variant="headingMd">
          Proofs · Action needed
        </Text>
      </Box>
      <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="400">
        <StatCard
          icon={ClockIcon}
          label="Awaiting proof"
          value={data.awaitingProofOrders}
          hint="Orders with no proof started yet"
          tone="warning"
          href="/app/proofs?status=AWAITING_PROOF"
        />
        <StatCard
          icon={SendIcon}
          label="Ready to send"
          value={data.draftedProofs}
          hint="Drafted patches not yet emailed"
          tone="warning"
          href="/app/proofs?status=DRAFTED"
        />
        <StatCard
          icon={AlertTriangleIcon}
          label="Revisions requested"
          value={data.revisionsRequestedProofs}
          hint="Customer asked for changes"
          tone="warning"
          href="/app/proofs?status=REVISIONS_REQUESTED"
        />
      </InlineGrid>

      <Box paddingBlockStart="200">
        <Text as="h2" variant="headingMd">
          Proofs · Waiting on customer
        </Text>
      </Box>
      <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
        <StatCard
          icon={EmailIcon}
          label="Awaiting review"
          value={data.awaitingCustomerProofs}
          hint="Sent to customer, no response yet"
          tone="info"
          href="/app/proofs?status=AWAITING_CUSTOMER"
        />
        <StatCard
          icon={OrderIcon}
          label="Active orders in pipeline"
          value={data.activeOrders}
          hint="All orders requesting a proof"
          tone="info"
          href="/app/proofs"
        />
      </InlineGrid>

      <Box paddingBlockStart="200">
        <Text as="h2" variant="headingMd">
          Proofs · Throughput
        </Text>
      </Box>
      <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
        <StatCard
          icon={CheckCircleIcon}
          label="Approved (last 30 days)"
          value={data.approvedProofs30d}
          hint="Patches approved by customers"
          tone="success"
          href="/app/proofs?status=APPROVED"
        />
        <StatCard
          icon={CheckCircleIcon}
          label="Approved (all time)"
          value={data.approvedTotal}
          hint="Lifetime approvals across every customer"
          tone="success"
          href="/app/proofs?status=APPROVED"
        />
      </InlineGrid>

      <ThroughputChart
        data={data.dailyApprovals}
        total={data.approvedProofs30d}
      />

      <Box paddingBlockStart="200">
        <Text as="h2" variant="headingMd">
          Proofs · Stuck the longest
        </Text>
      </Box>
      <InlineGrid columns={{ xs: 1, lg: 2 }} gap="400">
        <BottleneckCard
          title="Awaiting proof"
          rows={data.bottlenecks.awaitingProof}
          emptyText="Nothing waiting for a proof start. Nice."
        />
        <BottleneckCard
          title="Awaiting customer review"
          rows={data.bottlenecks.awaitingReview}
          emptyText="No customers sitting on a proof right now."
        />
      </InlineGrid>
    </BlockStack>
  );
}
