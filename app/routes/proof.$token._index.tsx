import { type LoaderFunctionArgs, type ActionFunctionArgs, redirect } from "@remix-run/node";
import { Form, useLoaderData, useNavigation } from "@remix-run/react";

import { prismaBase } from "../db.server";
import { verifyCustomerToken } from "../lib/proofs/token";
import { isDevMode, devModeSuppress } from "../lib/env";

interface ReviewLineItem {
  proofId: string;
  status: string;
  lineItemTitle: string;
  lineItemVariantTitle: string | null;
  lineItemQuantity: number;
  versionNumber: number;
  note: string | null;
  customerComment: string | null;
  files: Array<{
    id: string;
    filename: string;
    mimeType: string;
    previewable: boolean;
  }>;
  pastVersions: Array<{
    versionNumber: number;
    note: string | null;
    customerComment: string | null;
    sentToCustomerAt: string | null;
  }>;
}

interface ReviewPayload {
  orderName: string;
  shopName: string | null;
  brandColor: string;
  shopDomain: string;
  token: string;
  lineItems: ReviewLineItem[];
  allApproved: boolean;
}

export const loader = async ({ params }: LoaderFunctionArgs) => {
  const token = params.token;
  if (!token) throw new Response("Not found", { status: 404 });

  const parsed = verifyCustomerToken(token);
  if (!parsed) throw new Response("Invalid token", { status: 403 });

  const order = await prismaBase.order.findUnique({
    where: { id: parsed.orderId },
    include: {
      shop: true,
      proofs: {
        include: {
          versions: {
            orderBy: { versionNumber: "asc" },
            include: { files: true, revisionRequest: true },
          },
        },
      },
    },
  });

  if (!order || order.signedCustomerToken !== parsed.nonce) {
    throw new Response("Forbidden", { status: 403 });
  }

  // Customer should only see proofs that were actually sent to them.
  // DRAFTED = staff uploaded but hasn't clicked Send Proofs yet;
  // AWAITING_PROOF = nothing uploaded. Both are hidden from this view.
  const sentProofs = order.proofs.filter(
    (p) =>
      p.currentVersionId !== null &&
      p.status !== "AWAITING_PROOF" &&
      p.status !== "DRAFTED",
  );

  const lineItems: ReviewLineItem[] = sentProofs.map((p) => {
    const current = p.versions.find((v) => v.id === p.currentVersionId);
    const past = p.versions.filter((v) => v.id !== p.currentVersionId);

    return {
      proofId: p.id,
      status: p.status,
      lineItemTitle: p.lineItemTitle,
      lineItemVariantTitle: p.lineItemVariantTitle,
      lineItemQuantity: p.lineItemQuantity,
      versionNumber: current?.versionNumber ?? 0,
      note: current?.note ?? null,
      customerComment: current?.revisionRequest?.customerComment ?? null,
      files: (current?.files ?? []).map((f) => ({
        id: f.id,
        filename: f.originalFilename,
        mimeType: f.mimeType,
        previewable:
          f.mimeType.startsWith("image/") &&
          f.mimeType !== "image/tiff" &&
          f.mimeType !== "image/vnd.adobe.photoshop",
      })),
      pastVersions: past.map((v) => ({
        versionNumber: v.versionNumber,
        note: v.note,
        customerComment: v.revisionRequest?.customerComment ?? null,
        sentToCustomerAt: v.sentToCustomerAt?.toISOString() ?? null,
      })),
    };
  });

  const allApproved =
    lineItems.length > 0 && lineItems.every((li) => li.status === "APPROVED");

  const payload: ReviewPayload = {
    orderName: order.orderName,
    shopName: order.shop.name,
    brandColor: order.shop.brandColor ?? "#0F172A",
    shopDomain: order.shop.shopifyDomain,
    token,
    lineItems,
    allApproved,
  };

  return payload;
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const token = params.token;
  if (!token) throw new Response("Not found", { status: 404 });

  const parsed = verifyCustomerToken(token);
  if (!parsed) throw new Response("Invalid token", { status: 403 });

  const order = await prismaBase.order.findUnique({
    where: { id: parsed.orderId },
  });
  if (!order || order.signedCustomerToken !== parsed.nonce) {
    throw new Response("Forbidden", { status: 403 });
  }

  const form = await request.formData();
  const intent = form.get("intent") as string | null;
  const proofId = form.get("proofId") as string | null;
  const comment = (form.get("comment") as string | null)?.trim() ?? "";

  if (!proofId) {
    throw new Response("Missing proofId", { status: 400 });
  }

  const proof = await prismaBase.proof.findFirst({
    where: { id: proofId, orderId: order.id },
  });
  if (!proof) throw new Response("Not found", { status: 404 });
  if (proof.status === "APPROVED") {
    return redirect(`/proof/${token}`);
  }

  if (intent === "approve") {
    await prismaBase.proof.update({
      where: { id: proof.id },
      data: { status: "APPROVED" },
    });
    if (
      devModeSuppress(
        `order tagsAdd "proof approved" on order ${order.shopifyOrderId} (line item ${proof.lineItemId})`,
      )
    ) {
      // skipped in DEV_MODE
    } else {
      // Phase: real Shopify Admin tagsAdd mutation
    }
  } else if (intent === "revise") {
    if (!comment) {
      return { error: "Please add a note describing the changes you'd like." };
    }
    if (proof.currentVersionId) {
      await prismaBase.proofRevisionRequest.upsert({
        where: { proofVersionId: proof.currentVersionId },
        create: {
          shopId: proof.shopId,
          proofVersionId: proof.currentVersionId,
          customerComment: comment,
        },
        update: {
          customerComment: comment,
          requestedAt: new Date(),
        },
      });
    }
    await prismaBase.proof.update({
      where: { id: proof.id },
      data: { status: "REVISIONS_REQUESTED" },
    });
    if (
      devModeSuppress(
        `order tagsAdd "revision needed" on order ${order.shopifyOrderId} (line item ${proof.lineItemId})`,
      )
    ) {
      // skipped in DEV_MODE
    } else {
      // Phase: real Shopify Admin tagsAdd mutation
    }
  }

  return redirect(`/proof/${token}`);
};

