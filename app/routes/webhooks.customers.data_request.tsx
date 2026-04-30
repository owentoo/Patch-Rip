import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  const customerId = (payload as { customer?: { id?: number | string } })?.customer?.id;
  console.log(`[webhook] ${topic} for ${shop} customer=${customerId}`);

  // GDPR data request: Shopify gives us 30 days to compile the customer's
  // data and forward it to the merchant, who then forwards to the customer.
  // For Slice 1 we acknowledge; the export pipeline is a follow-up task.
  // Logging suffices to satisfy Shopify's webhook delivery requirement.

  return new Response();
};
