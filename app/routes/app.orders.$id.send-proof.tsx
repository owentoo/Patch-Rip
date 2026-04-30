import {
  json,
  redirect,
  unstable_createMemoryUploadHandler,
  unstable_parseMultipartFormData,
  type ActionFunctionArgs,
} from "@remix-run/node";

import { withTenant } from "../lib/auth/with-shop";
import prisma from "../db.server";
import {
  ACCEPTED_MIME_TYPES,
  MAX_FILE_SIZE_BYTES,
  buildStorageKey,
  writeFile,
} from "../lib/storage";
import {
  ensureProofForLineItem,
  nextVersionNumber,
} from "../lib/proofs/state";

// "Add To Proof" — uploads file(s) to the per-line-item proof and parks
// it in DRAFTED. The order-level Send action (app.orders.$id.send.tsx)
// is what actually emails the customer.

export const action = async ({ request, params }: ActionFunctionArgs) =>
  withTenant(request, async ({ shop, staffMember }) => {
    const orderId = params.id;
    if (!orderId) throw new Response("Not found", { status: 404 });
    if (!staffMember) {
      return json(
        {
          ok: false,
          error: "Staff identity not available — cannot attribute proof.",
        },
        { status: 400 },
      );
    }

    const order = await prisma.order.findFirst({ where: { id: orderId } });
    if (!order) throw new Response("Not found", { status: 404 });

    const uploadHandler = unstable_createMemoryUploadHandler({
      maxPartSize: MAX_FILE_SIZE_BYTES,
    });
    const formData = await unstable_parseMultipartFormData(request, uploadHandler);

    const lineItemId = (formData.get("lineItemId") as string | null) ?? "";
    const lineItemTitle = (formData.get("lineItemTitle") as string | null) ?? "";
    const lineItemVariantTitle =
      (formData.get("lineItemVariantTitle") as string | null) ?? null;
    const lineItemQuantity = parseInt(
      (formData.get("lineItemQuantity") as string | null) ?? "1",
      10,
    );
    const artworkUrl = (formData.get("artworkUrl") as string | null) ?? null;
    if (!lineItemId || !lineItemTitle) {
      return json(
        { ok: false, error: "Missing line item context for upload" },
        { status: 400 },
      );
    }

    const files = formData
      .getAll("files")
      .filter((f): f is File => f instanceof File);
    const note = (formData.get("note") as string | null) ?? null;

    if (files.length === 0) {
      return json({ ok: false, error: "No files provided" }, { status: 400 });
    }

    for (const f of files) {
      if (f.size > MAX_FILE_SIZE_BYTES) {
        return json(
          { ok: false, error: `${f.name} is larger than the 100 MB limit` },
          { status: 400 },
        );
      }
      if (f.type && !ACCEPTED_MIME_TYPES.has(f.type)) {
        // Lenient — some browsers don't sniff AI/EPS/PSD correctly.
      }
    }

    const proof = await ensureProofForLineItem({
      orderId: order.id,
      shopId: shop.id,
      lineItemId,
      lineItemTitle,
      lineItemVariantTitle:
        lineItemVariantTitle && lineItemVariantTitle.length > 0
          ? lineItemVariantTitle
          : null,
      lineItemQuantity: Number.isFinite(lineItemQuantity) ? lineItemQuantity : 1,
      artworkUrl: artworkUrl && artworkUrl.length > 0 ? artworkUrl : null,
    });
    const versionNumber = await nextVersionNumber(proof.id);

    const version = await prisma.proofVersion.create({
      data: {
        shopId: shop.id,
        proofId: proof.id,
        versionNumber,
        createdByStaffId: staffMember.id,
        note: note?.trim() ? note.trim() : null,
        sentToCustomerAt: null,
      },
    });

    for (const f of files) {
      const storageKey = buildStorageKey({
        shopId: shop.id,
        proofId: proof.id,
        versionNumber,
        filename: f.name,
      });
      const buf = Buffer.from(await f.arrayBuffer());
      await writeFile(storageKey, buf);

      await prisma.proofFile.create({
        data: {
          shopId: shop.id,
          proofVersionId: version.id,
          s3Key: storageKey,
          originalFilename: f.name,
          mimeType: f.type || "application/octet-stream",
          sizeBytes: f.size,
          uploadedByStaffId: staffMember.id,
          scanStatus: "CLEAN",
        },
      });
    }

    await prisma.proof.update({
      where: { id: proof.id },
      data: { currentVersionId: version.id, status: "DRAFTED" },
    });

    await prisma.order.update({
      where: { id: order.id },
      data: { lastActivityByStaffId: staffMember.id },
    });

    return redirect(
      `/app/orders/${orderId}?patch=${encodeURIComponent(lineItemId)}&tab=${encodeURIComponent(version.id)}`,
    );
  });