export default function CustomerReview() {
  const data = useLoaderData<typeof loader>();
  const nav = useNavigation();
  const submitting = nav.state !== "idle";
  const submittingProofId =
    submitting && nav.formData ? (nav.formData.get("proofId") as string | null) : null;

  const headerStyle: React.CSSProperties = {
    background: data.brandColor,
    color: "#fff",
    padding: "20px 24px",
  };

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Review your proof — {data.orderName}</title>
        <style>{`
          * { box-sizing: border-box; }
          body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: #f6f6f7; color: #111827; }
          main { max-width: 880px; margin: 0 auto; padding: 0 16px 64px; }
          .card { background: #fff; border-radius: 12px; box-shadow: 0 1px 2px rgba(0,0,0,.05); margin-top: 16px; padding: 20px; }
          .preview img { width: 100%; max-height: 600px; object-fit: contain; background: #0b0b0b; border-radius: 8px; }
          .file-card { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border: 1px solid #e5e7eb; border-radius: 8px; }
          button { font-size: 16px; padding: 12px 18px; border-radius: 10px; border: 0; cursor: pointer; font-weight: 600; }
          button[type=submit][value=approve] { background: #15803d; color: white; }
          button[type=submit][value=revise] { background: #fff; color: #111827; border: 1px solid #d1d5db; }
          button[disabled] { opacity: 0.6; cursor: progress; }
          textarea { width: 100%; padding: 10px; border-radius: 8px; border: 1px solid #d1d5db; font: inherit; min-height: 90px; resize: vertical; }
          .badge { display: inline-block; padding: 4px 10px; border-radius: 999px; font-size: 13px; font-weight: 600; }
          .badge-approved { background: #dcfce7; color: #166534; }
          .badge-revise   { background: #fef3c7; color: #92400e; }
          .badge-pending  { background: #dbeafe; color: #1e40af; }
          .past { font-size: 14px; color: #4b5563; }
          .past + .past { margin-top: 12px; padding-top: 12px; border-top: 1px solid #e5e7eb; }
          .meta { font-size: 14px; color: #6b7280; margin-top: 4px; }
          .li-title { font-size: 18px; font-weight: 700; margin: 0; }
          .li-subtitle { font-size: 14px; color: #6b7280; margin: 4px 0 0; }
        `}</style>
      </head>
      <body>
        <header style={headerStyle}>
          <main>
            <h1 style={{ margin: 0, fontSize: 22 }}>
              Your proof — {data.orderName}
            </h1>
            <p style={{ margin: "4px 0 0", opacity: 0.85 }}>
              {data.shopName ?? data.shopDomain}
            </p>
          </main>
        </header>

        <main>
          {data.allApproved ? (
            <div className="card">
              <span className="badge badge-approved">All items approved</span>
              <p style={{ marginTop: 12 }}>
                Thanks! All items on this order are approved and moving to
                production.
              </p>
            </div>
          ) : null}

          {data.lineItems.length === 0 ? (
            <div className="card">
              <p>The proof for this order is not ready yet.</p>
            </div>
          ) : null}

          {data.lineItems.map((li) => {
            const approved = li.status === "APPROVED";
            const revising = li.status === "REVISIONS_REQUESTED";
            const submittingThis = submittingProofId === li.proofId;
            return (
              <div className="card" key={li.proofId}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
                  <div>
                    <p className="li-title">{li.lineItemTitle}</p>
                    <p className="li-subtitle">
                      {li.lineItemVariantTitle ? `${li.lineItemVariantTitle} · ` : ""}
                      Qty {li.lineItemQuantity} · Version {li.versionNumber}
                    </p>
                  </div>
                  <span
                    className={
                      approved
                        ? "badge badge-approved"
                        : revising
                          ? "badge badge-revise"
                          : "badge badge-pending"
                    }
                  >
                    {approved
                      ? "Approved"
                      : revising
                        ? "Changes requested"
                        : "Awaiting your review"}
                  </span>
                </div>

                {li.note ? (
                  <p style={{ marginTop: 10 }}>{li.note}</p>
                ) : null}

                <div className="preview" style={{ marginTop: 12 }}>
                  {li.files.map((f) =>
                    f.previewable ? (
                      <img
                        key={f.id}
                        src={`/proof/${data.token}/file/${f.id}`}
                        alt={f.filename}
                      />
                    ) : (
                      <div key={f.id} className="file-card" style={{ marginTop: 8 }}>
                        <span>📎 {f.filename}</span>
                        <a href={`/proof/${data.token}/file/${f.id}`} download>
                          Download
                        </a>
                      </div>
                    ),
                  )}
                </div>

                {!approved ? (
                  <Form method="post" style={{ marginTop: 16 }}>
                    <input type="hidden" name="proofId" value={li.proofId} />
                    <textarea
                      name="comment"
                      placeholder={
                        revising
                          ? "Want to update your previous note? (optional)"
                          : "(Optional unless requesting changes) — what would you like adjusted?"
                      }
                      defaultValue={revising ? li.customerComment ?? "" : ""}
                    />
                    <div
                      style={{
                        display: "flex",
                        gap: 12,
                        marginTop: 12,
                        flexWrap: "wrap",
                      }}
                    >
                      <button
                        type="submit"
                        name="intent"
                        value="approve"
                        disabled={submittingThis || submitting}
                      >
                        {submittingThis ? "Saving…" : "Approve"}
                      </button>
                      <button
                        type="submit"
                        name="intent"
                        value="revise"
                        disabled={submittingThis || submitting}
                      >
                        Request changes
                      </button>
                    </div>
                  </Form>
                ) : null}

                {revising && li.customerComment ? (
                  <div className="meta" style={{ marginTop: 10 }}>
                    <strong>Your latest note:</strong> {li.customerComment}
                  </div>
                ) : null}

                {li.pastVersions.length > 0 ? (
                  <details style={{ marginTop: 16 }}>
                    <summary style={{ cursor: "pointer", color: "#374151" }}>
                      Earlier versions of this item ({li.pastVersions.length})
                    </summary>
                    <div style={{ marginTop: 8 }}>
                      {li.pastVersions.map((v) => (
                        <div key={v.versionNumber} className="past">
                          <strong>Version {v.versionNumber}</strong>
                          {v.sentToCustomerAt
                            ? ` · sent ${new Date(v.sentToCustomerAt).toLocaleDateString()}`
                            : ""}
                          {v.note ? <div>{v.note}</div> : null}
                          {v.customerComment ? (
                            <div style={{ marginTop: 4 }}>
                              <em>You requested:</em> {v.customerComment}
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </details>
                ) : null}
              </div>
            );
          })}

          {isDevMode() && data.lineItems.length > 0 && !data.allApproved ? (
            <div
              className="card"
              style={{
                fontSize: 12,
                color: "#92400e",
                background: "#fffbeb",
              }}
            >
              DEV_MODE: your responses are recorded internally but no email or
              Shopify tag mutation is sent.
            </div>
          ) : null}
        </main>
      </body>
    </html>
  );
}
