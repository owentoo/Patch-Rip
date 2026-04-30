import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { prismaBase } from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, session, topic, shop } = await authenticate.webhook(request);
  console.log(`[webhook] ${topic} for ${shop}`);

  const current = payload.current as string[];
  if (session) {
    await prismaBase.session.update({
      where: { id: session.id },
      data: { scope: current.toString() },
    });
  }
  return new Response();
};
