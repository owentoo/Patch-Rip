import {
  Suspense,
  lazy,
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
} from "react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLocation, useNavigate, useSearchParams } from "@remix-run/react";
import { HeaderShell } from "../lib/header-shell";
import {
  ActionList,
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  Collapsible,
  Divider,
  EmptyState,
  IndexTable,
  InlineGrid,
  InlineStack,
  Modal,
  Pagination,
  Popover,
  RangeSlider,
  Select,
  SkeletonDisplayText,
  Spinner,
  Tag,
  Text,
  TextField,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
// MockupLab is the heaviest single tab (~1300 lines including swatch rules,
// state machine, polling). Lazy-load it so the chunk only ships when the
// user clicks the tab.
const MockupLab = lazy(() => import("../lib/mockup-lab"));
import { Icon, isToday } from "../lib/icons";
import { isPatchLineItem, hasAnyPatch } from "../lib/orders/patch-filter";
import {
  ProofsHomeOverview,
  ProofsAnalyticsDetails,
} from "../lib/proofs/analytics-blocks";

// Full PatchSensei dashboard — pixel-faithful port of the legacy
// dashboard.html. Layout, class names, and DOM structure mirror the legacy
// so the existing legacy.css applies 1:1. Data is loaded from the still-
// running Lambda 3 backend through the /api/* proxy in api.$.tsx.
//
// Each tab is a section that's only displayed when active (mirrors
// `.tab-content.active` in legacy). Click handlers update React state
// instead of calling the legacy `switchTab(name, btn)` global.
//
// Build order (one piece at a time, per Drew's directive):
//   1. Header                    ← done
//   2. Nav row                   ← done
//   3. Home tab                  ← pending
//   4. Overview tab              ← pending
//   5. Queue tab                 ← in-flight
//   6. Approved tab              ← pending
//   7. Analytics tab             ← pending
//   8. Settings tab              ← pending
//   9. Mockup Lab tab            ← pending
//  10. Modals (approve/can/email/image) ← pending
//  11. Toast container           ← pending

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

type Tab =
  | "home"
  | "queue"
  | "approved"
  | "analytics"
  | "settings"
  | "mockuplab";

const VENDOR_LIST = [
  "Aspire",
  "Desent",
  "Versa",
  "Master",
  "Penn",
  "Shinigan",
  "World",
  "Quality Patches",
  "Stickers",
  "Rhinestones",
];

// ─── API helpers ──────────────────────────────────────────────────────────
async function getAuthToken(): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    if (w.shopify?.idToken) return await w.shopify.idToken();
  } catch {
    /* no-op */
  }
  return null;
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getAuthToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (!headers.has("Content-Type") && init.body)
    headers.set("Content-Type", "application/json");
  const r = await fetch(path, { ...init, headers });
  if (!r.ok) throw new Error(`API error: ${r.status}`);
  return (await r.json()) as T;
}

// Download a CSV file via the auth-gated /api/export endpoint. Triggers a
// browser save-as. Returns true on success, false on failure.
async function downloadCsv(path: string, filename: string): Promise<boolean> {
  try {
    const token = await getAuthToken();
    const headers = new Headers();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const r = await fetch(path, { headers });
    if (!r.ok) return false;
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return true;
  } catch {
    return false;
  }
}

// ─── Data shapes (match Lambda 3 /api/queue) ──────────────────────────────
interface LineItem {
  title: string;
  variant?: string;
  quantity: number;
  imageUrl?: string;
  artworkUrl?: string;
  lineItemId: string;
  productId?: string;
  attributes?: Record<string, string>;
}
interface OrderRow {
  id: string;            // human order name (#PATCH-280908)
  numericId: string;
  customer: string;
  email: string;
  createdAt: string;
  tags: string[];
  summary: string;
  confidence: number;    // 0-100
  lineItems: LineItem[];
  mockupMap?: Record<string, string>;
  resolvedArtworkUrl?: Record<string, string>;
  numItems?: number;
}
interface StatsResponse {
  total: number;
  approved: number;
  review: number;        // pending review count
  can: number;
  mismatch: number;
  appRate: number;       // approval rate %
  misRate?: number;
  queue?: number;        // duplicate of review
  today: number;
  approvedToday?: number;
  reviewToday?: number;
  avgConf: number;       // avg confidence %
}
interface RecentReview {
  id: string;            // human order name (#PATCH-...)
  numericId: string;
  date: string;          // ISO timestamp
  customer: string;
  email?: string;
  product: string;
  qty: number;
  status: string;        // "APPROVED" | "CAN" | "REVIEW" | "MISMATCH"
  confidence: number;
  summary?: string;
}
// Lambda 3 v31 wraps queue + approved in a pagination envelope:
//   { orders: OrderRow[], nextCursor: string | null, hasMore: boolean }
// Older builds returned a raw array — handle both shapes defensively.
interface PaginatedOrders {
  orders?: OrderRow[];
  nextCursor?: string | null;
  hasMore?: boolean;
}
function unwrapOrders(v: PaginatedOrders | OrderRow[] | null | undefined): OrderRow[] {
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.orders)) return v.orders;
  return [];
}
function unwrapRecent(
  v: RecentReview[] | { reviews?: RecentReview[] } | null | undefined,
): RecentReview[] {
  if (Array.isArray(v)) return v;
  if (v && Array.isArray((v as { reviews?: RecentReview[] }).reviews)) {
    return (v as { reviews: RecentReview[] }).reviews;
  }
  return [];
}

// ─── AI summary formatting (port of legacy formatAISummary/splitAssessment) ─
function FormatAISummary({ text }: { text: string }) {
  if (!text) return <>No AI summary available.</>;
  const m = text.match(/Recommendation:/i);
  if (m && m.index !== undefined) {
    const head = text.slice(0, m.index);
    const tag = text.slice(m.index, m.index + m[0].length);
    const tail = text.slice(m.index + m[0].length);
    return (
      <>
        {head}
        <div className="recommendation">
          <strong>{tag}</strong> {tail}
        </div>
      </>
    );
  }
  return <>{text}</>;
}

// Split a multi-line-item AI summary into per-line-item segments by matching
// each block's first line against "ProductType (size)". Unmatched blocks go
// into the fallback string for an "Additional Notes" section.
function splitAssessment(
  summary: string,
  lineItems: LineItem[],
): { segments: Array<string | null>; fallback: string } {
  if (!summary || !lineItems || lineItems.length === 0) {
    return { segments: [], fallback: summary || "" };
  }
  const rawBlocks = summary
    .split(/\n\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  const assigned: Array<string | null> = new Array(lineItems.length).fill(null);
  const used = new Set<number>();
  lineItems.forEach((li, liIdx) => {
    const stem = li.title.replace(/\s*-\s*[\d].*/, "").trim();
    const size = li.variant || "";
    for (let b = 0; b < rawBlocks.length; b++) {
      if (used.has(b)) continue;
      const block = rawBlocks[b];
      const firstLine = block.split("\n")[0].trim();
      let matched = false;
      if (
        size &&
        firstLine.startsWith(stem) &&
        firstLine.includes("(") &&
        firstLine.includes(size)
      ) {
        matched = true;
      } else if (!size && firstLine.startsWith(stem)) {
        matched = true;
      }
      if (matched) {
        assigned[liIdx] = block;
        used.add(b);
        break;
      }
    }
  });
  const fallbackParts: string[] = [];
  rawBlocks.forEach((b, i) => {
    if (!used.has(i)) fallbackParts.push(b);
  });
  return { segments: assigned, fallback: fallbackParts.join("\n\n") };
}

// Decode the relevant line-item attributes (shape/bg/border/backing) into
// a small list of inline display strings, matching the legacy propsHtml.
function lineItemPropParts(li: LineItem): string[] {
  const props = li.attributes || {};
  const lower: Record<string, string> = {};
  Object.keys(props).forEach((ak) => {
    lower[ak.toLowerCase().trim()] = props[ak];
  });
  if (!lower["_border style"]) {
    const bsKey = Object.keys(lower).find(
      (k) => k.startsWith("_border style ") || k === "border style",
    );
    if (bsKey) lower["_border style"] = lower[bsKey];
  }
  const order: Array<[string, string]> = [
    ["_select shape", "Shape"],
    ["_patch background color", "Background"],
    ["_border thread color", "Border Color"],
    ["_border style", "Border Style"],
    ["_select your backing", "Backing"],
  ];
  const parts: string[] = [];
  order.forEach(([k]) => {
    let v = lower[k] || "";
    if (!v) return;
    try {
      v = decodeURIComponent(v.replace(/\+/g, " "));
    } catch {
      /* ignore */
    }
    v = v.trim();
    if (!v) return;
    const candidates = [v.indexOf("."), v.indexOf(",")].filter((x) => x > 0);
    if (candidates.length > 0) {
      v = v.substring(0, Math.min(...candidates)).trim();
    }
    if (v) parts.push(v);
  });
  return parts;
}

function LineItemProps({ li }: { li: LineItem }) {
  const parts = lineItemPropParts(li);
  if (parts.length === 0) return null;
  return (
    <div
      style={{
        fontSize: 11,
        color: "var(--t2)",
        fontWeight: 400,
        marginTop: 3,
        letterSpacing: 0,
      }}
    >
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 ? (
            <span style={{ opacity: 0.5, margin: "0 4px" }}>·</span>
          ) : null}
          {p}
        </span>
      ))}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────
const VALID_TABS: readonly Tab[] = [
  "home",
  "queue",
  "approved",
  "analytics",
  "settings",
  "mockuplab",
];

// Each dashboard tab has its own pathname. /app is Home; thin alias route
// files (app.queue.tsx etc.) re-export this same component so the Shopify
// admin sidebar's NavMenu can match active state by pathname.
const TAB_PATHS: Record<Tab, string> = {
  home: "/app",
  queue: "/app/queue",
  approved: "/app/approved",
  analytics: "/app/analytics",
  mockuplab: "/app/mockuplab",
  settings: "/app/settings",
};
const PATH_TO_TAB: Record<string, Tab> = {
  "/app": "home",
  "/app/": "home",
  "/app/queue": "queue",
  "/app/approved": "approved",
  "/app/analytics": "analytics",
  "/app/mockuplab": "mockuplab",
  "/app/settings": "settings",
};

