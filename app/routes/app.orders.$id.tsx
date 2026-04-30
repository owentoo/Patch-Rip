import { useEffect, useRef, useState } from "react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import {
  Form,
  useLoaderData,
  useNavigate,
  useNavigation,
  useSearchParams,
  useSubmit,
} from "@remix-run/react";
import {
  Card,
  Text,
  Button,
  BlockStack,
  InlineStack,
  Icon,
} from "@shopify/polaris";
import { HeaderShell } from "../lib/header-shell";
import { TitleBar } from "@shopify/app-bridge-react";
import {
  ArrowLeftIcon,
  MagicIcon,
  UploadIcon,
  XIcon,
} from "@shopify/polaris-icons";

import { withTenant } from "../lib/auth/with-shop";
import prisma from "../db.server";
import { fetchOrderDetail, type AdminOrderDetail } from "../lib/orders/detail-graphql";
import { isProofTriggerProduct } from "../lib/orders/trigger-detection";
import {
  PROOF_STATUS_CLASS,
  PROOF_STATUS_LABEL,
  type ProofStatus,
} from "../lib/proofs/status-display";
import orderDetailStyles from "../styles/order-detail.css?url";

export const links = () => [{ rel: "stylesheet", href: orderDetailStyles }];

interface PatchProofFile {
  id: string;
  filename: string;
  mimeType: string;
  previewable: boolean;
}

interface PatchProofVersion {
  id: string;
  versionNumber: number;
  isCurrent: boolean;
  createdBy: string;
  createdAt: string;
  sentToCustomerAt: string | null;
  note: string | null;
  customerComment: string | null;
  files: PatchProofFile[];
}

interface PatchProof {
  id: string;
  status: ProofStatus;
  versions: PatchProofVersion[];
}

interface Patch {
  lineItemId: string;
  title: string;
  variantTitle: string | null;
  quantity: number;
  artworkUrl: string | null;
  proof: PatchProof | null;
  customAttributes: Array<{ key: string; value: string }>;
}

export const loader = async ({ params, request }: LoaderFunctionArgs) =>
  withTenant(request, async ({ admin, shop, staffMember }) => {
    const id = params.id;
    if (!id) throw new Response("Not found", { status: 404 });

    const order = await prisma.order.findFirst({
      where: { id },
      include: {
        proofs: {
          include: {
            versions: {
              orderBy: { versionNumber: "asc" },
              include: {
                files: true,
                revisionRequest: true,
                createdByStaff: true,
              },
            },
          },
        },
      },
    });

    if (!order) throw new Response("Not found", { status: 404 });

    let adminDetail: AdminOrderDetail | null = null;
    try {
      adminDetail = await fetchOrderDetail(admin, order.shopifyOrderId);
    } catch (err) {
      console.error("[order-detail] GraphQL fetch failed", err);
    }

    const proofsByLineItemId = new Map<string, (typeof order.proofs)[number]>();
    for (const p of order.proofs) {
      proofsByLineItemId.set(p.lineItemId, p);
    }

    const patches: Patch[] = (adminDetail?.lineItems ?? [])
      .filter((li) => !isProofTriggerProduct({ title: li.title }))
      .map((li) => {
        const p = proofsByLineItemId.get(li.id);
        const proof: PatchProof | null = p
          ? {
              id: p.id,
              status: p.status as ProofStatus,
              versions: p.versions.map((v) => ({
                id: v.id,
                versionNumber: v.versionNumber,
                isCurrent: v.id === p.currentVersionId,
                createdBy:
                  v.createdByStaff?.name ?? v.createdByStaff?.email ?? "Unknown",
                createdAt: v.createdAt.toISOString(),
                sentToCustomerAt: v.sentToCustomerAt?.toISOString() ?? null,
                note: v.note,
                customerComment: v.revisionRequest?.customerComment ?? null,
                files: v.files.map((f) => ({
                  id: f.id,
                  filename: f.originalFilename,
                  mimeType: f.mimeType,
                  previewable:
                    f.mimeType.startsWith("image/") &&
                    f.mimeType !== "image/tiff" &&
                    f.mimeType !== "image/vnd.adobe.photoshop",
                })),
              })),
            }
          : null;
        return {
          lineItemId: li.id,
          title: li.title,
          variantTitle: li.variantTitle,
          quantity: li.quantity,
          artworkUrl: li.artworkUrl,
          proof,
          customAttributes: li.customAttributes,
        };
      });

    // Shopify admin URL for the "View In Shopify" link. Strip the
    // .myshopify.com suffix to get the store handle.
    const storeHandle = shop.shopifyDomain.replace(/\.myshopify\.com$/, "");
    const shopifyAdminOrderUrl = `https://admin.shopify.com/store/${storeHandle}/orders/${order.shopifyOrderId}`;

    return {
      order: {
        id: order.id,
        orderName: order.orderName,
        shopifyOrderId: order.shopifyOrderId,
        shopifyCreatedAt: order.shopifyCreatedAt.toISOString(),
        proofPaid: order.proofPaid,
        note: adminDetail?.note ?? null,
        shopifyAdminUrl: shopifyAdminOrderUrl,
      },
      customer: adminDetail?.customer ?? null,
      staff: staffMember
        ? { name: staffMember.name, email: staffMember.email }
        : null,
      patches,
    };
  });

function formatOrderDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.round(ms / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec} seconds ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day} day${day === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString();
}

const HIDDEN_PROPERTY_KEYS = new Set<string>([
  "discount_input",
  "discount_name",
]);

function isHiddenProperty(key: string): boolean {
  const normalized = key.replace(/^_+/, "").toLowerCase();
  return HIDDEN_PROPERTY_KEYS.has(normalized);
}

function prettyLabel(key: string): string {
  return key.replace(/^_+/, "").replace(/_/g, " ").trim() || key;
}

// Shopify ships custom-attribute values application/x-www-form-urlencoded
// in the order webhook payload. Decode `+` -> space, then percent-decode.
function decodeAttrValue(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

const URL_RE = /^https?:\/\//i;

export default function OrderDetail() {
  const { order, customer: _customer, staff, patches } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const submit = useSubmit();
  const navigation = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();

  const activePatchId = searchParams.get("patch") ?? patches[0]?.lineItemId ?? "";
  const activePatch = patches.find((p) => p.lineItemId === activePatchId) ?? patches[0];

  const setActivePatch = (lineItemId: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("patch", lineItemId);
    next.delete("tab");
    setSearchParams(next, { preventScrollReset: true });
  };

  if (!activePatch) {
    return (
      <>
        <TitleBar title={`PatchSensei — ${order.orderName}`} />
        <HeaderShell activeTab="proofs" />
        <div className="content">
          <BlockStack gap="400">
            <InlineStack gap="200" blockAlign="center">
              <Button
                icon={ArrowLeftIcon}
                variant="tertiary"
                accessibilityLabel="Back to proofs"
                onClick={() => navigate("/app/proofs")}
              />
              <Text as="h2" variant="headingLg">
                {order.orderName}
              </Text>
            </InlineStack>
            <Card>
              <Text as="p" variant="bodyMd" tone="subdued">
                No patches requiring a proof on this order.
              </Text>
            </Card>
          </BlockStack>
        </div>
      </>
    );
  }

  // Patches with a draft proof attached but not yet sent to the customer.
  const draftCount = patches.filter(
    (p) => p.proof?.status === "DRAFTED",
  ).length;
  const sendActionUrl = `/app/orders/${order.id}/send`;
  const isSendingOrder =
    navigation.state === "submitting" &&
    navigation.formAction === sendActionUrl;

  return (
    <>
      <TitleBar title={`PatchSensei — ${order.orderName}`} />
      <HeaderShell activeTab="proofs" />
      <div className="content">
        <BlockStack gap="400">
          <InlineStack
            gap="200"
            blockAlign="center"
            align="space-between"
            wrap
          >
            <InlineStack gap="200" blockAlign="center">
              <Button
                icon={ArrowLeftIcon}
                variant="tertiary"
                accessibilityLabel="Back to proofs"
                onClick={() => navigate("/app/proofs")}
              />
              <BlockStack gap="050">
                <Text as="h2" variant="headingLg">
                  {order.orderName}
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  {formatOrderDate(order.shopifyCreatedAt)} from Online Store
                </Text>
              </BlockStack>
            </InlineStack>
            <Button
              variant="primary"
              onClick={() =>
                submit(null, { method: "post", action: sendActionUrl })
              }
              disabled={draftCount === 0 || isSendingOrder}
              loading={isSendingOrder}
            >
              {draftCount > 0
                ? `Send to Customer (${draftCount})`
                : "Send to Customer"}
            </Button>
          </InlineStack>

          <PatchStrip
            patches={patches}
            activePatchId={activePatch.lineItemId}
            onSelect={setActivePatch}
          />

          <div className="ps-layout">
            <BlockStack gap="400">
              <ImagesCard
                key={`images-${activePatch.lineItemId}`}
                patch={activePatch}
              />
              <OrderDetailsCard
                orderNote={order.note}
                attrs={activePatch.customAttributes}
                shopifyAdminUrl={order.shopifyAdminUrl}
              />
            </BlockStack>

            <TimelineCard
              key={`timeline-${activePatch.lineItemId}`}
              orderId={order.id}
              patch={activePatch}
              orderCreatedAt={order.shopifyCreatedAt}
              staffName={staff?.name ?? staff?.email ?? null}
            />
          </div>
        </BlockStack>
      </div>
    </>
  );
}

function StatusPill({ status }: { status: ProofStatus | null }) {
  const s = status ?? "AWAITING_PROOF";
  return (
    <span className={`ps-status-pill ${PROOF_STATUS_CLASS[s]}`}>
      <span className="ps-dot" />
      {PROOF_STATUS_LABEL[s]}
    </span>
  );
}

function PatchStrip({
  patches,
  activePatchId,
  onSelect,
}: {
  patches: Patch[];
  activePatchId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <Card>
      <BlockStack gap="200">
        <Text as="span" variant="bodySm" tone="subdued">
          Patches in this order ({patches.length})
        </Text>
        <div className="ps-patch-strip">
          {patches.map((p) => {
            const cv =
              p.proof?.versions.find((v) => v.isCurrent) ??
              p.proof?.versions[p.proof.versions.length - 1] ??
              null;
            const previewable = cv?.files.find((f) => f.previewable);
            const status: ProofStatus = p.proof?.status ?? "AWAITING_PROOF";
            return (
              <button
                key={p.lineItemId}
                className={`ps-patch-card ${
                  activePatchId === p.lineItemId ? "active" : ""
                }`}
                onClick={() => onSelect(p.lineItemId)}
                type="button"
              >
                <div className="ps-patch-card-thumb">
                  {previewable ? (
                    <img src={`/app/files/${previewable.id}`} alt="" />
                  ) : p.artworkUrl ? (
                    <img src={p.artworkUrl} alt="" />
                  ) : null}
                </div>
                <div className="ps-patch-card-meta">
                  <div className="ps-patch-card-name">{p.title}</div>
                  <div className="ps-patch-card-sub">Qty {p.quantity}</div>
                  <StatusPill status={status} />
                </div>
              </button>
            );
          })}
        </div>
      </BlockStack>
    </Card>
  );
}

function ImagesCard({ patch }: { patch: Patch }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const versions = patch.proof?.versions ?? [];
  const latest = versions[versions.length - 1] ?? null;
  const defaultTab: string =
    searchParams.get("tab") ?? (latest ? latest.id : "artwork");

  const setTab = (tab: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", tab);
    setSearchParams(next, { preventScrollReset: true });
  };

  const isArtwork = defaultTab === "artwork";
  const isAiProof = defaultTab === "ai-proof";
  const activeVersion = versions.find((v) => v.id === defaultTab) ?? null;

  return (
    <Card>
      <BlockStack gap="0">
        <div className="ps-card-heading">
          <Text as="h2" variant="headingMd">
            Images
          </Text>
          <StatusPill status={patch.proof?.status ?? "AWAITING_PROOF"} />
        </div>
        <div className="ps-tabs" style={{ marginTop: 8 }}>
          <button
            type="button"
            className={`ps-tab ${isArtwork ? "active" : ""}`}
            onClick={() => setTab("artwork")}
          >
            Customer Artwork
          </button>
          <button
            type="button"
            className={`ps-tab ${isAiProof ? "active" : ""}`}
            onClick={() => setTab("ai-proof")}
          >
            AI Mockup
          </button>
          {versions.map((v, idx) => (
            <button
              key={v.id}
              type="button"
              className={`ps-tab ${defaultTab === v.id ? "active" : ""}`}
              onClick={() => setTab(v.id)}
            >
              Proof {idx + 1}
            </button>
          ))}
        </div>

        {isArtwork ? (
          <ArtworkPanel patch={patch} />
        ) : isAiProof ? (
          <AiProofPanel />
        ) : activeVersion ? (
          <ProofPanel
            version={activeVersion}
            proofStatus={patch.proof?.status ?? "AWAITING_PROOF"}
          />
        ) : null}
      </BlockStack>
    </Card>
  );
}

function AiProofPanel() {
  return (
    <BlockStack gap="200">
      <div className="ps-image-caption">
        <div className="ps-image-caption-main">
          <span className="ps-image-caption-meta">
            AI-generated mockup based on the customer's order details.
          </span>
        </div>
      </div>
      <div className="ps-upload-frame empty">
        <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "center" }}>
          <span style={{ fontWeight: 600 }}>Not yet generated</span>
          <span style={{ fontSize: 13 }}>
            Click <strong>Generate AI proof</strong> in the Timeline to render one.
          </span>
        </div>
      </div>
    </BlockStack>
  );
}

