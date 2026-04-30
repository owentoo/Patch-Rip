import type { LoaderFunctionArgs } from "@remix-run/node";

import { prismaBase } from "../db.server";
import { readFile } from "../lib/storage";
import { verifyCustomerToken } from "../lib/proofs/token";

export const loader = async ({ params }: LoaderFunctionArgs) => {
  const token = params.token;
  const fileId = params.fileId;
  if (!token || !fileId) throw new Response("Not found", { status: 404 });

  const parsed = verifyCustomerToken(token);
  if (!parsed) throw new Response("Invalid token", { status: 403 });

  const order = await prismaBase.order.findUnique({
    where: { id: parsed.orderId },
  });
  if (!order || order.signedCustomerToken !== parsed.nonce) {
    throw new Response("Forbidden", { status: 403 });
  }

  const file = await prismaBase.proofFile.findFirst({
    where: {
      id: fileId,
      proofVersion: { proof: { orderId: order.id } },
    },
  });
  if (!file) throw new Response("Not found", { status: 404 });

  const buf = await readFile(file.s3Key);

  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": file.mimeType,
      "Content-Disposition": `inline; filename="${file.originalFilename}"`,
      "Cache-Control": "private, max-age=300",
    },
  });
};