export default function Dashboard() {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Pathname wins; ?tab=… stays as a back-compat fallback for old links.
  const tabFromUrl = ((): Tab => {
    const fromPath = PATH_TO_TAB[location.pathname];
    if (fromPath) return fromPath;
    const fromQuery = searchParams.get("tab");
    if (fromQuery && (VALID_TABS as readonly string[]).includes(fromQuery)) {
      return fromQuery as Tab;
    }
    return "home";
  })();
  const [tab, setTabState] = useState<Tab>(tabFromUrl);
  // Tab clicks navigate to the matching pathname so the URL reflects the
  // active tab and Shopify's NavMenu re-evaluates the highlighted item.
  const setTab = useCallback(
    (t: Tab) => {
      setTabState(t);
      navigate(TAB_PATHS[t], { preventScrollReset: true });
    },
    [navigate],
  );
  // Keep local state in sync with the URL (covers prefetch / back/forward
  // navigation triggered outside the in-app tab strip).
  useEffect(() => {
    if (tabFromUrl !== tab) setTabState(tabFromUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, searchParams]);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [queue, setQueue] = useState<OrderRow[]>([]);
  const [approved, setApproved] = useState<OrderRow[]>([]);
  const [recent, setRecent] = useState<RecentReview[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [detailReview, setDetailReview] = useState<RecentReview | null>(null);
  const shopify = useAppBridge();

  const showToast = useCallback(
    (msg: string, kind: ToastKind = "info") => {
      shopify.toast.show(msg, { isError: kind === "error" });
    },
    [shopify],
  );

  // Hydrate cached responses from sessionStorage on first paint so the
  // dashboard never feels empty between page load and the first /api/*
  // round-trip. Cache then refreshes in the background.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    try {
      const cs = window.sessionStorage.getItem("ps-cache-stats");
      if (cs) setStats(JSON.parse(cs));
      const cq = window.sessionStorage.getItem("ps-cache-queue");
      if (cq) setQueue(JSON.parse(cq));
      const ca = window.sessionStorage.getItem("ps-cache-approved");
      if (ca) setApproved(JSON.parse(ca));
      const cr = window.sessionStorage.getItem("ps-cache-recent");
      if (cr) setRecent(JSON.parse(cr));
      const lu = window.sessionStorage.getItem("ps-cache-updated");
      if (lu) setLastUpdated(new Date(Number(lu)));
    } catch {
      /* ignore */
    }
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      // /api/approved limit was 250 — that's a ~1MB JSON payload through
      // the Lambda 3 proxy on every refresh. Approved tab pages 50 at a
      // time and the badge math only needs today-counts, so 100 covers it.
      const [s, q, a, r] = await Promise.allSettled([
        apiFetch<StatsResponse>("/api/stats?range=30d"),
        apiFetch<PaginatedOrders | OrderRow[]>("/api/queue"),
        apiFetch<PaginatedOrders | OrderRow[]>("/api/approved?limit=100"),
        apiFetch<RecentReview[] | { reviews: RecentReview[] }>(
          "/api/recent?limit=20",
        ),
      ]);
      const writeCache = (k: string, v: unknown) => {
        try {
          window.sessionStorage.setItem(k, JSON.stringify(v));
        } catch {
          /* quota / private mode */
        }
      };
      let queueArr: OrderRow[] | null = null;
      let approvedArr: OrderRow[] | null = null;
      if (s.status === "fulfilled") {
        setStats(s.value);
        writeCache("ps-cache-stats", s.value);
      }
      if (q.status === "fulfilled") {
        queueArr = unwrapOrders(q.value);
        setQueue(queueArr);
        writeCache("ps-cache-queue", queueArr);
      }
      if (a.status === "fulfilled") {
        approvedArr = unwrapOrders(a.value);
        setApproved(approvedArr);
        writeCache("ps-cache-approved", approvedArr);
      }
      if (r.status === "fulfilled") {
        const u = unwrapRecent(r.value);
        setRecent(u);
        writeCache("ps-cache-recent", u);
      }
      const now = new Date();
      setLastUpdated(now);
      // Persist badge counts + last-updated to localStorage so the header
      // strip on /app/proofs and /app/orders/:id stays consistent — Drew
      // flagged the "Needs Review 41 / Approved 86" pills disappearing
      // when navigating away from the dashboard.
      try {
        window.sessionStorage.setItem(
          "ps-cache-updated",
          String(now.getTime()),
        );
        if (queueArr) {
          window.localStorage.setItem(
            "ps-badge-queue",
            String(
              queueArr
                .filter((o) => hasAnyPatch(o.lineItems || []))
                .filter((o) => isToday(o.createdAt)).length,
            ),
          );
        }
        if (approvedArr) {
          window.localStorage.setItem(
            "ps-badge-approved",
            String(
              approvedArr
                .filter((o) => hasAnyPatch(o.lineItems || []))
                .filter((o) => isToday(o.createdAt)).length,
            ),
          );
        }
        window.localStorage.setItem(
          "ps-badge-updated",
          String(now.getTime()),
        );
      } catch {
        /* ignore */
      }
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-refresh: when set to >0 seconds, re-pull data on an interval.
  // Preference persists in localStorage so it sticks across reloads.
  const [autoRefreshSec, setAutoRefreshSecState] = useState<number>(() => {
    if (typeof window === "undefined") return 0;
    const raw = window.localStorage.getItem("ps-auto-refresh-sec");
    const n = raw ? Number(raw) : 0;
    return Number.isFinite(n) && n >= 0 ? n : 0;
  });
  const setAutoRefreshSec = useCallback((s: number) => {
    setAutoRefreshSecState(s);
    try {
      window.localStorage.setItem("ps-auto-refresh-sec", String(s));
    } catch {
      /* private mode, etc. */
    }
  }, []);
  useEffect(() => {
    if (autoRefreshSec <= 0) return;
    // Skip auto-refresh while the user is on a tab that doesn't read this
    // data (Settings, Mockup Lab). Saves 4 Lambda calls every interval.
    if (tab === "settings" || tab === "mockuplab") return;
    const id = window.setInterval(() => {
      refresh();
    }, autoRefreshSec * 1000);
    return () => window.clearInterval(id);
  }, [autoRefreshSec, refresh, tab]);

  // Lazy-mount every tab. The dashboard initially renders only the tab the
  // URL points at — sibling tabs don't run their useMemos, useEffects, or
  // produce DOM. Each tab stays mounted on first visit so its local state
  // (filter inputs, expanded card, mockup-lab session, etc.) survives
  // tab-bouncing.
  const [mountedTabs, setMountedTabs] = useState<Record<Tab, boolean>>(
    () => ({
      home: tabFromUrl === "home",
      queue: tabFromUrl === "queue",
      approved: tabFromUrl === "approved",
      analytics: tabFromUrl === "analytics",
      settings: tabFromUrl === "settings",
      mockuplab: tabFromUrl === "mockuplab",
    }),
  );
  useEffect(() => {
    if (!mountedTabs[tab]) {
      setMountedTabs((s) => ({ ...s, [tab]: true }));
    }
  }, [tab, mountedTabs]);

  return (
    <>
      <HeaderShell
        activeTab={tab}
        onSelectDashboardTab={setTab}
        queueCount={
          queue
            .filter((o) => hasAnyPatch(o.lineItems || []))
            .filter((o) => isToday(o.createdAt)).length
        }
        approvedCount={
          approved
            .filter((o) => hasAnyPatch(o.lineItems || []))
            .filter((o) => isToday(o.createdAt)).length
        }
        lastUpdated={lastUpdated}
        refreshing={refreshing}
        onRefresh={() => {
          refresh();
          showToast("Refreshed.");
        }}
        autoRefreshSec={autoRefreshSec}
        onAutoRefreshChange={setAutoRefreshSec}
      />
      <div className="content">
        <HomeTab
          active={tab === "home"}
          stats={stats}
          recent={recent}
          onRowClick={setDetailReview}
        />
        <QueueTab
          active={tab === "queue"}
          orders={queue}
          onAfterAction={(verb, kind) => {
            refresh();
            showToast(verb, kind);
          }}
        />
        <ApprovedTab
          active={tab === "approved"}
          orders={approved}
          showToast={showToast}
          onAfterAction={refresh}
        />
        <AnalyticsTab
          active={tab === "analytics"}
          stats={stats}
          queue={queue}
          approved={approved}
          recent={recent}
        />
        {mountedTabs.settings ? (
          <SettingsTab active={tab === "settings"} showToast={showToast} />
        ) : null}
        {mountedTabs.mockuplab ? (
          <MockupLabTab active={tab === "mockuplab"} />
        ) : null}
      </div>

      {detailReview ? (
        <DetailModal
          review={detailReview}
          onClose={() => setDetailReview(null)}
        />
      ) : null}

    </>
  );
}

// ─── Toast type (App Bridge `shopify.toast.show` handles rendering) ────
type ToastKind = "info" | "success" | "warn" | "error";

// ─── Detail Modal (general-purpose order review summary viewer) ──────────
function DetailModal({
  review,
  onClose,
}: {
  review: RecentReview;
  onClose: () => void;
}) {
  const tone: "success" | "caution" | "critical" | undefined =
    review.confidence >= 90
      ? "success"
      : review.confidence >= 75
        ? "caution"
        : "critical";
  return (
    <Modal
      open
      onClose={onClose}
      title={`${review.id} · Review Detail`}
      primaryAction={{ content: "Close", onAction: onClose }}
      secondaryActions={[
        {
          content: "Open in Shopify",
          url: `https://admin.shopify.com/store/ninjapatches/orders/${review.numericId}`,
          external: true,
        },
      ]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <InlineGrid columns={{ xs: 1, sm: 3 }} gap="300">
            <SmallKV k="Customer" v={review.customer || "—"} />
            <SmallKV k="Product" v={review.product || "—"} />
            <SmallKV k="Confidence" v={`${review.confidence}%`} valueTone={tone} />
          </InlineGrid>
          <Box
            background="bg-surface-secondary"
            padding="300"
            borderRadius="200"
          >
            <BlockStack gap="100">
              <Text as="span" variant="bodySm" fontWeight="semibold">
                AI Assessment
              </Text>
              <Text as="p" variant="bodyMd">
                <span style={{ whiteSpace: "pre-wrap" }}>
                  {review.summary || "(no summary recorded)"}
                </span>
              </Text>
            </BlockStack>
          </Box>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

function SmallKV({
  k,
  v,
  valueTone,
}: {
  k: string;
  v: string | number;
  // Polaris Text accepts a narrower tone palette than Badge; map our
  // "warning" intent to "caution" so the type-check passes.
  valueTone?: "success" | "caution" | "critical" | "subdued";
}) {
  return (
    <BlockStack gap="050">
      <Text as="span" variant="bodySm" tone="subdued">
        {k}
      </Text>
      <Text as="span" variant="bodyMd" fontWeight="semibold" tone={valueTone}>
        {String(v)}
      </Text>
    </BlockStack>
  );
}


// ─── Home tab (Overview content merged in — stats / charts / recent) ────
function HomeTab({
  active,
  stats,
  recent,
  onRowClick,
}: {
  active: boolean;
  stats: StatsResponse | null;
  recent: RecentReview[];
  onRowClick: (r: RecentReview) => void;
}) {
  const [volume, setVolume] = useState<VolumePoint[]>([]);
  useEffect(() => {
    if (!active) return;
    (async () => {
      try {
        const v = await apiFetch<VolumeResponse | VolumePoint[]>(
          "/api/volume?days=30",
        );
        setVolume(unwrapVolume(v));
      } catch {
        setVolume([]);
      }
    })();
  }, [active]);

  return (
    <div className={`tab-content${active ? " active" : ""}`}>
      <BlockStack gap="400">
        {/* Proofs overview — hero "action needed" + segmented pipeline bar. */}
        <ProofsHomeOverview active={active} />

        <Card>
          <BlockStack gap="300">
            <BlockStack gap="050">
              <Text as="h3" variant="headingMd">
                Artwork Review · Today&rsquo;s snapshot
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                AI artwork-review pipeline — separate from the proofs
                workflow above.
              </Text>
            </BlockStack>
            <InlineGrid columns={{ xs: 2, sm: 3, md: 5 }} gap="300">
              <StatCard
                label="Total Reviewed"
                value={stats?.total ?? "--"}
                loading={!stats}
              />
              <StatCard
                label="Approval Rate"
                value={stats?.appRate != null ? `${stats.appRate}%` : "--"}
                tone="success"
                loading={!stats}
              />
              <StatCard
                label="Pending Review"
                value={stats?.review ?? "--"}
                tone="caution"
                loading={!stats}
              />
              <StatCard
                label="Mismatch"
                value={stats?.mismatch ?? "--"}
                tone="critical"
                loading={!stats}
                sub="Flagged for review"
              />
              <StatCard
                label="Avg Confidence"
                value={stats?.avgConf != null ? `${stats.avgConf}%` : "--"}
                loading={!stats}
              />
            </InlineGrid>
          </BlockStack>
        </Card>

        <InlineGrid columns={{ xs: 1, lg: ["twoThirds", "oneThird"] }} gap="400">
          <Card>
            <BlockStack gap="300">
              <BlockStack gap="050">
                <Text as="h3" variant="headingMd">
                  Artwork Review · Review trends
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Daily review outcomes — last 30 days
                </Text>
              </BlockStack>
              <DailyVolumeChart points={volume} />
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="300">
              <BlockStack gap="050">
                <Text as="h3" variant="headingMd">
                  Artwork Review · Status breakdown
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  All-time distribution
                </Text>
              </BlockStack>
              <StatusPieChart stats={stats} />
            </BlockStack>
          </Card>
        </InlineGrid>

        <Card padding="0">
          <Box padding="400" paddingBlockEnd="0">
            <InlineStack align="space-between" blockAlign="center">
              <BlockStack gap="050">
                <Text as="h3" variant="headingMd">
                  Artwork Review · Recent decisions
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Click any row to view AI summary
                </Text>
              </BlockStack>
              <Button
                onClick={() =>
                  downloadCsv(
                    "/api/export?range=30d",
                    `patchsensei-recent-${new Date()
                      .toISOString()
                      .slice(0, 10)}.csv`,
                  )
                }
              >
                Export Recent
              </Button>
            </InlineStack>
          </Box>
          <IndexTable
            resourceName={{ singular: "review", plural: "reviews" }}
            itemCount={recent.length}
            selectable={false}
            headings={[
              { title: "Order" },
              { title: "Customer" },
              { title: "Product Type" },
              { title: "Qty" },
              { title: "Status" },
              { title: "Confidence" },
              { title: "Time" },
            ]}
            emptyState={
              <Box padding="600">
                <Text as="p" variant="bodyMd" tone="subdued" alignment="center">
                  No recent reviews.
                </Text>
              </Box>
            }
          >
            {recent.map((r, i) => (
              <IndexTable.Row
                id={r.numericId}
                key={r.numericId}
                position={i}
                onClick={() => onRowClick(r)}
              >
                <IndexTable.Cell>
                  <Text as="span" variant="bodyMd" fontWeight="semibold">
                    {r.id}
                  </Text>
                </IndexTable.Cell>
                <IndexTable.Cell>{r.customer}</IndexTable.Cell>
                <IndexTable.Cell>{r.product}</IndexTable.Cell>
                <IndexTable.Cell>{r.qty}</IndexTable.Cell>
                <IndexTable.Cell>
                  <Badge
                    tone={
                      r.status === "APPROVED" ||
                      r.status === "PATCHSENSEI-APPROVED"
                        ? "success"
                        : r.status === "CAN" ||
                            r.status === "PATCHSENSEI-CAN" ||
                            r.status === "MISMATCH"
                          ? "critical"
                          : "attention"
                    }
                  >
                    {r.status}
                  </Badge>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <Text
                    as="span"
                    variant="bodyMd"
                    fontWeight="semibold"
                    tone={
                      r.confidence >= 90
                        ? "success"
                        : r.confidence >= 75
                          ? "caution"
                          : "critical"
                    }
                  >
                    {`${r.confidence}%`}
                  </Text>
                </IndexTable.Cell>
                <IndexTable.Cell>{relativeTime(r.date)}</IndexTable.Cell>
              </IndexTable.Row>
            ))}
          </IndexTable>
        </Card>
      </BlockStack>
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
  sub,
  loading,
}: {
  label: string;
  value: number | string;
  tone?: "success" | "caution" | "critical" | "subdued";
  sub?: string;
  loading?: boolean;
}) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="span" variant="bodySm" tone="subdued">
          {label}
        </Text>
        {loading ? (
          <SkeletonDisplayText size="medium" />
        ) : (
          <Text as="span" variant="heading2xl" tone={tone}>
            {String(value)}
          </Text>
        )}
        {sub ? (
          <Text as="span" variant="bodySm" tone="subdued">
            {sub}
          </Text>
        ) : null}
      </BlockStack>
    </Card>
  );
}

// ─── Piece 5: Queue tab ───────────────────────────────────────────────────
function QueueTab({
  active,
  orders,
  onAfterAction,
}: {
  active: boolean;
  orders: OrderRow[];
  onAfterAction: (verb: string, kind?: ToastKind) => void;
}) {
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [modal, setModal] = useState<
    | { kind: "approve" | "can" | "email"; order: OrderRow }
    | { kind: "image"; src: string; title: string }
    | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [nfOnly, setNfOnly] = useState(false);
  const [dsOnly, setDsOnly] = useState(false);
  const [sortNewest, setSortNewest] = useState(true);
  const [productFilter, setProductFilter] = useState("");
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  // Drop supply-only orders from the artwork-review pipeline. The Lambda 3
  // backend gives us everything that triggered a review; we strip orders
  // whose line items are 100% supplies (heat tape / placement guides /
  // billing markers) so reps don't see fake-mismatch reviews caused by
  // line items the AI was never going to assess.
  const patchOrders = useMemo(
    () => orders.filter((o) => hasAnyPatch(o.lineItems || [])),
    [orders],
  );

  // Queue stats — pending count, oldest in queue, avg wait, resolved today
  const queueStats = useMemo(() => {
    if (patchOrders.length === 0)
      return { pending: 0, oldest: "--", avgWait: "--", resolvedToday: 0 };
    const now = Date.now();
    const ages = patchOrders
      .map((o) => now - new Date(o.createdAt).getTime())
      .filter((a) => a > 0);
    const oldestMs = Math.max(...ages);
    const avgMs =
      ages.length > 0 ? ages.reduce((a, b) => a + b, 0) / ages.length : 0;
    const fmt = (ms: number) => {
      const h = ms / 3600000;
      if (h < 1) return `${Math.round(ms / 60000)}m`;
      if (h < 24) return `${Math.round(h)}h`;
      return `${Math.round(h / 24)}d`;
    };
    return {
      pending: patchOrders.length,
      oldest: fmt(oldestMs),
      avgWait: fmt(avgMs),
      resolvedToday: 0, // wired to /api/stats todayCount in callers if needed
    };
  }, [patchOrders]);

  const productTypes = useMemo(() => {
    const set = new Set<string>();
    for (const o of patchOrders) {
      for (const li of o.lineItems) {
        if (isPatchLineItem(li)) set.add(li.title);
      }
    }
    return Array.from(set).sort();
  }, [patchOrders]);

  const filtered = useMemo(() => {
    let list = patchOrders;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (o) =>
          o.id.toLowerCase().includes(q) ||
          o.customer.toLowerCase().includes(q) ||
          (o.email || "").toLowerCase().includes(q) ||
          o.lineItems.some((li) => li.title.toLowerCase().includes(q)),
      );
    }
    if (nfOnly) list = list.filter((o) => o.tags.some((t) => t.toLowerCase() === "ninjafast"));
    if (dsOnly)
      list = list.filter((o) =>
        o.tags.some((t) => t.toLowerCase() === "direct ship to customer"),
      );
    if (productFilter)
      list = list.filter((o) =>
        o.lineItems.some((li) => li.title === productFilter),
      );
    list = [...list].sort((a, b) => {
      const ta = new Date(a.createdAt).getTime();
      const tb = new Date(b.createdAt).getTime();
      return sortNewest ? tb - ta : ta - tb;
    });
    return list;
  }, [orders, search, nfOnly, dsOnly, productFilter, sortNewest]);

  const submit = async (
    intent: "approve" | "can",
    order: OrderRow,
  ) => {
    setBusy(true);
    try {
      await apiFetch(`/api/${intent}`, {
        method: "POST",
        body: JSON.stringify({ numericId: order.numericId, orderId: order.id }),
      });
      setModal(null);
      onAfterAction(
        intent === "approve"
          ? `${order.id} approved — tags updated, mockup queued.`
          : `${order.id} marked as Customer Action Needed.`,
        intent === "approve" ? "success" : "warn",
      );
    } catch (e) {
      console.error(`${intent} failed:`, e);
    } finally {
      setBusy(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pagedFiltered = filtered.slice(
    safePage * PAGE_SIZE,
    (safePage + 1) * PAGE_SIZE,
  );

  return (
    <div className={`tab-content${active ? " active" : ""}`}>
      <BlockStack gap="400">
        <InlineGrid columns={{ xs: 2, sm: 4 }} gap="300">
          <StatCard
            label="Pending Reviews"
            value={queueStats.pending}
            tone="caution"
            sub="Orders needing attention"
          />
          <StatCard
            label="Oldest in Queue"
            value={queueStats.oldest}
            tone="critical"
            sub="Longest wait time"
          />
          <StatCard
            label="Avg Wait Time"
            value={queueStats.avgWait}
            sub="Time in queue"
          />
          <StatCard
            label="Total Pending"
            value={orders.length}
            sub="All orders awaiting review"
          />
        </InlineGrid>

        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="start" wrap>
              <BlockStack gap="050">
                <Text as="h3" variant="headingMd">
                  Orders Awaiting Human Review
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Expand an order to see artwork, mockup, and take action
                </Text>
              </BlockStack>
              <InlineStack gap="200">
                <Button onClick={() => setSortNewest((v) => !v)}>
                  {sortNewest ? "Newest First" : "Oldest First"}
                </Button>
                <Button
                  onClick={() =>
                    downloadCsv(
                      "/api/export?range=30d&type=queue",
                      `patchsensei-queue-${new Date()
                        .toISOString()
                        .slice(0, 10)}.csv`,
                    )
                  }
                >
                  Export Queue
                </Button>
              </InlineStack>
            </InlineStack>

            <InlineStack gap="200" blockAlign="end" wrap>
              <div style={{ flex: "1 1 200px", minWidth: 200 }}>
                <TextField
                  label="Search"
                  labelHidden
                  placeholder="Search by order number…"
                  value={search}
                  onChange={setSearch}
                  autoComplete="off"
                  clearButton
                  onClearButtonClick={() => setSearch("")}
                />
              </div>
              <div style={{ flex: "0 0 220px" }}>
                <Select
                  label="Product type"
                  labelHidden
                  options={[
                    { label: "All product types", value: "" },
                    ...productTypes.map((p) => ({ label: p, value: p })),
                  ]}
                  value={productFilter}
                  onChange={setProductFilter}
                />
              </div>
              <Button
                pressed={nfOnly}
                onClick={() => setNfOnly((v) => !v)}
              >
                NinjaFast
              </Button>
              <Button
                pressed={dsOnly}
                onClick={() => setDsOnly((v) => !v)}
              >
                Direct Ship
              </Button>
            </InlineStack>

            {patchOrders.length > 0 ? (
              <Text as="p" variant="bodySm" tone="subdued">
                Showing <strong>{filtered.length}</strong> of{" "}
                {patchOrders.length} pending patch order
                {patchOrders.length === 1 ? "" : "s"}
                {filtered.length !== patchOrders.length
                  ? " (filters active)"
                  : ""}
              </Text>
            ) : null}

            {filtered.length === 0 ? (
              <Box padding="600">
                <BlockStack gap="200" inlineAlign="center">
                  <Text as="p" variant="headingLg">
                    Queue is clear!
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    All orders have been reviewed.
                  </Text>
                </BlockStack>
              </Box>
            ) : (
              <BlockStack gap="200">
                {pagedFiltered.map((o) => (
                  <QCard
                    key={o.numericId}
                    o={o}
                    open={openId === o.numericId}
                    onToggle={() =>
                      setOpenId(openId === o.numericId ? null : o.numericId)
                    }
                    onApprove={() => setModal({ kind: "approve", order: o })}
                    onCan={() => setModal({ kind: "can", order: o })}
                    onEmail={() => setModal({ kind: "email", order: o })}
                    onImage={(src, title) =>
                      setModal({ kind: "image", src, title })
                    }
                  />
                ))}
              </BlockStack>
            )}

            {filtered.length > PAGE_SIZE ? (
              <InlineStack align="center">
                <Pagination
                  hasPrevious={safePage > 0}
                  hasNext={safePage < totalPages - 1}
                  onPrevious={() => setPage(safePage - 1)}
                  onNext={() => setPage(safePage + 1)}
                  label={`Page ${safePage + 1} of ${totalPages} · ${filtered.length} orders`}
                />
              </InlineStack>
            ) : null}
          </BlockStack>
        </Card>
      </BlockStack>

      {modal?.kind === "approve" ? (
        <ApproveModal
          order={modal.order}
          busy={busy}
          onClose={() => setModal(null)}
          onConfirm={() => submit("approve", modal.order)}
        />
      ) : null}
      {modal?.kind === "can" ? (
        <CanModal
          order={modal.order}
          busy={busy}
          onClose={() => setModal(null)}
          onConfirm={() => submit("can", modal.order)}
        />
      ) : null}
      {modal?.kind === "email" ? (
        <EmailModal
          order={modal.order}
          onClose={() => setModal(null)}
          onSent={() => {
            setModal(null);
            onAfterAction(`Email sent to ${modal.order.email}.`);
          }}
        />
      ) : null}
      {modal?.kind === "image" ? (
        <ImageModal
          src={modal.src}
          title={modal.title}
          onClose={() => setModal(null)}
        />
      ) : null}
    </div>
  );
}

function QCard({
  o,
  open,
  onToggle,
  onApprove,
  onCan,
  onEmail,
  onImage,
}: {
  o: OrderRow;
  open: boolean;
  onToggle: () => void;
  onApprove: () => void;
  onCan: () => void;
  onEmail: () => void;
  onImage: (src: string, title: string) => void;
}) {
  const conf = o.confidence;
  const allLis = o.lineItems || [];
  // splitAssessment aligns segments to the original line-item index, so we
  // run it on the full list and then filter to patches only — preserving
  // segment->lineItem alignment via the `originalIdx` we carry forward.
  const { segments, fallback } = splitAssessment(o.summary || "", allLis);
  const lis = allLis
    .map((li, originalIdx) => ({ li, originalIdx }))
    .filter(({ li }) => isPatchLineItem(li));
  const totalQty = lis.reduce((a, x) => a + (x.li.quantity || 1), 0);
  const productSummary =
    lis.length === 0
      ? "N/A"
      : lis.length === 1
        ? `${lis[0].li.title}${lis[0].li.quantity ? ` | ${lis[0].li.quantity}x` : ""}${lis[0].li.variant ? ` ${lis[0].li.variant}` : ""}`
        : `${lis[0].li.title} (+${lis.length - 1} more) | ${totalQty} items`;
  const isNF = (o.tags || []).some((t) => t.toLowerCase() === "ninjafast");
  const isDS = (o.tags || []).some(
    (t) => t.toLowerCase() === "direct ship to customer",
  );

  return (
    <Card padding="0">
      <div
        onClick={onToggle}
        role="button"
        tabIndex={0}
        style={{ cursor: "pointer" }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <Box padding="400">
          <InlineStack gap="300" blockAlign="center" wrap>
            <Text as="span" variant="bodyMd" fontWeight="bold">
              {o.id}
            </Text>
            <Text as="span" variant="bodyMd" fontWeight="medium">
              {o.customer}
            </Text>
            <Text as="span" variant="bodySm" tone="subdued">
              {productSummary}
            </Text>
            <ConfidenceBar conf={conf} />
            {isNF ? <Badge tone="warning">NinjaFast</Badge> : null}
            {isDS ? <Badge tone="info">Direct Ship</Badge> : null}
            <span style={{ flex: 1 }} />
            <Text as="span" variant="bodySm" tone="subdued">
              {relativeTime(o.createdAt)}
            </Text>
            <span
              style={{
                display: "inline-flex",
                transition: "transform 0.2s",
                transform: open ? "rotate(180deg)" : "rotate(0)",
              }}
            >
              <Icon name="chevron-down" size={14} />
            </span>
          </InlineStack>
        </Box>
      </div>
      <Collapsible
        open={open}
        id={`qcard-detail-${o.numericId}`}
        transition={{ duration: "150ms", timingFunction: "ease-in-out" }}
        expandOnPrint
      >
        <Box
          padding="400"
          borderBlockStartWidth="025"
          borderColor="border"
        >
          <BlockStack gap="400">
            {lis.map(({ li, originalIdx }, i) => {
              const liArt =
                o.resolvedArtworkUrl?.[li.lineItemId] ||
                li.artworkUrl ||
                li.imageUrl ||
                "";
              const liMockup = o.mockupMap?.[li.lineItemId] || "";
              const seg = segments[originalIdx];
              return (
                <BlockStack key={li.lineItemId || i} gap="300">
                  {i > 0 ? <Divider /> : null}
                  <Text as="span" variant="bodySm" tone="subdued" fontWeight="bold">
                    {li.title.toUpperCase()}
                    {li.variant ? ` — ${li.variant}` : ""}
                    {li.quantity ? `  ×${li.quantity}` : ""}
                  </Text>
                  <LineItemProps li={li} />
                  <Box
                    background="bg-surface-secondary"
                    padding="300"
                    borderRadius="200"
                  >
                    <BlockStack gap="100">
                      <Text as="span" variant="bodySm" fontWeight="bold" tone="subdued">
                        AI ASSESSMENT
                      </Text>
                      {seg ? (
                        <FormatAISummary text={seg} />
                      ) : (
                        <Text as="span" variant="bodySm" tone="subdued">
                          No assessment available for this line item.
                        </Text>
                      )}
                    </BlockStack>
                  </Box>
                  <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                    <BlockStack gap="100">
                      <Text as="span" variant="bodySm" fontWeight="medium">
                        Customer Uploaded Artwork
                      </Text>
                      {liArt ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onImage(liArt, `Customer Artwork - ${li.title}`);
                          }}
                          style={{
                            border: "1px solid var(--p-color-border-subdued, #e1e3e5)",
                            borderRadius: 8,
                            padding: 0,
                            background: "#f6f6f7",
                            cursor: "pointer",
                            height: 160,
                            overflow: "hidden",
                          }}
                          aria-label={`Customer Artwork - ${li.title}`}
                        >
                          <img
                            src={liArt}
                            alt={`Customer Artwork - ${li.title}`}
                            style={{
                              width: "100%",
                              height: "100%",
                              objectFit: "contain",
                              display: "block",
                            }}
                          />
                        </button>
                      ) : (
                        <Box
                          padding="400"
                          background="bg-surface-secondary"
                          borderRadius="200"
                          minHeight="160px"
                        >
                          <BlockStack gap="100" inlineAlign="center">
                            <Text as="span" variant="bodySm" tone="subdued">
                              No artwork uploaded
                            </Text>
                          </BlockStack>
                        </Box>
                      )}
                    </BlockStack>
                    <BlockStack gap="100">
                      <Text as="span" variant="bodySm" fontWeight="medium">
                        AI-Generated Mockup
                      </Text>
                      {liMockup ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onImage(liMockup, `AI Mockup - ${li.title}`);
                          }}
                          style={{
                            border: "1px solid var(--p-color-border-subdued, #e1e3e5)",
                            borderRadius: 8,
                            padding: 0,
                            background: "#f6f6f7",
                            cursor: "pointer",
                            height: 160,
                            overflow: "hidden",
                          }}
                          aria-label={`AI Mockup - ${li.title}`}
                        >
                          <img
                            src={liMockup}
                            alt={`AI Mockup - ${li.title}`}
                            style={{
                              width: "100%",
                              height: "100%",
                              objectFit: "contain",
                              display: "block",
                            }}
                          />
                        </button>
                      ) : (
                        <Box
                          padding="400"
                          background="bg-surface-secondary"
                          borderRadius="200"
                          minHeight="160px"
                        >
                          <BlockStack gap="050" inlineAlign="center">
                            <Text as="span" variant="bodySm" tone="subdued" fontWeight="medium">
                              No mockup generated
                            </Text>
                            <Text as="span" variant="bodySm" tone="subdued">
                              Mockups generate after approval
                            </Text>
                          </BlockStack>
                        </Box>
                      )}
                    </BlockStack>
                  </InlineGrid>
                </BlockStack>
              );
            })}

            {fallback ? (
              <Box
                background="bg-surface-secondary"
                padding="300"
                borderRadius="200"
              >
                <BlockStack gap="100">
                  <Text as="span" variant="bodySm" fontWeight="bold" tone="subdued">
                    ADDITIONAL NOTES
                  </Text>
                  <FormatAISummary text={fallback} />
                </BlockStack>
              </Box>
            ) : null}

            <Divider />
            <InlineStack gap="200" wrap>
              <Button
                tone="success"
                variant="primary"
                onClick={onApprove}
                icon={undefined}
              >
                Approve
              </Button>
              <Button tone="critical" onClick={onCan}>
                Customer Action Needed
              </Button>
              <VendorPicker
                order={o}
                onSet={async (vendor) => {
                  try {
                    await apiFetch("/api/set-vendor", {
                      method: "POST",
                      body: JSON.stringify({
                        numericId: o.numericId,
                        orderId: o.id,
                        vendor,
                      }),
                    });
                  } catch (e) {
                    console.error("set-vendor failed:", e);
                  }
                }}
              />
              <span style={{ flex: 1 }} />
              <Button onClick={onEmail}>Email Customer</Button>
              <Button
                url={`https://admin.shopify.com/store/ninjapatches/orders/${o.numericId}`}
                external
                target="_blank"
              >
                Open in Shopify
              </Button>
            </InlineStack>
          </BlockStack>
        </Box>
      </Collapsible>
    </Card>
  );
}

