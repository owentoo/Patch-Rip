import type { LoaderFunctionArgs } from "@remix-run/node";

import { withTenant } from "../lib/auth/with-shop";
import prisma from "../db.server";
import { readFile } from "../lib/storage";

export const loader = async ({ params, request }: LoaderFunctionArgs) =>
  withTenant(request, async () => {
    const fileId = params.fileId;
    if (!fileId) throw new Response("Not found", { status: 404 });

    const file = await prisma.proofFile.findFirst({ where: { id: fileId } });
    if (!file) throw new Response("Not found", { status: 404 });

    const buf = await readFile(file.s3Key);

    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": file.mimeType,
        "Content-Disposition": `inline; filename="${file.originalFilename}"`,
        "Cache-Control": "private, max-age=300",
      },
    });
  });