function ArtworkPanel({ patch }: { patch: Patch }) {
  return (
    <BlockStack gap="200">
      <div className="ps-image-caption">
        <div className="ps-image-caption-main">
          <span className="ps-image-caption-meta">
            {patch.artworkUrl
              ? "Uploaded by customer at checkout"
              : "No artwork attached"}
          </span>
        </div>
      </div>
      <div className={`ps-upload-frame ${patch.artworkUrl ? "" : "empty"}`}>
        {patch.artworkUrl ? (
          <img src={patch.artworkUrl} alt="Customer-uploaded artwork" />
        ) : (
          "No artwork attached to this line item."
        )}
      </div>
    </BlockStack>
  );
}

function ProofPanel({
  version,
  proofStatus,
}: {
  version: PatchProofVersion;
  proofStatus: ProofStatus;
}) {
  const previewable = version.files.find((f) => f.previewable);
  // The status pill on the proof reflects the parent proof's current
  // status if this version is the current one; otherwise it's a
  // historical version (no live status).
  const showLiveStatus = version.isCurrent;
  return (
    <BlockStack gap="200">
      <div className="ps-image-caption">
        <div className="ps-image-caption-main">
          {showLiveStatus ? <StatusPill status={proofStatus} /> : null}
          <span className="ps-image-caption-meta">
            {version.files[0]?.filename
              ? version.files[0].filename
              : `Version ${version.versionNumber}`}
          </span>
        </div>
        {version.sentToCustomerAt ? (
          <span className="ps-image-caption-meta">
            Sent {relativeTime(version.sentToCustomerAt)}
          </span>
        ) : (
          <span className="ps-image-caption-meta">Not sent yet</span>
        )}
      </div>
      <div className="ps-upload-frame">
        {previewable ? (
          <img
            src={`/app/files/${previewable.id}`}
            alt={`Proof v${version.versionNumber}`}
          />
        ) : (
          <span className="ps-image-caption-meta">No preview available</span>
        )}
      </div>
      {version.customerComment && proofStatus === "REVISIONS_REQUESTED" ? (
        <div className="ps-revision-note">
          <div className="ps-revision-note-label">Requested changes</div>
          <div>{version.customerComment}</div>
        </div>
      ) : null}
      {version.note ? (
        <div className="ps-revision-note" style={{ background: "#f6f6f7", borderColor: "#e1e3e5" }}>
          <div className="ps-revision-note-label" style={{ color: "#4a4a4a" }}>Internal note</div>
          <div>{version.note}</div>
        </div>
      ) : null}
    </BlockStack>
  );
}

