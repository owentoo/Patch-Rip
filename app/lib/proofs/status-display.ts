// Single source of truth for the user-facing label, badge tone, and CSS
// class for each ProofStatus value. Both the dashboard (Polaris Badge)
// and the order detail page (custom CSS pill) consume from here so the
// strings stay in sync.

export type ProofStatus =
  | "AWAITING_PROOF"
  | "DRAFTED"
  | "SENT_TO_CUSTOMER"
  | "AWAITING_CUSTOMER"
  | "REVISIONS_REQUESTED"
  | "APPROVED"
  | "CANCELLED";

export const PROOF_STATUS_LABEL: Record<ProofStatus, string> = {
  AWAITING_PROOF: "Awaiting proof",
  DRAFTED: "Ready to send",
  SENT_TO_CUSTOMER: "Awaiting review",
  AWAITING_CUSTOMER: "Awaiting review",
  REVISIONS_REQUESTED: "Revisions requested",
  APPROVED: "Approved",
  CANCELLED: "Cancelled",
};

export type BadgeTone =
  | "info"
  | "success"
  | "warning"
  | "attention"
  | "critical"
  | undefined;

// Proof statuses use the info palette so they don't visually clash with
// fulfillment status (attention/critical).
export const PROOF_STATUS_TONE: Record<ProofStatus, BadgeTone> = {
  AWAITING_PROOF: "info",
  DRAFTED: "info",
  SENT_TO_CUSTOMER: "info",
  AWAITING_CUSTOMER: "info",
  REVISIONS_REQUESTED: "warning",
  APPROVED: "success",
  CANCELLED: undefined,
};

// CSS class used by the order detail page's custom pill.
export const PROOF_STATUS_CLASS: Record<ProofStatus, string> = {
  AWAITING_PROOF: "ps-status-default",
  DRAFTED: "ps-status-drafted",
  SENT_TO_CUSTOMER: "ps-status-info",
  AWAITING_CUSTOMER: "ps-status-info",
  REVISIONS_REQUESTED: "ps-status-warning",
  APPROVED: "ps-status-success",
  CANCELLED: "ps-status-default",
};

// Reduce a list of per-line-item proof statuses to a single
// order-level status for the dashboard row.
export function deriveOrderProofStatus(statuses: string[]): ProofStatus {
  if (statuses.length === 0) return "AWAITING_PROOF";
  if (statuses.every((s) => s === "APPROVED")) return "APPROVED";
  if (statuses.some((s) => s === "REVISIONS_REQUESTED")) return "REVISIONS_REQUESTED";
  if (statuses.some((s) => s === "AWAITING_CUSTOMER")) return "AWAITING_CUSTOMER";
  if (statuses.some((s) => s === "SENT_TO_CUSTOMER")) return "SENT_TO_CUSTOMER";
  if (statuses.some((s) => s === "DRAFTED")) return "DRAFTED";
  return "AWAITING_PROOF";
}
