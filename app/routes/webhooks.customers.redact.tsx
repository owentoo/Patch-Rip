import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  const customerId = (payload as { customer?: { id?: number | string } })
    ?.customer?.id;
  console.log(`[webhook] ${topic} for ${shop} customer=${customerId}`);

  // PatchSensei stores no customer PII. Order metadata (tags, metafields)
  // lives in Shopify and is governed by Shopify's own redaction. Acknowledge.
  return new Response();
};