function OrderDetailsCard({
  orderNote,
  attrs,
  shopifyAdminUrl,
}: {
  orderNote: string | null;
  attrs: Array<{ key: string; value: string }>;
  shopifyAdminUrl: string;
}) {
  const filtered = attrs.filter(
    (a) => !isHiddenProperty(a.key) && !URL_RE.test(a.value),
  );
  const visible = filtered.filter((a) => !a.key.startsWith("_"));
  const internal = filtered.filter((a) => a.key.startsWith("_"));
  const ordered = [...visible, ...internal];

  return (
    <Card>
      <BlockStack gap="300">
        <div className="ps-card-heading">
          <Text as="h2" variant="headingMd">
            Order Details
          </Text>
          <a
            href={shopifyAdminUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ps-heading-link"
          >
            View In Shopify
          </a>
        </div>
        {orderNote ? (
          <div className="ps-customer-notes">
            <div className="ps-customer-notes-label">Customer Notes</div>
            <div style={{ whiteSpace: "pre-wrap" }}>{orderNote}</div>
          </div>
        ) : null}
        {ordered.length > 0 ? (
          <dl className="ps-detail-list">
            {ordered.map((a, i) => (
              <FragmentRow
                key={`${a.key}-${i}`}
                k={prettyLabel(a.key)}
                v={decodeAttrValue(a.value)}
              />
            ))}
          </dl>
        ) : null}
      </BlockStack>
    </Card>
  );
}

function FragmentRow({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

interface ComposerAttachment {
  id: string;
  file: File;
}

function TimelineCard({
  orderId,
  patch,
  orderCreatedAt,
  staffName,
}: {
  orderId: string;
  patch: Patch;
  orderCreatedAt: string;
  staffName: string | null;
}) {
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSending =
    navigation.state === "submitting" &&
    navigation.formAction === `/app/orders/${orderId}/send-proof`;

  // Reset composer when patch changes
  useEffect(() => {
    setAttachments([]);
    setNote("");
    setError(null);
  }, [patch.lineItemId]);

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const onFilesPicked = (list: FileList | null) => {
    if (!list) return;
    const next = Array.from(list).map((file) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      file,
    }));
    setAttachments((prev) => [...prev, ...next]);
    setError(null);
  };

  const onSendProof = () => {
    if (attachments.length === 0) {
      setError(
        "Attach an image with Generate AI proof or Upload image before sending.",
      );
      return;
    }
    if (!formRef.current) return;
    submit(formRef.current);
  };

  const initials = (staffName ?? "?")
    .split(/[\s@.]+/)
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  // Build chronological timeline events from the patch's proof + versions
  const events = buildTimelineEvents(patch, orderCreatedAt);

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          Timeline
        </Text>

        <div className="ps-action-grid">
          <Button disabled icon={MagicIcon}>
            Generate AI Mockup
          </Button>
          <Button
            onClick={() => fileInputRef.current?.click()}
            icon={UploadIcon}
          >
            Upload image
          </Button>
        </div>

        <Form
          ref={formRef}
          method="post"
          action={`/app/orders/${orderId}/send-proof`}
          encType="multipart/form-data"
        >
          <input type="hidden" name="lineItemId" value={patch.lineItemId} />
          <input type="hidden" name="lineItemTitle" value={patch.title} />
          <input
            type="hidden"
            name="lineItemVariantTitle"
            value={patch.variantTitle ?? ""}
          />
          <input
            type="hidden"
            name="lineItemQuantity"
            value={String(patch.quantity)}
          />
          <input type="hidden" name="artworkUrl" value={patch.artworkUrl ?? ""} />
          <input type="hidden" name="proofKind" value="UPLOAD" />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,application/pdf,.ai,.eps,.svg,.psd,.zip"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              onFilesPicked(e.target.files);
              e.target.value = "";
            }}
          />
          {attachments.map((a, i) => (
            <input
              key={a.id}
              type="file"
              name="files"
              hidden
              ref={(el) => {
                if (!el) return;
                const dt = new DataTransfer();
                dt.items.add(a.file);
                el.files = dt.files;
              }}
              data-i={i}
            />
          ))}

          <div className={`ps-composer ${error ? "ps-composer-error" : ""}`}>
            {attachments.length > 0 ? (
              <div className="ps-attachments">
                {attachments.map((a) => (
                  <AttachmentChip
                    key={a.id}
                    file={a.file}
                    onRemove={() => removeAttachment(a.id)}
                  />
                ))}
              </div>
            ) : null}
            <div className="ps-composer-row">
              <div className="ps-avatar">{initials}</div>
              <textarea
                name="note"
                placeholder="Add notes for this proof"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    onSendProof();
                  }
                }}
                rows={2}
              />
            </div>
            <div className="ps-composer-actions">
              <span className="ps-composer-help">
                {error ??
                  (attachments.length > 0
                    ? `${attachments.length} attachment${attachments.length === 1 ? "" : "s"} will be sent`
                    : "Attach an image to send a proof")}
              </span>
              <Button
                variant="primary"
                onClick={onSendProof}
                disabled={attachments.length === 0 || isSending}
                loading={isSending}
              >
                Add To Proof
              </Button>
            </div>
          </div>
        </Form>

        <TimelineList events={events} />
      </BlockStack>
    </Card>
  );
}