// Inline confidence bar — Polaris ProgressBar tones don't include orange,
// and we want a faithful 3-step gradient (red < 75 < orange < 90 < green).
// Custom div keeps the legacy color band exact.
function ConfidenceBar({ conf }: { conf: number }) {
  const fill =
    conf >= 90
      ? "var(--p-color-bg-fill-success, #1a7f37)"
      : conf >= 75
        ? "#b45309"
        : "var(--p-color-bg-fill-critical, #c5221f)";
  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
      aria-label={`Confidence ${conf}%`}
    >
      <span
        style={{
          width: 50,
          height: 6,
          borderRadius: 3,
          background: "#eee",
          overflow: "hidden",
          display: "inline-block",
        }}
      >
        <span
          style={{
            display: "block",
            width: `${conf}%`,
            height: "100%",
            background: fill,
            borderRadius: 3,
          }}
        />
      </span>
      <Text as="span" variant="bodySm" fontWeight="bold">
        {`${conf}%`}
      </Text>
    </span>
  );
}

// ─── Vendor picker — Polaris Popover + ActionList ─────────────────────────
function VendorPicker({
  order,
  onSet,
}: {
  order: OrderRow;
  onSet: (vendor: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);

  const currentVendor = useMemo(() => {
    const lower = VENDOR_LIST.map((v) => v.toLowerCase());
    for (const t of order.tags || []) {
      const i = lower.indexOf(t.toLowerCase());
      if (i >= 0) return VENDOR_LIST[i];
    }
    return null;
  }, [order.tags]);

  return (
    <Popover
      active={open}
      activator={
        <Button
          disclosure={open ? "up" : "down"}
          onClick={() => setOpen((v) => !v)}
        >
          {currentVendor ? `Vendor: ${currentVendor}` : "Set Vendor"}
        </Button>
      }
      onClose={() => setOpen(false)}
      preferredAlignment="left"
    >
      <ActionList
        items={VENDOR_LIST.map((v) => ({
          content: v,
          active: v === currentVendor,
          onAction: () => {
            void onSet(v);
            setOpen(false);
          },
        }))}
      />
    </Popover>
  );
}

// ─── Piece 6: Approved tab — uses same QCard layout (read-only actions) ─
function ApprovedTab({
  active,
  orders,
  showToast,
  onAfterAction,
}: {
  active: boolean;
  orders: OrderRow[];
  showToast: (msg: string, kind?: ToastKind) => void;
  onAfterAction: () => void;
}) {
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [imgModal, setImgModal] = useState<{ src: string; title: string } | null>(
    null,
  );
  const [overrideOrder, setOverrideOrder] = useState<OrderRow | null>(null);
  const [emailOrder, setEmailOrder] = useState<OrderRow | null>(null);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  // Drop supply-only orders so the Approved audit list only contains
  // patches. Mirrors the same filter QueueTab uses.
  const patchOrders = useMemo(
    () => orders.filter((o) => hasAnyPatch(o.lineItems || [])),
    [orders],
  );

  const filtered = useMemo(() => {
    if (!search.trim()) return patchOrders;
    const q = search.toLowerCase();
    return patchOrders.filter(
      (o) =>
        o.id.toLowerCase().includes(q) ||
        o.customer.toLowerCase().includes(q) ||
        (o.email || "").toLowerCase().includes(q),
    );
  }, [patchOrders, search]);

  const stats = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayCount = patchOrders.filter(
      (o) => new Date(o.createdAt) >= today,
    ).length;
    const confs = patchOrders
      .filter((o) => o.confidence > 0)
      .map((o) => o.confidence);
    const avgConf =
      confs.length > 0
        ? Math.round(confs.reduce((a, b) => a + b, 0) / confs.length)
        : 0;
    const needsAudit = patchOrders.filter(
      (o) => o.confidence > 0 && o.confidence < 85,
    ).length;
    return {
      total: patchOrders.length,
      today: todayCount,
      avgConf,
      needsAudit,
    };
  }, [patchOrders]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pagedFiltered = filtered.slice(
    safePage * PAGE_SIZE,
    (safePage + 1) * PAGE_SIZE,
  );

  return (
    <div className={`tab-content${active ? " active" : ""}`}>
      <BlockStack gap="400">
        <InlineGrid columns={{ xs: 2, sm: 4 }} gap="300">
          <StatCard
            label="Total Approved"
            value={stats.total}
            tone="success"
            sub="Last 30 days"
          />
          <StatCard
            label="Approved Today"
            value={stats.today}
            tone="success"
            sub="Auto + manual"
          />
          <StatCard
            label="Avg Confidence"
            value={`${stats.avgConf}%`}
            sub="On approved orders"
          />
          <StatCard
            label="Needs Audit"
            value={stats.needsAudit}
            tone="caution"
            sub="Low confidence approved"
          />
        </InlineGrid>

        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="start" wrap>
              <BlockStack gap="050">
                <Text as="h3" variant="headingMd">
                  Approved Orders
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Expand an order to audit artwork, mockup, and AI assessment
                </Text>
              </BlockStack>
              <InlineStack gap="200">
                <Button
                  onClick={() =>
                    downloadCsv(
                      "/api/export?range=30d&type=approved",
                      `patchsensei-approved-${new Date().toISOString().slice(0, 10)}.csv`,
                    )
                  }
                >
                  Export Approved
                </Button>
              </InlineStack>
            </InlineStack>

            <InlineStack gap="200" blockAlign="end" wrap>
              <div style={{ flex: "1 1 200px", minWidth: 200 }}>
                <TextField
                  label="Search"
                  labelHidden
                  placeholder="Search by order, customer, or email…"
                  value={search}
                  onChange={setSearch}
                  autoComplete="off"
                  clearButton
                  onClearButtonClick={() => setSearch("")}
                />
              </div>
            </InlineStack>

            {patchOrders.length > 0 ? (
              <Text as="p" variant="bodySm" tone="subdued">
                Showing <strong>{filtered.length}</strong> of{" "}
                {patchOrders.length} approved patch order
                {patchOrders.length === 1 ? "" : "s"}
                {filtered.length !== patchOrders.length
                  ? " (filters active)"
                  : ""}
              </Text>
            ) : null}

            {filtered.length === 0 ? (
              <Box padding="600">
                <BlockStack gap="200" inlineAlign="center">
                  <Text as="p" variant="headingLg">
                    No approved orders
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Approved orders will appear here for audit.
                  </Text>
                </BlockStack>
              </Box>
            ) : (
              <BlockStack gap="200">
                {pagedFiltered.map((o) => (
                  <ApprovedCard
                    key={o.numericId}
                    o={o}
                    open={openId === o.numericId}
                    onToggle={() =>
                      setOpenId(openId === o.numericId ? null : o.numericId)
                    }
                    onImage={(src, title) => setImgModal({ src, title })}
                    onOverride={() => setOverrideOrder(o)}
                    onEmail={() => setEmailOrder(o)}
                  />
                ))}
              </BlockStack>
            )}

            {filtered.length > PAGE_SIZE ? (
              <InlineStack align="center">
                <Pagination
                  hasPrevious={safePage > 0}
                  hasNext={safePage < totalPages - 1}
                  onPrevious={() => setPage(safePage - 1)}
                  onNext={() => setPage(safePage + 1)}
                  label={`Page ${safePage + 1} of ${totalPages} · ${filtered.length} orders`}
                />
              </InlineStack>
            ) : null}
          </BlockStack>
        </Card>
      </BlockStack>

      {imgModal ? (
        <ImageModal
          src={imgModal.src}
          title={imgModal.title}
          onClose={() => setImgModal(null)}
        />
      ) : null}

      {overrideOrder ? (
        <OverrideModal
          order={overrideOrder}
          onClose={() => setOverrideOrder(null)}
          onSubmitted={() => {
            showToast(`Override recorded for ${overrideOrder.id}`, "warn");
            setOverrideOrder(null);
            onAfterAction();
          }}
        />
      ) : null}

      {emailOrder ? (
        <EmailModal
          order={emailOrder}
          onClose={() => setEmailOrder(null)}
          onSent={() => {
            showToast(`Email sent to ${emailOrder.email || "customer"}.`, "success");
            setEmailOrder(null);
          }}
        />
      ) : null}
    </div>
  );
}

