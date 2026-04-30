import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useRevalidator } from "@remix-run/react";
import { Button, Select, Text } from "@shopify/polaris";

// Dashboard tabs are switched in-place inside /app via setTab.
export type DashboardTab =
  | "home"
  | "queue"
  | "approved"
  | "analytics"
  | "settings"
  | "mockuplab";
// All routes the header strip can highlight as the active page.
export type AnyTab = DashboardTab | "proofs";

export interface HeaderShellProps {
  activeTab: AnyTab;
  // When provided + the current view is the dashboard, dashboard tabs flip
  // active in-place. When omitted (e.g. on /app/proofs), every dashboard tab
  // becomes a Remix Link to /app?tab=...
  onSelectDashboardTab?: (t: DashboardTab) => void;
  queueCount?: number;
  approvedCount?: number;
  // Right-side strip props. When the dashboard hands these in we use them;
  // otherwise the strip self-manages so it always renders and the nav row
  // doesn't shrink/jump as you move between tabs.
  lastUpdated?: Date | null;
  refreshing?: boolean;
  onRefresh?: () => void;
  autoRefreshSec?: number;
  onAutoRefreshChange?: (s: number) => void;
}

interface TabDef {
  id: AnyTab;
  label: string;
  badge?: number;
  badgeStyle?: React.CSSProperties;
}

// Badge counts and last-updated are mirrored to localStorage by the
// dashboard so non-dashboard pages (Proofs, order-detail) can render the
// same nav strip without their own /api/* round-trip. Treat anything
// older than 30 minutes as stale (today-counts roll forward intra-day).
const BADGE_TTL_MS = 30 * 60 * 1000;