function AttachmentChip({
  file,
  onRemove,
}: {
  file: File;
  onRemove: () => void;
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file.type.startsWith("image/")) return;
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  return (
    <div className="ps-attachment">
      <div className="ps-attachment-thumb">
        {previewUrl ? <img src={previewUrl} alt={file.name} /> : file.name}
      </div>
      <div
        style={{ display: "flex", justifyContent: "space-between", gap: 4 }}
      >
        <span className="ps-attachment-name" title={file.name}>
          {file.name}
        </span>
        <button
          type="button"
          onClick={onRemove}
          style={{
            border: 0,
            background: "transparent",
            cursor: "pointer",
            color: "#6b7177",
          }}
          aria-label="Remove attachment"
        >
          <Icon source={XIcon} />
        </button>
      </div>
    </div>
  );
}

interface TimelineEvent {
  id: string;
  kind:
    | "customer_artwork"
    | "drafted"
    | "proof_sent"
    | "approved"
    | "changes"
    | "uploaded";
  title: string;
  body: string | null;
  time: string;
  thumbFileId: string | null;
  thumbUrl: string | null;
}

function buildTimelineEvents(
  patch: Patch,
  orderCreatedAt: string,
): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  // Seed: every patch's timeline starts with the customer-uploaded artwork
  // received with the order.
  events.push({
    id: `artwork-${patch.lineItemId}`,
    kind: "customer_artwork",
    title: "Customer Uploaded Artwork",
    body: patch.artworkUrl ? null : "No artwork was attached at checkout.",
    time: orderCreatedAt,
    thumbFileId: null,
    thumbUrl: patch.artworkUrl,
  });

  const versions = patch.proof?.versions ?? [];
  for (const v of versions) {
    const previewable = v.files.find((f) => f.previewable);
    // Always log when staff added a draft. If it was later sent, the
    // separate `proof_sent` event below covers that.
    events.push({
      id: `drafted-${v.id}`,
      kind: "drafted",
      title: `Added v${v.versionNumber} to proof`,
      body: v.note,
      time: v.createdAt,
      thumbFileId: previewable?.id ?? null,
      thumbUrl: null,
    });
    if (v.sentToCustomerAt) {
      events.push({
        id: `sent-${v.id}`,
        kind: "proof_sent",
        title: `Sent v${v.versionNumber} to customer`,
        body: null,
        time: v.sentToCustomerAt,
        thumbFileId: previewable?.id ?? null,
        thumbUrl: null,
      });
    }
    if (v.customerComment) {
      events.push({
        id: `changes-${v.id}`,
        kind: "changes",
        title: "Customer requested changes",
        body: v.customerComment,
        // We don't have a separate timestamp on the revision request in this
        // view; use the version's createdAt as a stand-in.
        time: v.createdAt,
        thumbFileId: null,
        thumbUrl: null,
      });
    }
  }
  if (patch.proof?.status === "APPROVED") {
    const lastSent = versions
      .slice()
      .reverse()
      .find((v) => v.sentToCustomerAt);
    if (lastSent) {
      events.push({
        id: `approved-${patch.proof.id}`,
        kind: "approved",
        title: "Customer approved the proof",
        body: null,
        time: lastSent.sentToCustomerAt ?? lastSent.createdAt,
        thumbFileId: null,
        thumbUrl: null,
      });
    }
  }
  // newest first — Customer Uploaded Artwork (orderCreatedAt) is the oldest
  // event, so it ends up at the bottom of the rendered list.
  events.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
  return events;
}