function OverrideModal({
  order,
  onClose,
  onSubmitted,
}: {
  order: OrderRow;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await apiFetch("/api/override-note", {
        method: "POST",
        body: JSON.stringify({
          numericId: order.numericId,
          orderId: order.id,
          note,
          summary: order.summary || "",
          confidence: order.confidence || 0,
          productType:
            order.lineItems && order.lineItems[0]
              ? order.lineItems[0].title
              : "",
        }),
      });
      onSubmitted();
    } catch (e) {
      console.error("Override failed:", e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="Submit Override"
      primaryAction={{
        content: busy ? "Saving…" : "Submit Override",
        onAction: submit,
        loading: busy,
        disabled: busy || !note.trim(),
      }}
      secondaryActions={[
        { content: "Cancel", onAction: onClose, disabled: busy },
      ]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <InlineGrid columns={2} gap="300">
            <SmallKV k="Order" v={order.id} />
            <SmallKV k="Confidence" v={`${order.confidence}%`} />
          </InlineGrid>
          <TextField
            label="Why was the AI assessment wrong?"
            multiline={5}
            value={note}
            onChange={setNote}
            placeholder="The AI flagged this for X but it should have been fine because…"
            autoComplete="off"
          />
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

function ApprovedCard({
  o,
  open,
  onToggle,
  onImage,
  onOverride,
  onEmail,
}: {
  o: OrderRow;
  open: boolean;
  onToggle: () => void;
  onImage: (src: string, title: string) => void;
  onOverride: () => void;
  onEmail: () => void;
}) {
  const conf = o.confidence;
  const allLis = o.lineItems || [];
  const { segments, fallback } = splitAssessment(o.summary || "", allLis);
  const lis = allLis
    .map((li, originalIdx) => ({ li, originalIdx }))
    .filter(({ li }) => isPatchLineItem(li));
  const totalQty = lis.reduce((a, x) => a + (x.li.quantity || 1), 0);
  const productSummary =
    lis.length === 0
      ? "N/A"
      : lis.length === 1
        ? lis[0].li.title
        : `${lis[0].li.title} (+${lis.length - 1} more) | ${totalQty} items`;
  const isNFa = (o.tags || []).some((t) => t.toLowerCase() === "ninjafast");
  const isDSa = (o.tags || []).some(
    (t) => t.toLowerCase() === "direct ship to customer",
  );
  const lowConfAudit = conf > 0 && conf < 85;

  const cardEl = (
    <Card padding="0">
      <div
        onClick={onToggle}
        role="button"
        tabIndex={0}
        style={{ cursor: "pointer" }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <Box padding="400">
          <InlineStack gap="300" blockAlign="center" wrap>
            <Text as="span" variant="bodyMd" fontWeight="bold">
              {o.id}
            </Text>
            <Text as="span" variant="bodyMd" fontWeight="medium">
              {o.customer}
            </Text>
            {o.email ? (
              <Text as="span" variant="bodySm" tone="subdued">
                {o.email}
              </Text>
            ) : null}
            <Text as="span" variant="bodySm" tone="subdued">
              {productSummary}
            </Text>
            <ConfidenceBar conf={conf} />
            {isNFa ? <Badge tone="warning">NinjaFast</Badge> : null}
            {isDSa ? <Badge tone="info">Direct Ship</Badge> : null}
            {lowConfAudit ? <Badge tone="warning">Low Confidence</Badge> : null}
            <Badge tone="success">Approved</Badge>
            <span style={{ flex: 1 }} />
            <Text as="span" variant="bodySm" tone="subdued">
              {relativeTime(o.createdAt)}
            </Text>
            <span
              style={{
                display: "inline-flex",
                transition: "transform 0.2s",
                transform: open ? "rotate(180deg)" : "rotate(0)",
              }}
            >
              <Icon name="chevron-down" size={14} />
            </span>
          </InlineStack>
        </Box>
      </div>
      <Collapsible
        open={open}
        id={`approvedcard-detail-${o.numericId}`}
        transition={{ duration: "150ms", timingFunction: "ease-in-out" }}
        expandOnPrint
      >
        <Box
          padding="400"
          borderBlockStartWidth="025"
          borderColor="border"
        >
          <BlockStack gap="400">
            {lis.map(({ li, originalIdx }, i) => {
              const liArt =
                o.resolvedArtworkUrl?.[li.lineItemId] ||
                li.artworkUrl ||
                li.imageUrl ||
                "";
              const liMockup = o.mockupMap?.[li.lineItemId] || "";
              const seg = segments[originalIdx];
              return (
                <BlockStack key={li.lineItemId || i} gap="300">
                  {i > 0 ? <Divider /> : null}
                  <Text as="span" variant="bodySm" tone="subdued" fontWeight="bold">
                    {li.title.toUpperCase()}
                    {li.variant ? ` — ${li.variant}` : ""}
                    {li.quantity ? `  ×${li.quantity}` : ""}
                  </Text>
                  <LineItemProps li={li} />
                  <Box
                    background="bg-surface-secondary"
                    padding="300"
                    borderRadius="200"
                  >
                    <BlockStack gap="100">
                      <Text as="span" variant="bodySm" fontWeight="bold" tone="subdued">
                        AI ASSESSMENT
                      </Text>
                      {seg ? (
                        <FormatAISummary text={seg} />
                      ) : (
                        <Text as="span" variant="bodySm" tone="subdued">
                          No assessment available for this line item.
                        </Text>
                      )}
                    </BlockStack>
                  </Box>
                  <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                    <BlockStack gap="100">
                      <Text as="span" variant="bodySm" fontWeight="medium">
                        Customer Uploaded Artwork
                      </Text>
                      {liArt ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onImage(liArt, `Customer Artwork - ${li.title}`);
                          }}
                          style={{
                            border: "1px solid var(--p-color-border-subdued, #e1e3e5)",
                            borderRadius: 8,
                            padding: 0,
                            background: "#f6f6f7",
                            cursor: "pointer",
                            height: 160,
                            overflow: "hidden",
                          }}
                          aria-label={`Customer Artwork - ${li.title}`}
                        >
                          <img
                            src={liArt}
                            alt={`Customer Artwork - ${li.title}`}
                            style={{
                              width: "100%",
                              height: "100%",
                              objectFit: "contain",
                              display: "block",
                            }}
                          />
                        </button>
                      ) : (
                        <Box
                          padding="400"
                          background="bg-surface-secondary"
                          borderRadius="200"
                          minHeight="160px"
                        >
                          <BlockStack gap="100" inlineAlign="center">
                            <Text as="span" variant="bodySm" tone="subdued">
                              No artwork uploaded
                            </Text>
                          </BlockStack>
                        </Box>
                      )}
                    </BlockStack>
                    <BlockStack gap="100">
                      <Text as="span" variant="bodySm" fontWeight="medium">
                        AI-Generated Mockup
                      </Text>
                      {liMockup ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onImage(liMockup, `AI Mockup - ${li.title}`);
                          }}
                          style={{
                            border: "1px solid var(--p-color-border-subdued, #e1e3e5)",
                            borderRadius: 8,
                            padding: 0,
                            background: "#f6f6f7",
                            cursor: "pointer",
                            height: 160,
                            overflow: "hidden",
                          }}
                          aria-label={`AI Mockup - ${li.title}`}
                        >
                          <img
                            src={liMockup}
                            alt={`AI Mockup - ${li.title}`}
                            style={{
                              width: "100%",
                              height: "100%",
                              objectFit: "contain",
                              display: "block",
                            }}
                          />
                        </button>
                      ) : (
                        <Box
                          padding="400"
                          background="bg-surface-secondary"
                          borderRadius="200"
                          minHeight="160px"
                        >
                          <BlockStack gap="050" inlineAlign="center">
                            <Text as="span" variant="bodySm" tone="subdued" fontWeight="medium">
                              No mockup generated
                            </Text>
                          </BlockStack>
                        </Box>
                      )}
                    </BlockStack>
                  </InlineGrid>
                </BlockStack>
              );
            })}

            {fallback ? (
              <Box
                background="bg-surface-secondary"
                padding="300"
                borderRadius="200"
              >
                <BlockStack gap="100">
                  <Text as="span" variant="bodySm" fontWeight="bold" tone="subdued">
                    ADDITIONAL NOTES
                  </Text>
                  <FormatAISummary text={fallback} />
                </BlockStack>
              </Box>
            ) : null}

            <Divider />
            <InlineStack gap="200" wrap>
              <Button onClick={onOverride}>Submit Override</Button>
              <VendorPicker
                order={o}
                onSet={async (vendor) => {
                  try {
                    await apiFetch("/api/set-vendor", {
                      method: "POST",
                      body: JSON.stringify({
                        numericId: o.numericId,
                        orderId: o.id,
                        vendor,
                      }),
                    });
                  } catch (e) {
                    console.error("set-vendor failed:", e);
                  }
                }}
              />
              <Button onClick={onEmail}>Email Customer</Button>
              <span style={{ flex: 1 }} />
              <Button
                url={`https://admin.shopify.com/store/ninjapatches/orders/${o.numericId}`}
                external
                target="_blank"
              >
                Open in Shopify
              </Button>
            </InlineStack>
          </BlockStack>
        </Box>
      </Collapsible>
    </Card>
  );

  if (lowConfAudit) {
    return (
      <div
        style={{
          borderLeft: "4px solid var(--p-color-bg-fill-warning, #b45309)",
          borderTopLeftRadius: "var(--p-border-radius-300, 12px)",
          borderBottomLeftRadius: "var(--p-border-radius-300, 12px)",
        }}
      >
        {cardEl}
      </div>
    );
  }
  return cardEl;
}