function readNumber(key: string): number | undefined {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

function readPersistedBadges(): {
  queue?: number;
  approved?: number;
  updated?: Date;
} {
  if (typeof window === "undefined") return {};
  const updatedMs = readNumber("ps-badge-updated");
  if (updatedMs === undefined) return {};
  if (Date.now() - updatedMs > BADGE_TTL_MS) return {};
  return {
    queue: readNumber("ps-badge-queue"),
    approved: readNumber("ps-badge-approved"),
    updated: new Date(updatedMs),
  };
}

export function HeaderShell({
  activeTab,
  onSelectDashboardTab,
  queueCount,
  approvedCount,
  lastUpdated,
  refreshing,
  onRefresh,
  autoRefreshSec,
  onAutoRefreshChange,
}: HeaderShellProps) {
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  // Internal state used when the page doesn't pass refresh handlers in
  // (Proofs, order detail). navigate(0) → revalidate the loader.
  const [internalSec, setInternalSec] = useState<number>(0);
  const [internalRefreshing, setInternalRefreshing] = useState(false);
  const [persisted, setPersisted] = useState<{
    queue?: number;
    approved?: number;
    updated?: Date;
  }>(() => readPersistedBadges());
  // Re-read persisted badges whenever the route changes — covers the case
  // where the dashboard refreshed its badge count while another tab/page
  // had this HeaderShell mounted.
  useEffect(() => {
    setPersisted(readPersistedBadges());
  }, [activeTab]);
  const [internalLastUpdated, setInternalLastUpdated] = useState<Date | null>(
    () => persisted.updated ?? new Date(),
  );

  const dashboardManaged = onRefresh !== undefined;
  const effectiveSec = autoRefreshSec ?? internalSec;
  const effectiveRefreshing = refreshing ?? internalRefreshing;
  const effectiveLastUpdated =
    lastUpdated ?? persisted.updated ?? internalLastUpdated;
  const effectiveQueueCount = queueCount ?? persisted.queue;
  const effectiveApprovedCount = approvedCount ?? persisted.approved;

  const internalRefresh = useCallback(() => {
    setInternalRefreshing(true);
    revalidator.revalidate();
  }, [revalidator]);
  // Track when revalidation finishes so the spinner stops.
  useEffect(() => {
    if (!dashboardManaged && revalidator.state === "idle" && internalRefreshing) {
      setInternalRefreshing(false);
      setInternalLastUpdated(new Date());
    }
  }, [revalidator.state, internalRefreshing, dashboardManaged]);

  const effectiveOnRefresh = onRefresh ?? internalRefresh;
  const effectiveOnAutoRefreshChange =
    onAutoRefreshChange ??
    ((s: number) => {
      setInternalSec(s);
    });

  // Self-managed auto-refresh tick.
  useEffect(() => {
    if (dashboardManaged) return;
    if (internalSec <= 0) return;
    const id = window.setInterval(() => {
      internalRefresh();
    }, internalSec * 1000);
    return () => window.clearInterval(id);
  }, [dashboardManaged, internalSec, internalRefresh]);

  const tabs: TabDef[] = [
    { id: "home", label: "Home" },
    { id: "queue", label: "Needs Review", badge: effectiveQueueCount },
    {
      id: "approved",
      label: "Approved",
      badge: effectiveApprovedCount,
      badgeStyle: { background: "var(--green)", color: "#fff" },
    },
    { id: "proofs", label: "Proofs" },
    { id: "analytics", label: "Analytics" },
    { id: "mockuplab", label: "Mockup Lab" },
    { id: "settings", label: "Settings" },
  ];

  return (
    <div className="header">
      <div className="header-inner">
        <div className="header-top">
          <img
            className="header-logo"
            src="https://ninja-patchsensei-mockups.s3.amazonaws.com/assets/patchsensei-logo.png"
            alt="PatchSensei"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
          <div>
            <h1 className="header-title">PatchSensei</h1>
            <span className="header-sub">
              AI-powered artwork review &amp; proofs
            </span>
          </div>
          <div className="header-right">
            <span className="status-dot" />
            <span className="user-label">Drew Smith (Admin)</span>
          </div>
        </div>
        <div className="nav-row">
          {tabs.map((t) => {
            const className = `nav-tab${activeTab === t.id ? " active" : ""}`;
            const badgeNode =
              t.badge !== undefined ? (
                <span className="count" style={t.badgeStyle}>
                  {t.badge}
                </span>
              ) : null;

            // Already on /app/proofs → no need to navigate; otherwise Link.
            if (t.id === "proofs") {
              if (activeTab === "proofs") {
                return (
                  <button
                    key={t.id}
                    type="button"
                    className={className}
                    onClick={() => {
                      /* already here */
                    }}
                  >
                    {t.label}
                    {badgeNode}
                  </button>
                );
              }
              return (
                <Link
                  key={t.id}
                  to="/app/proofs"
                  className={className}
                  style={{ textDecoration: "none" }}
                  prefetch="intent"
                >
                  {t.label}
                  {badgeNode}
                </Link>
              );
            }

            // Dashboard tabs flip active in-place when we're inside /app.
            if (onSelectDashboardTab) {
              return (
                <button
                  key={t.id}
                  type="button"
                  className={className}
                  onClick={() => onSelectDashboardTab(t.id as DashboardTab)}
                >
                  {t.label}
                  {badgeNode}
                </button>
              );
            }
            // Otherwise navigate to the tab's own path (e.g. clicking from
            // Proofs goes to /app/queue, not /app?tab=queue, so the Shopify
            // sidebar can highlight the active sub-nav item).
            const path = t.id === "home" ? "/app" : `/app/${t.id}`;
            return (
              <Link
                key={t.id}
                to={path}
                className={className}
                style={{ textDecoration: "none" }}
                prefetch="intent"
              >
                {t.label}
                {badgeNode}
              </Link>
            );
          })}
          {/* Right-side strip is always rendered so the nav row's height and
              right-edge stay constant across every page. */}
          <div className="nav-right">
            <Text as="span" variant="bodySm" tone="subdued">
              {effectiveLastUpdated
                ? `Last updated: ${effectiveLastUpdated.toLocaleTimeString()}`
                : "Last updated: —"}
            </Text>
            <div style={{ minWidth: 130 }}>
              <Select
                label="Auto-refresh"
                labelHidden
                value={String(effectiveSec)}
                onChange={(v) => effectiveOnAutoRefreshChange(Number(v))}
                options={[
                  { label: "Auto: Off", value: "0" },
                  { label: "Auto: 30s", value: "30" },
                  { label: "Auto: 1m", value: "60" },
                  { label: "Auto: 5m", value: "300" },
                ]}
              />
            </div>
            <Button
              onClick={effectiveOnRefresh}
              loading={effectiveRefreshing}
            >
              Refresh
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Used by ssr-rendered pages whose data is loader-driven, so they can call
// the same revalidator pattern HeaderShell uses internally. Nothing imports
// this yet; exposing it for symmetry as the proofs/order-detail pages start
// surfacing custom refresh affordances.
export { useRevalidator } from "@remix-run/react";
