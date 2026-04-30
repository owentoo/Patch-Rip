// Detects whether an order requires a proof and whether it was paid for.
// For Slice 1 we match on product handle (works for ninjapatches without
// needing the merchant to enter product IDs). Settings UI in a later phase
// will let merchants configure this per shop.

const PAID_HANDLES = new Set(["proof-approval-before-production"]);
const FREE_HANDLES = new Set(["free-proof-approval-before-production"]);

export interface LineItemForDetection {
  productHandle?: string | null;
  productTitle?: string | null;
}

// True for the "Proof Approval Before Production" / "Free Proof Approval..."
// products. These are billing markers, not real items the customer needs a
// proof for, so they shouldn't show up in the line items list on the order
// detail page.
export function isProofTriggerProduct(args: {
  title?: string | null;
  handle?: string | null;
}): boolean {
  const handle = args.handle?.toLowerCase() ?? "";
  const title = args.title?.toLowerCase() ?? "";
  if (PAID_HANDLES.has(handle) || FREE_HANDLES.has(handle)) return true;
  if (title.includes("proof approval before production")) return true;
  return false;
}

export function detectProofTrigger(
  lineItems: LineItemForDetection[],
): { proofRequested: boolean; proofPaid: boolean } {
  let paid = false;
  let free = false;
  for (const li of lineItems) {
    const handle = li.productHandle?.toLowerCase() ?? "";
    const title = li.productTitle?.toLowerCase() ?? "";
    if (PAID_HANDLES.has(handle) || title.includes("proof approval before production")) {
      if (title.startsWith("free")) free = true;
      else paid = true;
    } else if (FREE_HANDLES.has(handle) || title.includes("free proof approval")) {
      free = true;
    }
  }
  return {
    proofRequested: paid || free,
    proofPaid: paid,
  };
}