// ─── Piece 7: Analytics tab ──────────────────────────────────────────────
// Lambda 3 v31's /api/volume daily shape is {date, count, approved, review,
// mismatch}; the response is wrapped in {daily, statusBreakdown, total}.
interface VolumePoint {
  date: string;
  count: number;
  approved: number;
  review?: number;
  mismatch?: number;
}
interface VolumeResponse {
  daily?: VolumePoint[];
  statusBreakdown?: {
    APPROVED?: number;
    REVIEW?: number;
    CAN?: number;
    MISMATCH?: number;
  };
  total?: number;
}
function unwrapVolume(
  v: VolumeResponse | VolumePoint[] | null | undefined,
): VolumePoint[] {
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.daily)) return v.daily;
  return [];
}
interface OverrideEntry {
  order_id?: string;
  product_type?: string;
  ai_summary?: string;
  rep?: string;
  rep_note?: string;
  override_at?: string;
  confidence?: number;
}
interface OverridesResponse {
  total: number;
  overrides: OverrideEntry[];
  topReasons: Array<{ reason: string; count: number }>;
  range?: string;
}

function formatOverrideDate(s?: string): string {
  if (!s) return "--";
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return s;
  }
}

// ─── Analytics helper aggregations ────────────────────────────────────────
const MISMATCH_MATCHERS: Array<{ key: string; test: RegExp }> = [
  {
    key: "AI could not process artwork image",
    test: /could not process artwork image|IMAGE-ERROR/i,
  },
  {
    key: "Fine detail may lose definition at size",
    test: /fine detail|lose definition|delicate/i,
  },
  {
    key: "Thread color count near or above limit",
    test: /thread color|color count|color limit|approaching the.*color limit/i,
  },
  {
    key: "Text too small for clean legibility",
    test: /text.*small|small.*text|legib|below the recommended.*minimum/i,
  },
  {
    key: "Gradient in embroidered product",
    test: /gradient.*embroider|embroider.*gradient/i,
  },
  { key: "No artwork file uploaded", test: /no artwork file uploaded/i },
  { key: "Low resolution artwork", test: /low.?res|resolution|dpi/i },
  {
    key: "Image exceeds file size limit",
    test: /image exceeds.*maximum|exceeds 5 MB/i,
  },
];

function aggMismatchReasons(
  orders: Array<{ summary?: string; numericId?: string; id?: string }>,
): Array<{ reason: string; count: number }> {
  const counts: Record<string, number> = {};
  const seen = new Set<string>();
  orders.forEach((o) => {
    const key = o.numericId || o.id;
    if (!key || seen.has(key)) return;
    seen.add(key);
    const s = o.summary || "";
    if (!s) return;
    MISMATCH_MATCHERS.forEach((m) => {
      if (m.test.test(s)) counts[m.key] = (counts[m.key] || 0) + 1;
    });
  });
  return Object.entries(counts)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);
}

function aggProductType(
  queue: OrderRow[],
  approved: OrderRow[],
  recent: RecentReview[],
): Array<{ name: string; approved: number; mismatch: number; review: number }> {
  const map = new Map<
    string,
    { approved: number; mismatch: number; review: number }
  >();
  const get = (n: string) => {
    let v = map.get(n);
    if (!v) {
      v = { approved: 0, mismatch: 0, review: 0 };
      map.set(n, v);
    }
    return v;
  };
  queue.forEach((o) => {
    (o.lineItems || []).forEach((li) => {
      get(li.title).review += 1;
    });
  });
  approved.forEach((o) => {
    (o.lineItems || []).forEach((li) => {
      get(li.title).approved += 1;
    });
  });
  recent.forEach((r) => {
    if (!r.product) return;
    if (r.status === "MISMATCH" || r.status === "CAN") {
      get(r.product).mismatch += 1;
    }
  });
  return Array.from(map.entries())
    .map(([name, v]) => ({ name, ...v }))
    .sort(
      (a, b) =>
        b.approved + b.mismatch + b.review - (a.approved + a.mismatch + a.review),
    )
    .slice(0, 7);
}

function aggConfDist(
  orders: OrderRow[],
): Array<{ label: string; count: number }> {
  const buckets = [
    { label: "60-69%", min: 60, max: 69 },
    { label: "70-79%", min: 70, max: 79 },
    { label: "80-84%", min: 80, max: 84 },
    { label: "85-89%", min: 85, max: 89 },
    { label: "90-94%", min: 90, max: 94 },
    { label: "95-100%", min: 95, max: 100 },
  ];
  const counts = buckets.map(() => 0);
  orders.forEach((o) => {
    const c = o.confidence;
    if (typeof c !== "number" || c <= 0) return;
    for (let i = 0; i < buckets.length; i++) {
      if (c >= buckets[i].min && c <= buckets[i].max) {
        counts[i] += 1;
        break;
      }
    }
  });
  return buckets.map((b, i) => ({ label: b.label, count: counts[i] }));
}

function aggAvgConfByType(
  queue: OrderRow[],
  approved: OrderRow[],
): Array<{ name: string; avg: number }> {
  const sums = new Map<string, { sum: number; n: number }>();
  const add = (name: string, c: number) => {
    if (!c) return;
    const v = sums.get(name) || { sum: 0, n: 0 };
    v.sum += c;
    v.n += 1;
    sums.set(name, v);
  };
  [...queue, ...approved].forEach((o) => {
    if (!o.confidence) return;
    (o.lineItems || []).forEach((li) => add(li.title, o.confidence));
  });
  return Array.from(sums.entries())
    .map(([name, v]) => ({ name, avg: v.n > 0 ? Math.round(v.sum / v.n) : 0 }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 7);
}

function aggWeekly(
  daily: VolumePoint[],
): Array<{ label: string; total: number }> {
  if (!daily || daily.length === 0) return [];
  const out: Array<{ label: string; total: number }> = [];
  for (let i = 0; i < daily.length; i += 7) {
    const chunk = daily.slice(i, i + 7);
    out.push({
      label: `W${out.length + 1}`,
      total: chunk.reduce((a, x) => a + (x.count || 0), 0),
    });
  }
  return out;
}

// ─── Analytics chart components ───────────────────────────────────────────
function HStackedBar({
  data,
}: {
  data: Array<{ name: string; approved: number; mismatch: number; review: number }>;
}) {
  if (data.length === 0) {
    return (
      <div
        style={{
          height: 280,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--t2)",
          fontSize: 13,
        }}
      >
        No product type data yet.
      </div>
    );
  }
  const max = Math.max(
    1,
    ...data.map((d) => d.approved + d.mismatch + d.review),
  );
  const rowH = 28;
  const gap = 8;
  const labelW = 110;
  const W = 720;
  const H = data.length * (rowH + gap) + 32;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: H }}>
      {data.map((d, i) => {
        const y = i * (rowH + gap);
        const total = d.approved + d.mismatch + d.review;
        const tw = ((W - labelW - 60) * total) / max;
        const aw = total > 0 ? (tw * d.approved) / total : 0;
        const mw = total > 0 ? (tw * d.mismatch) / total : 0;
        const rw = total > 0 ? (tw * d.review) / total : 0;
        return (
          <g key={d.name}>
            <text
              x={labelW - 8}
              y={y + rowH / 2 + 4}
              fontSize={11}
              fill="#6d7175"
              textAnchor="end"
            >
              {d.name}
            </text>
            <rect x={labelW} y={y} width={aw} height={rowH} fill="#34a853" />
            <rect
              x={labelW + aw}
              y={y}
              width={mw}
              height={rowH}
              fill="#ea4335"
            />
            <rect
              x={labelW + aw + mw}
              y={y}
              width={rw}
              height={rowH}
              fill="#f5a623"
            />
            <text
              x={labelW + tw + 6}
              y={y + rowH / 2 + 4}
              fontSize={11}
              fill="#202223"
              fontWeight={600}
            >
              {total}
            </text>
          </g>
        );
      })}
      {/* Legend */}
      <g transform={`translate(${labelW}, ${H - 18})`}>
        <rect width={10} height={10} fill="#34a853" />
        <text x={14} y={9} fontSize={10} fill="#202223">
          Approved
        </text>
        <rect x={70} width={10} height={10} fill="#ea4335" />
        <text x={84} y={9} fontSize={10} fill="#202223">
          Mismatch
        </text>
        <rect x={140} width={10} height={10} fill="#f5a623" />
        <text x={154} y={9} fontSize={10} fill="#202223">
          Review
        </text>
      </g>
    </svg>
  );
}