function TimelineList({ events }: { events: TimelineEvent[] }) {
  if (events.length === 0) {
    return (
      <Text as="p" variant="bodySm" tone="subdued">
        No activity yet. Generate or upload a proof above to send it to the
        customer.
      </Text>
    );
  }
  return (
    <div className="ps-timeline-scroll">
      <div className="ps-timeline-day">Activity</div>
      <ul className="ps-timeline-list">
        {events.map((e) => (
          <li
            key={e.id}
            className={`ps-timeline-item ${
              e.kind === "proof_sent"
                ? "proof"
                : e.kind === "approved"
                  ? "approved"
                  : e.kind === "changes"
                    ? "changes"
                    : e.kind === "drafted"
                      ? "drafted"
                      : ""
            }`}
          >
            <div className="ps-timeline-content">
              <div className="ps-timeline-title">{e.title}</div>
              {e.body ? (
                <div
                  className="ps-timeline-body"
                  style={{ whiteSpace: "pre-wrap" }}
                >
                  {e.body}
                </div>
              ) : null}
              {e.thumbFileId ? (
                <div className="ps-proof-thumb">
                  <img src={`/app/files/${e.thumbFileId}`} alt="" />
                </div>
              ) : e.thumbUrl ? (
                <div className="ps-proof-thumb">
                  <img src={e.thumbUrl} alt="" />
                </div>
              ) : null}
            </div>
            <div className="ps-timeline-time">{relativeTime(e.time)}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}
