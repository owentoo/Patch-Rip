// Shared "is this line item an actual patch" filter used by the artwork-
// review pipeline (Queue, Approved, Home, Analytics). Drew's complaint is
// that supplies (heat tape, placement guides, the Proof-Approval billing
// product, etc.) get fed into the AI review flow — the AI gives them a
// "no assessment" / mismatch verdict because the customer never uploaded
// artwork for them, the mockup generator fails, and reps have to wade
// past them.
//
// Patches are everything that ISN'T on this blocklist. The list is
// case-insensitive substring match against the line item title. Add a
// term here when a new supply pattern shows up; do NOT use exact match
// because Shopify titles vary ("NO-MELT HEAT TAPE — Default Title", etc.).

const SUPPLY_TITLE_KEYWORDS: readonly string[] = [
  // Application supplies
  "heat tape",
  "placement guide",
  "iron-on",
  "ironing aid",
  "adhesive",
  "stencil",
  "ruler",
  // Billing trigger products (already filtered by isProofTriggerProduct
  // for the proofs workflow; mirrored here so the AI-review pipeline
  // doesn't surface them either)
  "proof approval before production",
  "free proof approval",
];

export interface PatchFilterableLineItem {
  title: string;
}

export function isPatchLineItem(li: PatchFilterableLineItem): boolean {
  const t = (li.title || "").toLowerCase();
  if (!t) return true; // never blocklist by accident if title is missing
  for (const kw of SUPPLY_TITLE_KEYWORDS) {
    if (t.includes(kw)) return false;
  }
  return true;
}

export function hasAnyPatch(lineItems: PatchFilterableLineItem[]): boolean {
  return lineItems.some(isPatchLineItem);
}