function VBar({
  data,
  color,
  yMin = 0,
  yMax,
  unit = "",
}: {
  data: Array<{ label: string; value: number }>;
  color: string;
  yMin?: number;
  yMax?: number;
  unit?: string;
}) {
  if (data.length === 0) {
    return (
      <div
        style={{
          height: 240,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--t2)",
          fontSize: 13,
        }}
      >
        No data yet.
      </div>
    );
  }
  // Reserve more space at the bottom when labels are long enough that they'd
  // collide horizontally — rotate them -30° so multi-word product names don't
  // overlap each other.
  const longestLabel = Math.max(0, ...data.map((d) => d.label.length));
  const rotateLabels = longestLabel > 8;
  const W = 720;
  const H = rotateLabels ? 280 : 240;
  const padL = 36;
  const padB = rotateLabels ? 80 : 40;
  const padT = 12;
  const computedMax = Math.max(...data.map((d) => d.value));
  const max = yMax != null ? yMax : Math.max(1, computedMax);
  const min = yMin;
  const span = max - min;
  const barW = (W - padL - 16) / data.length - 6;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: H }}>
      {[0, 0.25, 0.5, 0.75, 1].map((f) => {
        const y = padT + (H - padT - padB) * (1 - f);
        return (
          <g key={f}>
            <line x1={padL} x2={W - 8} y1={y} y2={y} stroke="#eee" />
            <text
              x={padL - 6}
              y={y + 3}
              fontSize={10}
              fill="#6d7175"
              textAnchor="end"
            >
              {Math.round(min + span * f)}
              {unit}
            </text>
          </g>
        );
      })}
      {data.map((d, i) => {
        const x = padL + 4 + i * (barW + 6);
        const ratio = span > 0 ? (d.value - min) / span : 0;
        const h = (H - padT - padB) * Math.max(0, Math.min(1, ratio));
        const y = H - padB - h;
        const labelX = x + barW / 2;
        const labelY = H - padB + 14;
        return (
          <g key={d.label}>
            <rect x={x} y={y} width={barW} height={h} fill={color} rx={3} />
            <text
              x={labelX}
              y={labelY}
              fontSize={10}
              fill="#6d7175"
              textAnchor={rotateLabels ? "end" : "middle"}
              transform={
                rotateLabels
                  ? `rotate(-30, ${labelX}, ${labelY})`
                  : undefined
              }
            >
              {d.label}
            </text>
            {d.value > 0 ? (
              <text
                x={x + barW / 2}
                y={y - 4}
                fontSize={11}
                fill="#202223"
                fontWeight={600}
                textAnchor="middle"
              >
                {d.value}
                {unit}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

function AreaLine({
  data,
  color,
}: {
  data: Array<{ label: string; total: number }>;
  color: string;
}) {
  if (data.length === 0) {
    return (
      <div
        style={{
          height: 240,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--t2)",
          fontSize: 13,
        }}
      >
        No weekly volume data yet.
      </div>
    );
  }
  const W = 720;
  const H = 240;
  const padL = 36;
  const padB = 28;
  const padT = 12;
  const max = Math.max(1, ...data.map((d) => d.total));
  const xStep = data.length > 1 ? (W - padL - 12) / (data.length - 1) : 0;
  const points = data.map((d, i) => ({
    x: padL + i * xStep,
    y: padT + (H - padT - padB) * (1 - d.total / max),
  }));
  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`)
    .join(" ");
  const area = `${path} L ${points[points.length - 1].x} ${H - padB} L ${points[0].x} ${H - padB} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 240 }}>
      {[0, 0.25, 0.5, 0.75, 1].map((f) => {
        const y = padT + (H - padT - padB) * (1 - f);
        return (
          <g key={f}>
            <line x1={padL} x2={W - 8} y1={y} y2={y} stroke="#eee" />
            <text
              x={padL - 6}
              y={y + 3}
              fontSize={9}
              fill="#6d7175"
              textAnchor="end"
            >
              {Math.round(max * f)}
            </text>
          </g>
        );
      })}
      <path d={area} fill={color} fillOpacity={0.18} />
      <path d={path} stroke={color} strokeWidth={2} fill="none" />
      {points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={3} fill={color} />
      ))}
      {data.map((d, i) => (
        <text
          key={d.label}
          x={padL + i * xStep}
          y={H - padB + 14}
          fontSize={10}
          fill="#6d7175"
          textAnchor="middle"
        >
          {d.label}
        </text>
      ))}
    </svg>
  );
}

function AnalyticsTab({
  active,
  stats,
  queue,
  approved,
  recent,
}: {
  active: boolean;
  stats: StatsResponse | null;
  queue: OrderRow[];
  approved: OrderRow[];
  recent: RecentReview[];
}) {
  const [volume, setVolume] = useState<VolumePoint[]>([]);
  const [overrides, setOverrides] = useState<OverridesResponse | null>(null);
  const [logPage, setLogPage] = useState(0);
  const [mismatchPick, setMismatchPick] = useState<{
    reason: string;
    count: number;
  } | null>(null);
  const LOG_PAGE = 25;

  useEffect(() => {
    if (!active) return;
    (async () => {
      try {
        const v = await apiFetch<VolumeResponse | VolumePoint[]>(
          "/api/volume?days=30",
        );
        setVolume(unwrapVolume(v));
      } catch {
        setVolume([]);
      }
      try {
        const o = await apiFetch<OverridesResponse>(
          "/api/overrides?range=30d",
        );
        setOverrides(o);
      } catch {
        setOverrides(null);
      }
    })();
  }, [active]);

  const totalOverrides = overrides?.total ?? 0;
  const overrideEntries = overrides?.overrides ?? [];
  const topReasons = overrides?.topReasons ?? [];

  const productTypeData = useMemo(
    () => aggProductType(queue, approved, recent),
    [queue, approved, recent],
  );
  const confDistData = useMemo(
    () =>
      aggConfDist([...queue, ...approved]).map((d) => ({
        label: d.label,
        value: d.count,
      })),
    [queue, approved],
  );
  const weeklyData = useMemo(() => aggWeekly(volume), [volume]);
  const avgByTypeData = useMemo(
    () =>
      aggAvgConfByType(queue, approved).map((d) => ({
        label: d.name,
        value: d.avg,
      })),
    [queue, approved],
  );
  const mismatchData = useMemo(
    () =>
      aggMismatchReasons([
        ...queue,
        ...approved,
        ...recent.map((r) => ({
          summary: r.summary,
          numericId: r.numericId,
          id: r.id,
        })),
      ]),
    [queue, approved, recent],
  );
  const withFeedback = overrideEntries.filter((o) =>
    (o.rep_note || "").trim(),
  ).length;
  const totalLogPages = Math.max(1, Math.ceil(overrideEntries.length / LOG_PAGE));
  const safeLogPage = Math.min(logPage, totalLogPages - 1);
  const logSlice = overrideEntries.slice(
    safeLogPage * LOG_PAGE,
    (safeLogPage + 1) * LOG_PAGE,
  );

  return (
    <div className={`tab-content${active ? " active" : ""}`}>
      <BlockStack gap="400">
        {/* Page intro card — labels the merged scope of this view. */}
        <Card>
          <BlockStack gap="100">
            <Text as="h2" variant="headingLg">
              Analytics
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Combined view of the customer proofs workflow and the AI
              artwork-review pipeline. Each section below is labeled with the
              domain it covers.
            </Text>
          </BlockStack>
        </Card>

        {/* Proofs analytics — stat cards, 30-day chart, bottlenecks.
            Loads from /app/proofs/analytics-data when active. */}
        <ProofsAnalyticsDetails active={active} />

        <Card>
          <BlockStack gap="300">
            <BlockStack gap="050">
              <Text as="h3" variant="headingMd">
                Artwork Review · Lifetime metrics
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                AI artwork-review snapshot across all reviewed orders.
              </Text>
            </BlockStack>
            <InlineGrid columns={{ xs: 2, sm: 5 }} gap="300">
              <StatCard
                label="Approval Rate"
                value={stats?.appRate != null ? `${stats.appRate}%` : "--"}
                tone="success"
                loading={!stats}
              />
              <StatCard
                label="Avg Confidence"
                value={stats?.avgConf != null ? `${stats.avgConf}%` : "--"}
                loading={!stats}
              />
              <StatCard
                label="Total Reviewed"
                value={stats?.total ?? "--"}
                loading={!stats}
              />
              <StatCard
                label="Pending Review"
                value={stats?.review ?? "--"}
                tone="caution"
                loading={!stats}
              />
              <StatCard
                label="Mismatch"
                value={stats?.mismatch ?? "--"}
                tone="critical"
                loading={!stats}
              />
            </InlineGrid>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <BlockStack gap="050">
              <Text as="h3" variant="headingMd">
                Artwork Review · Review trends
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Daily review outcomes — last 30 days
              </Text>
            </BlockStack>
            <DailyVolumeChart points={volume} />
          </BlockStack>
        </Card>

        <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
          <Card>
            <BlockStack gap="300">
              <BlockStack gap="050">
                <Text as="h3" variant="headingMd">
                  Artwork Review · Reviews by product type
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Volume breakdown across all patch types
                </Text>
              </BlockStack>
              <HStackedBar data={productTypeData} />
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="300">
              <BlockStack gap="050">
                <Text as="h3" variant="headingMd">
                  Artwork Review · Confidence distribution
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  How confident is PatchSensei across reviews
                </Text>
              </BlockStack>
              <VBar data={confDistData} color="#5c6ac4" />
            </BlockStack>
          </Card>
        </InlineGrid>

        <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
          <Card>
            <BlockStack gap="300">
              <BlockStack gap="050">
                <Text as="h3" variant="headingMd">
                  Artwork Review · Weekly order volume
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Orders processed per week
                </Text>
              </BlockStack>
              <AreaLine data={weeklyData} color="#47c1bf" />
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="300">
              <BlockStack gap="050">
                <Text as="h3" variant="headingMd">
                  Artwork Review · Avg confidence by type
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Which types PatchSensei handles best
                </Text>
              </BlockStack>
              <VBar
                data={avgByTypeData}
                color="#9c6ade"
                yMin={60}
                yMax={100}
                unit="%"
              />
            </BlockStack>
          </Card>
        </InlineGrid>

        {mismatchData.length > 0 ? (
          <Card>
            <BlockStack gap="300">
              <BlockStack gap="050">
                <Text as="h3" variant="headingMd">
                  Artwork Review · Top mismatch reasons
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Most common reasons for artwork rejection — surfaced from AI
                  summaries
                </Text>
              </BlockStack>
              <BlockStack gap="200">
                {mismatchData.map((m, i) => {
                  const max = mismatchData[0].count;
                  const pct = (m.count / max) * 100;
                  return (
                    <div
                      key={m.reason}
                      role="button"
                      tabIndex={0}
                      onClick={() => setMismatchPick(m)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setMismatchPick(m);
                        }
                      }}
                      title="Click to view matching recent orders"
                      style={{ cursor: "pointer" }}
                    >
                      <Box
                        background="bg-surface-secondary"
                        padding="300"
                        borderRadius="200"
                      >
                        <InlineStack gap="300" blockAlign="center" wrap={false}>
                          <Box
                            background="bg-fill-secondary"
                            padding="200"
                            borderRadius="200"
                            minWidth="36px"
                          >
                            <Text
                              as="span"
                              variant="bodyMd"
                              fontWeight="bold"
                              alignment="center"
                            >
                              {i + 1}
                            </Text>
                          </Box>
                          <BlockStack gap="050">
                            <Text as="span" variant="bodyMd" fontWeight="medium">
                              {m.reason}
                            </Text>
                            <Text as="span" variant="bodySm" tone="subdued">
                              {m.count} occurrence{m.count !== 1 ? "s" : ""}
                            </Text>
                          </BlockStack>
                          <span style={{ flex: 1 }} />
                          <span
                            style={{
                              flex: "0 0 120px",
                              height: 8,
                              borderRadius: 4,
                              background: "#eee",
                              overflow: "hidden",
                            }}
                            aria-label={`${Math.round(pct)}% of top reason`}
                          >
                            <span
                              style={{
                                display: "block",
                                width: `${pct}%`,
                                height: "100%",
                                background:
                                  "var(--p-color-bg-fill-critical, #c5221f)",
                              }}
                            />
                          </span>
                        </InlineStack>
                      </Box>
                    </div>
                  );
                })}
              </BlockStack>
            </BlockStack>
          </Card>
        ) : null}

        <Card>
          <BlockStack gap="400">
            <BlockStack gap="050">
              <Text as="h3" variant="headingMd">
                Artwork Review · Override insights
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Orders PatchSensei flagged for review that reps approved with no
                changes
              </Text>
            </BlockStack>

            <InlineGrid columns={{ xs: 1, sm: 3 }} gap="300">
              <Card background="bg-surface-warning" padding="400">
                <BlockStack gap="100">
                  <Text as="span" variant="bodySm" tone="subdued">
                    Overrides (last 30d)
                  </Text>
                  <Text as="span" variant="heading2xl" fontWeight="bold">
                    {totalOverrides}
                  </Text>
                  <Text as="span" variant="bodySm" tone="subdued">
                    {stats ? `of ${stats.review} REVIEW orders` : " "}
                  </Text>
                </BlockStack>
              </Card>
              <Card background="bg-surface-success" padding="400">
                <BlockStack gap="100">
                  <Text as="span" variant="bodySm" tone="subdued">
                    With Rep Feedback
                  </Text>
                  <Text as="span" variant="heading2xl" fontWeight="bold">
                    {withFeedback}
                  </Text>
                  <Text as="span" variant="bodySm" tone="subdued">
                    of {totalOverrides} overrides included notes
                  </Text>
                </BlockStack>
              </Card>
              <Card background="bg-surface-info" padding="400">
                <BlockStack gap="100">
                  <Text as="span" variant="bodySm" tone="subdued">
                    Suggested Prompt Updates
                  </Text>
                  <Text as="span" variant="heading2xl" fontWeight="bold">
                    {Math.min(topReasons.length, 3)}
                  </Text>
                  <Text as="span" variant="bodySm" tone="subdued">
                    Patterns detected for your review
                  </Text>
                </BlockStack>
              </Card>
            </InlineGrid>

            <BlockStack gap="200">
              <Text as="h4" variant="headingSm">
                Recurring Override Patterns
              </Text>
              {topReasons.length === 0 ? (
                <Text as="p" variant="bodySm" tone="subdued">
                  No override patterns detected this period.
                </Text>
              ) : (
                <BlockStack gap="200">
                  {topReasons.slice(0, 3).map((p, i) => {
                    const pct =
                      totalOverrides > 0
                        ? Math.round((p.count / totalOverrides) * 100)
                        : 0;
                    const hot = pct >= 50;
                    const needle = p.reason.substring(0, 20);
                    const notes = overrideEntries
                      .filter(
                        (o) =>
                          (o.ai_summary || "").includes(needle) &&
                          (o.rep_note || "").trim(),
                      )
                      .map((o) => o.rep_note as string)
                      .slice(0, 3);
                    return (
                      <Box
                        key={i}
                        background="bg-surface-secondary"
                        padding="300"
                        borderRadius="200"
                      >
                        <BlockStack gap="200">
                          <InlineStack gap="300" blockAlign="center" wrap>
                            <Box
                              background={
                                hot ? "bg-fill-warning" : "bg-fill-info"
                              }
                              padding="200"
                              borderRadius="200"
                              minWidth="36px"
                            >
                              <Text
                                as="span"
                                variant="bodyMd"
                                fontWeight="bold"
                                alignment="center"
                              >
                                {i + 1}
                              </Text>
                            </Box>
                            <BlockStack gap="050">
                              <Text as="span" variant="bodyMd" fontWeight="medium">
                                {p.reason}
                              </Text>
                              <Text as="span" variant="bodySm" tone="subdued">
                                {p.count} occurrence{p.count !== 1 ? "s" : ""} (
                                {pct}%) this period
                              </Text>
                            </BlockStack>
                            <span style={{ flex: 1 }} />
                            <Badge tone={hot ? "warning" : "info"}>
                              {`${pct}%`}
                            </Badge>
                          </InlineStack>
                          {notes.length > 0 ? (
                            <BlockStack gap="100">
                              <Text
                                as="span"
                                variant="bodySm"
                                fontWeight="bold"
                                tone="subdued"
                              >
                                REP FEEDBACK
                              </Text>
                              <InlineStack gap="100" wrap>
                                {notes.map((n, ni) => (
                                  <Tag key={ni}>
                                    &ldquo;{n.substring(0, 60)}&rdquo;
                                  </Tag>
                                ))}
                              </InlineStack>
                            </BlockStack>
                          ) : null}
                        </BlockStack>
                      </Box>
                    );
                  })}
                </BlockStack>
              )}
            </BlockStack>

            <BlockStack gap="200">
              <Text as="h4" variant="headingSm">
                Recent Override Log
              </Text>
              <Box overflowX="scroll">
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      <th style={overrideTh}>Order</th>
                      <th style={overrideTh}>Product Type</th>
                      <th style={overrideTh}>AI Concern</th>
                      <th style={overrideTh}>Rep</th>
                      <th style={overrideTh}>Feedback</th>
                      <th style={overrideTh}>Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logSlice.length === 0 ? (
                      <tr>
                        <td colSpan={6} style={overrideEmpty}>
                          No overrides in this period.
                        </td>
                      </tr>
                    ) : (
                      logSlice.map((o, i) => (
                        <tr key={i} style={overrideRow}>
                          <td style={{ ...overrideTd, fontWeight: 600 }}>
                            {o.order_id || "N/A"}
                          </td>
                          <td style={overrideTd}>{o.product_type || "--"}</td>
                          <td style={overrideTd}>
                            {(o.ai_summary || "N/A").substring(0, 60)}
                          </td>
                          <td style={overrideTd}>{o.rep || "--"}</td>
                          <td
                            style={
                              o.rep_note
                                ? { ...overrideTd, fontStyle: "italic" }
                                : { ...overrideTd, color: "#6d7175" }
                            }
                          >
                            {o.rep_note || "No feedback"}
                          </td>
                          <td style={{ ...overrideTd, color: "#6d7175" }}>
                            {formatOverrideDate(o.override_at)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </Box>
              {overrideEntries.length > LOG_PAGE ? (
                <InlineStack align="center">
                  <Pagination
                    hasPrevious={safeLogPage > 0}
                    hasNext={safeLogPage < totalLogPages - 1}
                    onPrevious={() => setLogPage(safeLogPage - 1)}
                    onNext={() => setLogPage(safeLogPage + 1)}
                    label={`Page ${safeLogPage + 1} of ${totalLogPages} · ${overrideEntries.length} entries`}
                  />
                </InlineStack>
              ) : null}
            </BlockStack>
          </BlockStack>
        </Card>
      </BlockStack>

      {mismatchPick ? (
        <MismatchModal
          reason={mismatchPick.reason}
          count={mismatchPick.count}
          recent={recent}
          onClose={() => setMismatchPick(null)}
        />
      ) : null}
    </div>
  );
}

const overrideTh: React.CSSProperties = {
  textAlign: "left",
  padding: "8px 12px",
  borderBottom: "1px solid var(--p-color-border-subdued, #e1e3e5)",
  fontSize: 12,
  fontWeight: 600,
  color: "#6d7175",
  textTransform: "uppercase",
  letterSpacing: "0.4px",
};
const overrideTd: React.CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid var(--p-color-border-subdued, #e1e3e5)",
  fontSize: 13,
  color: "#202223",
};
const overrideRow: React.CSSProperties = {};
const overrideEmpty: React.CSSProperties = {
  textAlign: "center",
  color: "#6d7175",
  fontStyle: "italic",
  padding: 24,
  fontSize: 13,
};

function StatusPieChart({ stats }: { stats: StatsResponse | null }) {
  if (!stats) {
    return (
      <div
        style={{
          height: 240,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--t2)",
          fontSize: 13,
        }}
      >
        Loading...
      </div>
    );
  }
  const total = stats.approved + stats.review + (stats.mismatch || 0);
  if (total === 0)
    return (
      <div
        style={{
          height: 240,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--t2)",
          fontSize: 13,
        }}
      >
        No data yet
      </div>
    );

  const segments = [
    { label: "Approved", value: stats.approved, color: "#34a853" },
    { label: "Pending Review", value: stats.review, color: "#f5a623" },
    { label: "Mismatch", value: stats.mismatch || 0, color: "#ea4335" },
  ];

  const cx = 120;
  const cy = 110;
  const r = 80;
  let cum = 0;
  const arcs = segments.map((s) => {
    const start = (cum / total) * 2 * Math.PI - Math.PI / 2;
    cum += s.value;
    const end = (cum / total) * 2 * Math.PI - Math.PI / 2;
    const large = end - start > Math.PI ? 1 : 0;
    const x1 = cx + r * Math.cos(start);
    const y1 = cy + r * Math.sin(start);
    const x2 = cx + r * Math.cos(end);
    const y2 = cy + r * Math.sin(end);
    const d =
      s.value === total
        ? `M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy} A ${r} ${r} 0 1 1 ${cx - r} ${cy}`
        : `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
    return { d, color: s.color, label: s.label, value: s.value };
  });

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        flexWrap: "wrap",
        justifyContent: "center",
      }}
    >
      <svg
        viewBox="0 0 240 220"
        style={{
          width: 200,
          height: 184,
          flex: "0 0 auto",
        }}
      >
        {arcs.map((a, i) => (
          <path key={i} d={a.d} fill={a.color} />
        ))}
        <circle cx={cx} cy={cy} r={r * 0.55} fill="#fff" />
        <text
          x={cx}
          y={cy - 4}
          textAnchor="middle"
          fontSize={20}
          fontWeight={700}
          fill="#202223"
        >
          {total}
        </text>
        <text
          x={cx}
          y={cy + 14}
          textAnchor="middle"
          fontSize={11}
          fill="#6d7175"
        >
          total
        </text>
      </svg>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          flex: "1 1 140px",
          minWidth: 140,
        }}
      >
        {arcs.map((a) => {
          const pct = Math.round((a.value / total) * 100);
          return (
            <div
              key={a.label}
              style={{
                display: "grid",
                gridTemplateColumns: "12px auto 1fr",
                alignItems: "center",
                gap: 8,
                fontSize: 12,
              }}
            >
              <span
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 2,
                  background: a.color,
                  display: "inline-block",
                }}
              />
              <span style={{ fontWeight: 600 }}>{a.label}</span>
              <span style={{ color: "var(--t2)", whiteSpace: "nowrap" }}>
                {a.value.toLocaleString()} ({pct}%)
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DailyVolumeChart({ points }: { points: VolumePoint[] }) {
  if (!points || points.length === 0) {
    return (
      <div
        style={{
          height: 240,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--t2)",
          fontSize: 13,
        }}
      >
        Loading volume data...
      </div>
    );
  }
  const W = 720;
  const H = 240;
  const padL = 36;
  const padB = 28;
  const padT = 12;
  const max = Math.max(1, ...points.map((p) => p.count));
  const barW = (W - padL - 16) / points.length - 2;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: "100%", height: 240, display: "block" }}
    >
      {/* Y axis */}
      {[0, 0.25, 0.5, 0.75, 1].map((f) => {
        const y = padT + (H - padT - padB) * (1 - f);
        return (
          <g key={f}>
            <line
              x1={padL}
              x2={W - 8}
              y1={y}
              y2={y}
              stroke="#eee"
              strokeWidth={1}
            />
            <text
              x={padL - 6}
              y={y + 3}
              fontSize={9}
              fill="#6d7175"
              textAnchor="end"
            >
              {Math.round(max * f)}
            </text>
          </g>
        );
      })}
      {/* Bars */}
      {points.map((p, i) => {
        const x = padL + 2 + i * (barW + 2);
        const tot = p.count || 0;
        const app = p.approved || 0;
        const mis = (p.mismatch || 0) + 0; // legacy stacks rejections in red
        const totH = ((H - padT - padB) * tot) / max;
        const appH = tot > 0 ? (totH * app) / tot : 0;
        const canH = tot > 0 ? (totH * mis) / tot : 0;
        const yBase = H - padB;
        return (
          <g key={p.date}>
            <rect
              x={x}
              y={yBase - canH - appH}
              width={barW}
              height={appH}
              fill="#34a853"
            />
            <rect
              x={x}
              y={yBase - canH}
              width={barW}
              height={canH}
              fill="#ea4335"
            />
          </g>
        );
      })}
      {/* X axis labels — every ~5th day */}
      {points.map((p, i) =>
        i % Math.max(1, Math.floor(points.length / 6)) === 0 ? (
          <text
            key={p.date}
            x={padL + 2 + i * (barW + 2) + barW / 2}
            y={H - padB + 14}
            fontSize={9}
            fill="#6d7175"
            textAnchor="middle"
          >
            {p.date.slice(5)}
          </text>
        ) : null,
      )}
      {/* Legend */}
      <g>
        <rect x={padL} y={H - 12} width={10} height={10} fill="#34a853" />
        <text x={padL + 14} y={H - 3} fontSize={10} fill="#202223">
          Approved
        </text>
        <rect x={padL + 80} y={H - 12} width={10} height={10} fill="#ea4335" />
        <text x={padL + 94} y={H - 3} fontSize={10} fill="#202223">
          Can&apos;t do
        </text>
      </g>
    </svg>
  );
}

// ─── Piece 8: Settings tab ───────────────────────────────────────────────
interface ConfigPayload {
  auto_approve?: string;
  confidence_threshold?: string;
  generate_mockups?: string;
  email_notifications?: string;
  notification_emails?: string; // JSON array as string
}

function SettingsTab({
  active,
  showToast,
}: {
  active: boolean;
  showToast: (msg: string, kind?: ToastKind) => void;
}) {
  const [autoApprove, setAutoApprove] = useState(false);
  const [threshold, setThreshold] = useState(90);
  const [generateMockups, setGenerateMockups] = useState(true);
  const [emailNotif, setEmailNotif] = useState(true);
  const [recipients, setRecipients] = useState<string[]>([
    "service@ninjapatches.com",
  ]);
  const [newEmail, setNewEmail] = useState("");

  // Load config once when tab becomes active
  useEffect(() => {
    if (!active) return;
    (async () => {
      try {
        const c = await apiFetch<ConfigPayload>("/api/config");
        if (c.auto_approve === "true") setAutoApprove(true);
        if (c.email_notifications === "false") setEmailNotif(false);
        if (c.generate_mockups === "false") setGenerateMockups(false);
        if (c.confidence_threshold) setThreshold(Number(c.confidence_threshold));
        if (c.notification_emails) {
          try {
            const arr = JSON.parse(c.notification_emails);
            if (Array.isArray(arr) && arr.length) setRecipients(arr);
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* keep defaults if config endpoint fails */
      }
    })();
  }, [active]);

  const save = async () => {
    try {
      await apiFetch("/api/config", {
        method: "POST",
        body: JSON.stringify({
          auto_approve: autoApprove ? "true" : "false",
          confidence_threshold: String(threshold),
          generate_mockups: generateMockups ? "true" : "false",
          email_notifications: emailNotif ? "true" : "false",
          notification_emails: JSON.stringify(recipients),
        }),
      });
      showToast("Settings saved.", "success");
    } catch (e) {
      console.error("Save settings failed:", e);
      showToast("Failed to save settings.", "error");
    }
  };

  return (
    <div className={`tab-content${active ? " active" : ""}`}>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="h2" variant="headingLg">
            PatchSensei Settings
          </Text>
          <Text as="p" variant="bodyMd" tone="subdued">
            Configure AI review behavior and notification preferences
          </Text>
        </BlockStack>

        <Card>
          <BlockStack gap="400">
            <BlockStack gap="100">
              <Text as="h3" variant="headingMd">
                Review Automation
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Control how PatchSensei handles artwork reviews
              </Text>
            </BlockStack>
            <Divider />
            <InlineStack align="space-between" blockAlign="start" wrap={false}>
              <BlockStack gap="050">
                <Text as="span" variant="bodyMd" fontWeight="semibold">
                  Auto-Approve High Confidence
                </Text>
                <Text as="span" variant="bodySm" tone="subdued">
                  Automatically approve orders above the confidence threshold
                </Text>
              </BlockStack>
              <Checkbox
                label="Auto-Approve High Confidence"
                labelHidden
                checked={autoApprove}
                onChange={setAutoApprove}
              />
            </InlineStack>
            <Divider />
            <BlockStack gap="200">
              <InlineStack align="space-between" blockAlign="center" wrap={false}>
                <BlockStack gap="050">
                  <Text as="span" variant="bodyMd" fontWeight="semibold">
                    Confidence Threshold
                  </Text>
                  <Text as="span" variant="bodySm" tone="subdued">
                    Minimum confidence for auto-approval
                  </Text>
                </BlockStack>
                <Text as="span" variant="headingMd">
                  {threshold}%
                </Text>
              </InlineStack>
              <RangeSlider
                label="Confidence threshold"
                labelHidden
                min={70}
                max={99}
                value={threshold}
                onChange={(v) =>
                  setThreshold(typeof v === "number" ? v : v[0])
                }
              />
              <InlineStack align="space-between">
                <Text as="span" variant="bodySm" tone="subdued">
                  70% (more auto-approvals)
                </Text>
                <Text as="span" variant="bodySm" tone="subdued">
                  99% (stricter)
                </Text>
              </InlineStack>
            </BlockStack>
            <Divider />
            <InlineStack align="space-between" blockAlign="start" wrap={false}>
              <BlockStack gap="050">
                <Text as="span" variant="bodyMd" fontWeight="semibold">
                  Generate Mockups
                </Text>
                <Text as="span" variant="bodySm" tone="subdued">
                  Auto-generate AI mockups for approved orders via gpt-image-1
                </Text>
              </BlockStack>
              <Checkbox
                label="Generate Mockups"
                labelHidden
                checked={generateMockups}
                onChange={setGenerateMockups}
              />
            </InlineStack>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="400">
            <BlockStack gap="100">
              <Text as="h3" variant="headingMd">
                Notifications
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Manage how you receive PatchSensei alerts
              </Text>
            </BlockStack>
            <Divider />
            <InlineStack align="space-between" blockAlign="start" wrap={false}>
              <BlockStack gap="050">
                <Text as="span" variant="bodyMd" fontWeight="semibold">
                  Email Notifications
                </Text>
                <Text as="span" variant="bodySm" tone="subdued">
                  Send email alerts for MISMATCH and REVIEW determinations
                </Text>
              </BlockStack>
              <Checkbox
                label="Email Notifications"
                labelHidden
                checked={emailNotif}
                onChange={setEmailNotif}
              />
            </InlineStack>
            {emailNotif ? (
              <Box
                background="bg-surface-secondary"
                padding="300"
                borderRadius="200"
              >
                <BlockStack gap="200">
                  <Text as="span" variant="bodySm" tone="subdued">
                    Notification recipients
                  </Text>
                  {recipients.length > 0 ? (
                    <InlineStack gap="200" wrap>
                      {recipients.map((r) => (
                        <Tag
                          key={r}
                          onRemove={() =>
                            setRecipients(recipients.filter((x) => x !== r))
                          }
                        >
                          {r}
                        </Tag>
                      ))}
                    </InlineStack>
                  ) : null}
                  <InlineStack gap="200" align="start" blockAlign="end">
                    <div style={{ flex: 1 }}>
                      <TextField
                        label="Add recipient"
                        labelHidden
                        type="email"
                        autoComplete="email"
                        placeholder="email@example.com"
                        value={newEmail}
                        onChange={setNewEmail}
                      />
                    </div>
                    <Button
                      onClick={() => {
                        const v = newEmail.trim();
                        if (v && !recipients.includes(v)) {
                          setRecipients([...recipients, v]);
                          setNewEmail("");
                        }
                      }}
                    >
                      Add
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Box>
            ) : null}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="400">
            <BlockStack gap="100">
              <Text as="h3" variant="headingMd">
                System Information
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                PatchSensei infrastructure details
              </Text>
            </BlockStack>
            <Divider />
            <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
              <SysInfo k="Lambda 1 (Review)" v="PatchSensei-ArtworkReview" />
              <SysInfo k="Lambda 2 (Mockup)" v="PatchSensei-MockupGenerator" />
              <SysInfo k="AI Model (Review)" v="Claude Haiku" />
              <SysInfo k="AI Model (Mockup)" v="OpenAI gpt-image-1" />
              <SysInfo k="Region" v="us-east-1" />
              <SysInfo k="S3 Bucket" v="ninja-patchsensei-mockups" />
              <SysInfo k="SQS Queue" v="PatchSenseiMockupQueue" />
              <SysInfo k="App Version" v="v4.1 (Active)" />
            </InlineGrid>
          </BlockStack>
        </Card>

        <InlineStack align="end">
          <Button variant="primary" onClick={save}>
            Save Settings
          </Button>
        </InlineStack>
      </BlockStack>
    </div>
  );
}

function SysInfo({ k, v }: { k: string; v: string }) {
  return (
    <Box background="bg-surface-secondary" padding="300" borderRadius="200">
      <BlockStack gap="050">
        <Text as="span" variant="bodySm" tone="subdued">
          {k}
        </Text>
        <Text as="span" variant="bodyMd">
          <code style={{ fontFamily: "var(--p-font-family-mono)", fontSize: 12 }}>
            {v}
          </code>
        </Text>
      </BlockStack>
    </Box>
  );
}

// ─── Piece 9: Mockup Lab tab (full port — see app/lib/mockup-lab.tsx) ───
function MockupLabTab({ active }: { active: boolean }) {
  return (
    <div className={`tab-content${active ? " active" : ""}`}>
      <Suspense
        fallback={
          <Box padding="600">
            <BlockStack gap="200" inlineAlign="center">
              <Spinner accessibilityLabel="Loading Mockup Lab" size="small" />
              <Text as="span" variant="bodySm" tone="subdued">
                Loading Mockup Lab…
              </Text>
            </BlockStack>
          </Box>
        }
      >
        <MockupLab />
      </Suspense>
    </div>
  );
}

// ─── Piece 10: Modals ──────────────────────────────────────────────────
function ApproveModal({
  order,
  busy,
  onClose,
  onConfirm,
}: {
  order: OrderRow;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      open
      onClose={onClose}
      title="Confirm Approval"
      primaryAction={{
        content: busy ? "Approving…" : "Approve Order",
        onAction: onConfirm,
        loading: busy,
        disabled: busy,
      }}
      secondaryActions={[
        { content: "Cancel", onAction: onClose, disabled: busy },
      ]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <InlineGrid columns={2} gap="300">
            <SmallKV k="Order" v={order.id} />
            <SmallKV k="Customer" v={order.customer} />
          </InlineGrid>
          {order.summary ? (
            <Banner tone="success" title="AI Review Summary">
              <Text as="p" variant="bodyMd">
                <span style={{ whiteSpace: "pre-wrap" }}>{order.summary}</span>
              </Text>
            </Banner>
          ) : null}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

function CanModal({
  order,
  busy,
  onClose,
  onConfirm,
}: {
  order: OrderRow;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <Modal
      open
      onClose={onClose}
      title="Customer Action Needed"
      primaryAction={{
        content: busy ? "Processing…" : "Mark as CAN",
        onAction: onConfirm,
        loading: busy,
        disabled: busy,
        destructive: true,
      }}
      secondaryActions={[
        { content: "Cancel", onAction: onClose, disabled: busy },
      ]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <InlineGrid columns={2} gap="300">
            <SmallKV k="Order" v={order.id} />
            <SmallKV k="Customer" v={order.customer} />
          </InlineGrid>
          <TextField
            label="Reason for CAN"
            multiline={4}
            value={reason}
            onChange={setReason}
            placeholder="Describe what the customer needs to fix…"
            autoComplete="off"
          />
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

function EmailModal({
  order,
  onClose,
  onSent,
}: {
  order: OrderRow;
  onClose: () => void;
  onSent: () => void;
}) {
  const [template, setTemplate] = useState<"can" | "approved" | "custom">("can");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [simplified, setSimplified] = useState<string | null>(null);

  // Pre-fetch a customer-friendly version of the AI summary for the CAN
  // template (matches legacy /api/simplify behavior).
  useEffect(() => {
    if (!order.summary) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await apiFetch<{ simplified: string }>("/api/simplify", {
          method: "POST",
          body: JSON.stringify({ summary: order.summary }),
        });
        if (!cancelled && r.simplified) setSimplified(r.simplified);
      } catch {
        /* fall through to raw summary */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [order.summary]);

  useEffect(() => {
    const firstName = (order.customer || "Customer").split(" ")[0];
    let s = "",
      b = "";
    if (template === "can") {
      s = `Action Needed: Your Order ${order.id} Requires Review`;
      b = `Hi ${firstName},

Thank you for your order ${order.id}.

After reviewing your artwork, our team has identified an issue:

${simplified || order.summary || ""}

Could you please send us an updated artwork file? We want to make sure your patches come out looking perfect.

Best regards,
Ninja Patches Art Department`;
    } else if (template === "approved") {
      s = `Your Order ${order.id} Has Been Approved!`;
      b = `Hi ${firstName},

Great news! Your artwork for order ${order.id} has been reviewed and approved.

Your order is now moving to production.

Expected turnaround: 10-12 business days.

Best regards,
Ninja Patches Art Department`;
    } else {
      s = `Your NinjaPatches Order`;
      b = `Hi ${firstName},

Regarding your order ${order.id}...

`;
    }
    setSubject(s);
    setBody(b);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template, order, simplified]);

  const send = async () => {
    setBusy(true);
    try {
      await apiFetch("/api/email", {
        method: "POST",
        body: JSON.stringify({
          numericId: order.numericId,
          orderId: order.id,
          to: order.email,
          subject,
          body,
        }),
      });
      onSent();
    } catch (e) {
      console.error("Email send failed:", e);
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Email Customer"
      primaryAction={{
        content: busy ? "Sending…" : "Send Email",
        onAction: send,
        loading: busy,
        disabled: busy,
      }}
      secondaryActions={[
        { content: "Cancel", onAction: onClose, disabled: busy },
      ]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <TextField
            label="To"
            type="email"
            value={order.email || ""}
            readOnly
            autoComplete="email"
            onChange={() => {}}
          />
          <Select
            label="Template"
            options={[
              { label: "Customer Action Needed", value: "can" },
              { label: "Order Approved", value: "approved" },
              { label: "Custom Message", value: "custom" },
            ]}
            value={template}
            onChange={(v) =>
              setTemplate(v as "can" | "approved" | "custom")
            }
          />
          <TextField
            label="Subject"
            value={subject}
            onChange={setSubject}
            autoComplete="off"
          />
          <TextField
            label="Message"
            multiline={10}
            value={body}
            onChange={setBody}
            autoComplete="off"
          />
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

function ImageModal({
  src,
  title,
  onClose,
}: {
  src: string;
  title: string;
  onClose: () => void;
}) {
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      size="large"
      primaryAction={{ content: "Close", onAction: onClose }}
    >
      <Modal.Section>
        <div style={{ textAlign: "center" }}>
          <img
            src={src}
            alt={title}
            style={{
              maxWidth: "100%",
              maxHeight: "70vh",
              display: "inline-block",
              borderRadius: 8,
            }}
          />
        </div>
      </Modal.Section>
    </Modal>
  );
}

function MismatchModal({
  reason,
  count,
  recent,
  onClose,
}: {
  reason: string;
  count: number;
  recent: RecentReview[];
  onClose: () => void;
}) {
  const firstWord = (reason.split(" ")[0] || "").toLowerCase();
  let matches = recent.filter(
    (r) =>
      r.status === "MISMATCH" ||
      (r.summary && r.summary.toLowerCase().includes(firstWord)),
  );
  if (matches.length === 0) {
    matches = recent.filter((r) => r.status === "REVIEW").slice(0, 5);
  }
  matches = matches.slice(0, 12);
  return (
    <Modal
      open
      onClose={onClose}
      title={`Orders: ${reason}`}
      primaryAction={{ content: "Close", onAction: onClose }}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <Text as="p" variant="bodyMd" tone="subdued">
            <strong>{count}</strong> order{count === 1 ? "" : "s"} flagged for:{" "}
            <em>{reason}</em>
          </Text>
          {matches.length === 0 ? (
            <Box padding="400">
              <Text as="p" variant="bodyMd" tone="subdued" alignment="center">
                No matching orders found in recent data.
              </Text>
            </Box>
          ) : (
            <BlockStack gap="200">
              {matches.map((r) => {
                const status = (r.status || "REVIEW").replace(
                  "PATCHSENSEI-",
                  "",
                );
                const tone:
                  | "success"
                  | "warning"
                  | "critical"
                  | "info"
                  | undefined =
                  status === "APPROVED"
                    ? "success"
                    : status === "MISMATCH" || status === "CAN"
                      ? "critical"
                      : "warning";
                return (
                  <a
                    key={r.numericId}
                    href={`https://admin.shopify.com/store/ninjapatches/orders/${r.numericId}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ textDecoration: "none", color: "inherit" }}
                  >
                    <Box
                      background="bg-surface-secondary"
                      padding="300"
                      borderRadius="200"
                    >
                      <InlineStack
                        align="space-between"
                        blockAlign="center"
                        gap="300"
                        wrap={false}
                      >
                        <BlockStack gap="050">
                          <Text
                            as="span"
                            variant="bodyMd"
                            fontWeight="semibold"
                          >
                            {r.id}
                          </Text>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {r.customer} — {r.product}
                          </Text>
                        </BlockStack>
                        <InlineStack gap="200" blockAlign="center">
                          <Badge tone={tone}>{status}</Badge>
                          <Icon name="arrow-up-right" size={14} />
                        </InlineStack>
                      </InlineStack>
                    </Box>
                  </a>
                );
              })}
            </BlockStack>
          )}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
