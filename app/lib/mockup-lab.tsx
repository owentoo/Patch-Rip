import { useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  ButtonGroup,
  Card,
  DropZone,
  InlineGrid,
  InlineStack,
  Modal,
  Select,
  Spinner,
  Text,
  TextField,
} from "@shopify/polaris";

// Polaris Mockup Lab — same 21-style ranking flow as the legacy build, with
// drag-drop upload, conditional spec fields per style group (per ML_GROUP_RULES),
// ranking call, polling, results panel.

// ─── Auth-passing fetch (matches app._index.tsx apiFetch) ─────────────────
async function getAuthToken(): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    if (w.shopify?.idToken) return await w.shopify.idToken();
  } catch {
    /* no-op */
  }
  return null;
}
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getAuthToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (!headers.has("Content-Type") && init.body)
    headers.set("Content-Type", "application/json");
  const r = await fetch(path, { ...init, headers });
  if (!r.ok) throw new Error(`API error: ${r.status}`);
  return (await r.json()) as T;
}

// ─── Style metadata (matches legacy ML_STYLE_GROUPS / ML_GROUP_RULES) ─────
const STYLE_GROUPS: Record<string, string> = {
  STANDARD_EMBROIDERY: "EMBROIDERY",
  "3D_EMBROIDERY": "EMBROIDERY",
  WOVEN_PATCHES: "EMBROIDERY",
  FULL_COLOR_PRINTED_PATCHES: "EMBROIDERY",
  CUSTOM_EMBROIDERED_NAME_PATCHES: "EMBROIDERY",
  CUSTOM_TACKLE_TWILL_LETTERS: "EMBROIDERY",
  CHENILLE_PATCHES: "CHENILLE",
  STANDARD_PVC_RUBBER_PATCHES: "PVC",
  GLOW_PVC_PATCHES: "PVC",
  SILICONE_PATCHES: "PVC",
  RUBBER_KEYCHAINS: "PVC",
  GENUINE_LEATHER_PATCHES: "LEATHER_GENUINE",
  FAUX_LEATHER_PATCHES: "LEATHER_FAUX",
  METALLIC_FLEX_PATCHES: "FLEX_COLOR",
  FULL_COLOR_FLEX_PATCHES: "FLEX_COLOR",
  MATTE_BLACK_FLEX_PATCHES: "FLEX_NOCOLOR",
  MATTE_WHITE_FLEX_PATCHES: "FLEX_NOCOLOR",
  CHROME_FLEX_PATCHES: "FLEX_NOCOLOR",
  STICKERS: "STICKERS",
  BUMPER_STICKERS: "BUMPER",
  TRUCK_STICKERS: "TRUCK",
};

interface GroupRules {
  shape: "standard" | "flex" | false;
  fixedShape?: string;
  sizeSelector?: "bumper" | "truck";
  cornerStyle: boolean;
  borderStyle: "choice" | "locked" | false;
  bgColor: boolean;
  borderThreadColor: boolean;
  leatherColor?: "genuine" | "faux";
  bgTexture?: boolean;
  bgOption?: boolean;
  finish?: boolean;
  borderThickness?: boolean;
}

const GROUP_RULES: Record<string, GroupRules> = {
  EMBROIDERY: {
    shape: "standard",
    cornerStyle: true,
    borderStyle: "choice",
    bgColor: true,
    borderThreadColor: true,
  },
  CHENILLE: {
    shape: "standard",
    cornerStyle: true,
    borderStyle: "locked",
    bgColor: true,
    borderThreadColor: true,
  },
  PVC: {
    shape: "standard",
    cornerStyle: false,
    borderStyle: false,
    bgColor: true,
    borderThreadColor: false,
  },
  LEATHER_GENUINE: {
    shape: "standard",
    cornerStyle: false,
    borderStyle: false,
    bgColor: false,
    borderThreadColor: false,
    leatherColor: "genuine",
  },
  LEATHER_FAUX: {
    shape: "standard",
    cornerStyle: false,
    borderStyle: false,
    bgColor: false,
    borderThreadColor: false,
    leatherColor: "faux",
  },
  FLEX_COLOR: {
    shape: "flex",
    cornerStyle: false,
    borderStyle: false,
    bgColor: true,
    borderThreadColor: false,
    bgTexture: true,
  },
  FLEX_NOCOLOR: {
    shape: "flex",
    cornerStyle: false,
    borderStyle: false,
    bgColor: false,
    borderThreadColor: false,
    bgTexture: true,
  },
  STICKERS: {
    shape: "standard",
    cornerStyle: true,
    borderStyle: "choice",
    bgColor: false,
    borderThreadColor: false,
    bgOption: true,
    finish: true,
    borderThickness: true,
  },
  BUMPER: {
    shape: false,
    fixedShape: "Rectangle",
    sizeSelector: "bumper",
    cornerStyle: true,
    borderStyle: "choice",
    bgColor: false,
    borderThreadColor: false,
    bgOption: true,
    finish: true,
    borderThickness: true,
  },
  TRUCK: {
    shape: false,
    fixedShape: "Rectangle",
    sizeSelector: "truck",
    cornerStyle: true,
    borderStyle: "choice",
    bgColor: false,
    borderThreadColor: false,
    bgOption: true,
    finish: true,
    borderThickness: true,
  },
};

const SHAPES_STANDARD = ["Circle", "Square", "Rectangle", "Oval", "Custom Shape"];
const SHAPES_FLEX = [...SHAPES_STANDARD, "Free Form"];
const LEATHER_GENUINE = ["Sand", "Brown", "Dark Brown"];
const LEATHER_FAUX = [
  "Black/Silver",
  "Light Brown w/ Black Imprint",
  "Dark Brown w/ Black Imprint",
  "Tan w/ Black Imprint",
];
const TEXTURES = ["Flat", "Vertical", "Wave", "Horizontal", "Chevron"];
const BG_OPTIONS = ["White", "Transparent"];
const FINISHES = ["Gloss", "Matte"];
const BORDER_THICKNESSES = ['Large 1/4"', 'Medium 1/8"', "No Border Kiss Cut"];
const BUMPER_SIZES = ['3" x 9"', '5" x 15"', '6" x 18"'];
const TRUCK_SIZES = ['12" x 24"', '12" x 36"', '12" x 48"'];

// ─── Style display labels (for results) ──────────────────────────────────
const STYLE_LABELS: Record<string, string> = {
  STANDARD_EMBROIDERY: "Embroidered",
  "3D_EMBROIDERY": "3D Embroidery",
  WOVEN_PATCHES: "Woven",
  FULL_COLOR_PRINTED_PATCHES: "Full Color Printed",
  CHENILLE_PATCHES: "Chenille",
  STANDARD_PVC_RUBBER_PATCHES: "PVC Rubber",
  SILICONE_PATCHES: "Silicone",
  GLOW_PVC_PATCHES: "Glow PVC",
  METALLIC_FLEX_PATCHES: "Metallic Flex",
  CHROME_FLEX_PATCHES: "Chrome Flex",
  MATTE_WHITE_FLEX_PATCHES: "Matte White Flex",
  MATTE_BLACK_FLEX_PATCHES: "Matte Black Flex",
  FULL_COLOR_FLEX_PATCHES: "Full Color Flex",
  GENUINE_LEATHER_PATCHES: "Genuine Leather",
  FAUX_LEATHER_PATCHES: "Faux Leather",
  CUSTOM_EMBROIDERED_NAME_PATCHES: "Embroidered Name",
  CUSTOM_TACKLE_TWILL_LETTERS: "Tackle Twill Letters",
  RUBBER_KEYCHAINS: "Rubber Keychains",
};

const STYLE_OPTIONS = [
  {
    title: "Embroidered",
    options: [
      { label: "Embroidered", value: "STANDARD_EMBROIDERY" },
      { label: "3D Embroidery", value: "3D_EMBROIDERY" },
      { label: "Chenille", value: "CHENILLE_PATCHES" },
    ],
  },
  {
    title: "Printed",
    options: [
      { label: "Full Color Printed", value: "FULL_COLOR_PRINTED_PATCHES" },
      { label: "Woven", value: "WOVEN_PATCHES" },
    ],
  },
  {
    title: "PVC / Rubber / Silicone",
    options: [
      { label: "PVC Rubber", value: "STANDARD_PVC_RUBBER_PATCHES" },
      { label: "Silicone", value: "SILICONE_PATCHES" },
      { label: "Glow PVC", value: "GLOW_PVC_PATCHES" },
    ],
  },
  {
    title: "Flex",
    options: [
      { label: "Metallic Flex", value: "METALLIC_FLEX_PATCHES" },
      { label: "Chrome Flex", value: "CHROME_FLEX_PATCHES" },
      { label: "Matte White Flex", value: "MATTE_WHITE_FLEX_PATCHES" },
      { label: "Matte Black Flex", value: "MATTE_BLACK_FLEX_PATCHES" },
      { label: "Full Color Flex", value: "FULL_COLOR_FLEX_PATCHES" },
    ],
  },
  {
    title: "Leather",
    options: [
      { label: "Genuine Leather", value: "GENUINE_LEATHER_PATCHES" },
      { label: "Faux Leather", value: "FAUX_LEATHER_PATCHES" },
    ],
  },
  {
    title: "Specialty",
    options: [
      {
        label: "Custom Embroidered Name Patches",
        value: "CUSTOM_EMBROIDERED_NAME_PATCHES",
      },
      {
        label: "Custom Tackle Twill Letters",
        value: "CUSTOM_TACKLE_TWILL_LETTERS",
      },
    ],
  },
  {
    title: "Stickers & Keychains",
    options: [
      { label: "Stickers", value: "STICKERS" },
      { label: "Bumper Stickers", value: "BUMPER_STICKERS" },
      { label: "Truck Stickers", value: "TRUCK_STICKERS" },
      { label: "Rubber Keychains", value: "RUBBER_KEYCHAINS" },
    ],
  },
];

// ─── Types ────────────────────────────────────────────────────────────────
interface RankedStyle {
  style_id: string;
  // v31 / Lambda 1B v7 returns these:
  style_name?: string;
  assessment?: string;
  determination?: "APPROVED" | "REVIEW" | "MISMATCH";
  // Pre-v31 back-compat:
  style_display_name?: string;
  reasoning?: string;
  confidence: number; // v31: 0-100; pre-v31: 0-1
}
interface RankResponse {
  session_id: string;
  // Lambda 1B v7 returns the array under `styles`. Older builds used
  // `ranked_styles`; we normalize via rankedStyles() below.
  styles?: RankedStyle[];
  ranked_styles?: RankedStyle[];
  artwork_s3_key?: string;
  artwork_hash?: string;
}

function rankedStyles(r: RankResponse | null): RankedStyle[] {
  if (!r) return [];
  if (Array.isArray(r.styles)) return r.styles;
  if (Array.isArray(r.ranked_styles)) return r.ranked_styles;
  return [];
}
type MockupState = "in_progress" | "complete" | "error" | "timeout" | "pending";
interface RankStatusEntry {
  status: MockupState;
  mockup_url?: string;
}
// v31 returns `styles` as an object keyed by style_id; pre-v31 returned an array.
interface RankStatus {
  styles?:
    | Record<string, RankStatusEntry>
    | Array<{ style_id: string; status: string; mockup_url?: string }>;
}

const ML_DET_META: Record<
  string,
  { label: string; tone: "success" | "warning" | "critical" }
> = {
  APPROVED: { label: "Best fit", tone: "success" },
  REVIEW: { label: "Should work", tone: "warning" },
  MISMATCH: { label: "Not recommended", tone: "critical" },
};

function mlConfPct(c: number): number {
  return c <= 1 ? Math.round(c * 100) : Math.round(c);
}

// ─── Component ────────────────────────────────────────────────────────────
export default function MockupLab() {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Specs
  const [styleId, setStyleId] = useState<string>("");
  const [width, setWidth] = useState<string>("");
  const [height, setHeight] = useState<string>("");
  const [shape, setShape] = useState<string>("");
  const [size, setSize] = useState<string>("");
  const [corner, setCorner] = useState<string>("");
  const [borderStyle, setBorderStyle] = useState<string>("");
  const [bgColor, setBgColor] = useState<string>("");
  const [borderThreadColor, setBorderThreadColor] = useState<string>("");
  const [leatherColor, setLeatherColor] = useState<string>("");
  const [bgTexture, setBgTexture] = useState<string>("");
  const [bgOption, setBgOption] = useState<string>("");
  const [finish, setFinish] = useState<string>("");
  const [borderThickness, setBorderThickness] = useState<string>("");

  // Submission + results
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<RankResponse | null>(null);
  const [statusMap, setStatusMap] = useState<
    Record<string, { status: string; mockup_url?: string }>
  >({});
  const [revealedTo, setRevealedTo] = useState(3);
  const [feedback, setFeedback] = useState<
    Record<string, "up" | "down" | undefined>
  >({});
  const [lightbox, setLightbox] = useState<{
    src: string;
    title: string;
  } | null>(null);

  // Stores the most recent /api/rank-artwork specs payload so /api/rank-regenerate
  // can replay them when the user re-fires a single style.
  const lastSpecsRef = useRef<Record<string, string> | null>(null);

  const group = STYLE_GROUPS[styleId] || "";
  const rules = group ? GROUP_RULES[group] : null;

  const onFile = (f: File) => {
    if (!f.type.startsWith("image/")) {
      setErrorMsg("Please upload an image file.");
      return;
    }
    if (f.size > 7 * 1024 * 1024) {
      setErrorMsg("File too large (max 7 MB).");
      return;
    }
    setErrorMsg(null);
    setFile(f);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(f));
  };

  const clearFile = () => {
    setFile(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
  };

  // Validate which "required" fields are missing for the selected style group
  const validation = useMemo(() => {
    if (!styleId) return { ok: false, msg: "Pick a patch style." };
    if (!file) return { ok: false, msg: "Upload artwork." };
    if (rules?.shape && !shape) return { ok: false, msg: "Pick a shape." };
    if (rules?.sizeSelector && !size) return { ok: false, msg: "Pick a size." };
    if (!rules?.sizeSelector && (!width || !height))
      return { ok: false, msg: "Set dimensions." };
    if (rules?.borderStyle === "choice" && !borderStyle)
      return { ok: false, msg: "Pick a border style." };
    if (rules?.bgColor && !bgColor)
      return { ok: false, msg: "Set background color." };
    if (rules?.borderThreadColor && !borderThreadColor)
      return { ok: false, msg: "Set border thread color." };
    if (rules?.leatherColor && !leatherColor)
      return { ok: false, msg: "Pick a leather color." };
    if (rules?.bgTexture && !bgTexture)
      return { ok: false, msg: "Pick a background texture." };
    return { ok: true, msg: "" };
  }, [
    styleId,
    file,
    rules,
    shape,
    size,
    width,
    height,
    borderStyle,
    bgColor,
    borderThreadColor,
    leatherColor,
    bgTexture,
  ]);

  const submit = async () => {
    if (!validation.ok || !file) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const b64 = await fileToBase64(file);
      const sessionId = `ml-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const specs: Record<string, string> = {
        preferred_style: styleId,
        ...(width ? { width_in: width } : {}),
        ...(height ? { height_in: height } : {}),
        ...(shape ? { shape } : {}),
        ...(rules?.fixedShape ? { shape: rules.fixedShape } : {}),
        ...(size ? { size } : {}),
        ...(corner ? { corner_style: corner } : {}),
        ...(borderStyle ? { border_style: borderStyle } : {}),
        ...(bgColor ? { background_color: bgColor } : {}),
        ...(borderThreadColor ? { border_color: borderThreadColor } : {}),
        ...(leatherColor ? { leather_color: leatherColor } : {}),
        ...(bgTexture ? { background_texture: bgTexture } : {}),
        ...(bgOption ? { background_option: bgOption } : {}),
        ...(finish ? { finish } : {}),
        ...(borderThickness ? { border_thickness: borderThickness } : {}),
      };
      lastSpecsRef.current = specs;
      const r = await api<RankResponse>("/api/rank-artwork", {
        method: "POST",
        body: JSON.stringify({
          artwork: b64,
          session_id: sessionId,
          mime_type: file.type,
          filename: file.name,
          specs,
        }),
      });
      setResult(r);
      setRevealedTo(3);
      setStatusMap({});
      setFeedback({});
    } catch (e) {
      setErrorMsg((e as Error).message || "Ranking failed");
    } finally {
      setSubmitting(false);
    }
  };

  // Poll status while we have a session. Adaptive backoff matching the v31
  // dashboard: start at 1.5s, +0.5s per tick, capped at 5s. Hard timeout at
  // 400s (~6.6 min) — anything still pending flips to 'timeout'.
  useEffect(() => {
    if (!result?.session_id) return;
    let stopped = false;
    let timer: number | null = null;
    const startedAt = Date.now();
    const POLL_MIN = 1500;
    const POLL_MAX = 5000;
    const POLL_STEP = 500;
    const POLL_TIMEOUT_MS = 400_000;
    let interval = POLL_MIN;

    const flipTimeouts = () => {
      setStatusMap((prev) => {
        const next: typeof prev = { ...prev };
        let changed = false;
        for (const s of rankedStyles(result).slice(0, revealedTo)) {
          const cur = next[s.style_id];
          if (!cur || (cur.status !== "complete" && cur.status !== "error")) {
            next[s.style_id] = { status: "timeout" };
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    };

    const tick = async () => {
      if (stopped) return;
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        flipTimeouts();
        return;
      }
      try {
        const s = await api<RankStatus>(
          `/api/rank-status?session_id=${encodeURIComponent(result.session_id)}`,
        );
        if (stopped) return;
        const next: typeof statusMap = {};
        const stylesField = s.styles;
        if (Array.isArray(stylesField)) {
          for (const st of stylesField) {
            next[st.style_id] = {
              status: st.status,
              mockup_url: st.mockup_url,
            };
          }
        } else if (stylesField) {
          for (const [sid, entry] of Object.entries(stylesField)) {
            next[sid] = {
              status: entry.status,
              mockup_url: entry.mockup_url,
            };
          }
        }
        setStatusMap(next);
        // If everything visible is terminal, stop polling.
        const allDone = rankedStyles(result)
          .slice(0, revealedTo)
          .every((s) => {
            const st = next[s.style_id]?.status;
            return st === "complete" || st === "error" || st === "timeout";
          });
        if (allDone) return;
      } catch {
        /* transient — keep polling */
      }
      interval = Math.min(POLL_MAX, interval + POLL_STEP);
      timer = window.setTimeout(tick, interval);
    };

    timer = window.setTimeout(tick, 0); // first tick immediately
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.session_id, revealedTo]);

  const revealMore = async () => {
    if (!result) return;
    const next = Math.min(revealedTo + 3, rankedStyles(result).length);
    setRevealedTo(next);
    // Fire SQS for the newly-revealed styles via /api/rank-generate
    const newly = rankedStyles(result).slice(revealedTo, next);
    try {
      await api("/api/rank-generate", {
        method: "POST",
        body: JSON.stringify({
          session_id: result.session_id,
          artwork_s3_key: result.artwork_s3_key,
          style_ids: newly.map((s) => s.style_id),
          specs: lastSpecsRef.current,
        }),
      });
    } catch {
      // ignore — polling will pick up status
    }
  };

  // Re-fire SQS for a single style (v31 /api/rank-regenerate). Flips the card
  // back to in_progress and lets polling pick up the new status.
  const regenerateStyle = async (sid: string) => {
    if (!result?.session_id) return;
    setStatusMap((m) => ({ ...m, [sid]: { status: "in_progress" } }));
    try {
      await api("/api/rank-regenerate", {
        method: "POST",
        body: JSON.stringify({
          session_id: result.session_id,
          style_id: sid,
          artwork_s3_key: result.artwork_s3_key,
          specs: lastSpecsRef.current,
        }),
      });
    } catch {
      setStatusMap((m) => ({ ...m, [sid]: { status: "error" } }));
    }
  };

  // Fire-and-forget thumbs-up/down feedback (v31 /api/rank-feedback).
  const submitFeedback = async (sid: string, verdict: "up" | "down") => {
    if (!result?.session_id) return;
    setFeedback((f) => ({ ...f, [sid]: verdict }));
    try {
      await api("/api/rank-feedback", {
        method: "POST",
        body: JSON.stringify({
          session_id: result.session_id,
          style_id: sid,
          verdict,
        }),
      });
    } catch {
      /* ignore */
    }
  };

  // Trigger save-as for every completed mockup currently visible.
  const downloadAll = () => {
    if (!result) return;
    for (const s of rankedStyles(result).slice(0, revealedTo)) {
      const status = statusMap[s.style_id];
      if (!status?.mockup_url) continue;
      const a = document.createElement("a");
      a.href = status.mockup_url;
      a.download = `${s.style_name || s.style_id}.png`;
      a.target = "_blank";
      a.rel = "noreferrer";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  };

  // "Upload New Artwork" — clear session, return to upload state.
  const resetSession = () => {
    setResult(null);
    setStatusMap({});
    setFeedback({});
    setRevealedTo(3);
    lastSpecsRef.current = null;
    clearFile();
    setStyleId("");
    setWidth("");
    setHeight("");
    setShape("");
    setSize("");
    setCorner("");
    setBorderStyle("");
    setBgColor("");
    setBorderThreadColor("");
    setLeatherColor("");
    setBgTexture("");
    setBgOption("");
    setFinish("");
    setBorderThickness("");
  };

  // Once results are showing, collapse the upload + specs card so the
  // mockup grid is the focus. The "Upload New Artwork" button in the
  // results header brings the user back to the form via resetSession().
  const showUploadCard = !result;

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="100">
          <Text as="h2" variant="headingLg">
            Mockup Lab
          </Text>
          <Text as="p" variant="bodyMd" tone="subdued">
            Drop in a customer&rsquo;s artwork and the AI ranks all 21 patch
            styles by fit, then generates a mockup for the top picks. Use it
            to suggest the best style for non-standard requests before a
            proof goes out.
          </Text>
        </BlockStack>
      </Card>

      {errorMsg ? (
        <Banner tone="critical" onDismiss={() => setErrorMsg(null)}>
          {errorMsg}
        </Banner>
      ) : null}

      {showUploadCard ? (
      <Card>
        <BlockStack gap="400">
          {!file ? (
            <div style={{ maxWidth: 640, margin: "0 auto", width: "100%" }}>
              <DropZone
                accept="image/*"
                type="image"
                allowMultiple={false}
                onDrop={(_files, accepted) => {
                  if (accepted.length > 0) onFile(accepted[0]);
                }}
              >
                <DropZone.FileUpload
                  actionTitle="Drop artwork or click to browse"
                  actionHint="Supports PNG, JPG, GIF, WebP — max 7 MB"
                />
              </DropZone>
            </div>
          ) : null}

          {file && previewUrl ? (
            <Box
              background="bg-surface-secondary"
              padding="300"
              borderRadius="200"
            >
              <InlineStack gap="300" blockAlign="center">
                <img
                  src={previewUrl}
                  alt="Preview"
                  style={{
                    width: 64,
                    height: 64,
                    objectFit: "contain",
                    borderRadius: 6,
                    background: "#fff",
                    border:
                      "1px solid var(--p-color-border-subdued, #e1e3e5)",
                  }}
                />
                <BlockStack gap="050">
                  <Text as="span" variant="bodyMd" fontWeight="medium">
                    {file.name}
                  </Text>
                  <Text as="span" variant="bodySm" tone="subdued">
                    {(file.size / 1024).toFixed(0)} KB
                  </Text>
                </BlockStack>
                <span style={{ flex: 1 }} />
                <Button onClick={clearFile}>Remove</Button>
              </InlineStack>
            </Box>
          ) : null}

          {file ? (
            <BlockStack gap="400">
              <Text as="h3" variant="headingMd">
                Patch Specifications
              </Text>

              <Select
                label="Patch Style"
                requiredIndicator
                value={styleId}
                onChange={setStyleId}
                placeholder="Select a patch style…"
                options={STYLE_OPTIONS}
              />

              {rules?.sizeSelector ? (
                <SwatchGroup
                  label="Size"
                  required
                  value={size}
                  options={
                    rules.sizeSelector === "bumper"
                      ? BUMPER_SIZES
                      : TRUCK_SIZES
                  }
                  onChange={setSize}
                />
              ) : (
                <InlineStack gap="200" blockAlign="end">
                  <div style={{ flex: "0 0 140px" }}>
                    <TextField
                      label="Width (in)"
                      type="number"
                      min={1}
                      max={30}
                      step={0.1}
                      placeholder="W"
                      value={width}
                      onChange={setWidth}
                      autoComplete="off"
                      requiredIndicator
                    />
                  </div>
                  <Box paddingBlockEnd="200">
                    <Text as="span" variant="bodyLg" tone="subdued">
                      ×
                    </Text>
                  </Box>
                  <div style={{ flex: "0 0 140px" }}>
                    <TextField
                      label="Height (in)"
                      type="number"
                      min={1}
                      max={30}
                      step={0.1}
                      placeholder="H"
                      value={height}
                      onChange={setHeight}
                      autoComplete="off"
                      requiredIndicator
                    />
                  </div>
                </InlineStack>
              )}

              {rules?.shape ? (
                <SwatchGroup
                  label="Shape"
                  required
                  value={shape}
                  options={
                    rules.shape === "flex" ? SHAPES_FLEX : SHAPES_STANDARD
                  }
                  onChange={setShape}
                />
              ) : null}

              {rules?.cornerStyle ? (
                <Select
                  label="Corner Style"
                  value={corner}
                  onChange={setCorner}
                  options={[
                    { label: "(not specified)", value: "" },
                    { label: "Square corners", value: "Square corners" },
                    { label: "Rounded corners", value: "Rounded corners" },
                  ]}
                />
              ) : null}

              {rules?.borderStyle === "choice" ? (
                <Select
                  label="Border Style"
                  requiredIndicator
                  value={borderStyle}
                  onChange={setBorderStyle}
                  placeholder="Select border style…"
                  options={[
                    { label: "Standard border", value: "Standard border" },
                    { label: "Merrow border", value: "Merrow border" },
                    { label: "No border", value: "No border" },
                    { label: "Heat-cut border", value: "Heat-cut border" },
                  ]}
                />
              ) : null}

              {rules?.bgColor ? (
                <TextField
                  label="Background Color"
                  requiredIndicator
                  placeholder="e.g. White, Navy Blue, Gold"
                  value={bgColor}
                  onChange={setBgColor}
                  autoComplete="off"
                />
              ) : null}

              {rules?.borderThreadColor ? (
                <TextField
                  label="Border Thread Color"
                  requiredIndicator
                  placeholder="e.g. Black, Red, Match Background"
                  value={borderThreadColor}
                  onChange={setBorderThreadColor}
                  autoComplete="off"
                />
              ) : null}

              {rules?.leatherColor ? (
                <SwatchGroup
                  label="Leather Color"
                  required
                  value={leatherColor}
                  options={
                    rules.leatherColor === "genuine"
                      ? LEATHER_GENUINE
                      : LEATHER_FAUX
                  }
                  onChange={setLeatherColor}
                />
              ) : null}

              {rules?.bgTexture ? (
                <SwatchGroup
                  label="Background Texture"
                  required
                  value={bgTexture}
                  options={TEXTURES}
                  onChange={setBgTexture}
                />
              ) : null}

              {rules?.bgOption ? (
                <SwatchGroup
                  label="Background"
                  value={bgOption}
                  options={BG_OPTIONS}
                  onChange={setBgOption}
                />
              ) : null}

              {rules?.finish ? (
                <SwatchGroup
                  label="Finish"
                  value={finish}
                  options={FINISHES}
                  onChange={setFinish}
                />
              ) : null}

              {rules?.borderThickness ? (
                <SwatchGroup
                  label="Border Thickness"
                  value={borderThickness}
                  options={BORDER_THICKNESSES}
                  onChange={setBorderThickness}
                />
              ) : null}

              <InlineStack gap="300" blockAlign="center">
                <Button
                  variant="primary"
                  disabled={!validation.ok || submitting}
                  loading={submitting}
                  onClick={submit}
                >
                  Analyze and Rank
                </Button>
                {!validation.ok ? (
                  <Text as="span" variant="bodySm" tone="subdued">
                    {validation.msg}
                  </Text>
                ) : null}
              </InlineStack>
            </BlockStack>
          ) : null}
        </BlockStack>
      </Card>
      ) : null}

      {result ? (
        <BlockStack gap="400">
          <Card>
            <InlineStack gap="300" blockAlign="center" wrap>
              {previewUrl ? (
                <img
                  src={previewUrl}
                  alt="Artwork"
                  style={{
                    width: 56,
                    height: 56,
                    objectFit: "contain",
                    borderRadius: 6,
                    background: "#fff",
                    border:
                      "1px solid var(--p-color-border-subdued, #e1e3e5)",
                  }}
                />
              ) : null}
              <BlockStack gap="050">
                <Text as="span" variant="bodyMd" fontWeight="bold">
                  {file?.name || "Artwork"}
                </Text>
                <Text as="span" variant="bodySm" tone="subdued">
                  {(() => {
                    const visible = rankedStyles(result).slice(0, revealedTo);
                    const done = visible.filter(
                      (s) => statusMap[s.style_id]?.status === "complete",
                    ).length;
                    if (done === 0)
                      return "Top 3 styles picked — generating mockups…";
                    if (done < visible.length)
                      return `${done} of ${visible.length} mockups ready…`;
                    return `${done} mockup${done === 1 ? "" : "s"} ready`;
                  })()}
                </Text>
              </BlockStack>
              <span style={{ flex: 1 }} />
              {(() => {
                const visible = rankedStyles(result).slice(0, revealedTo);
                const done = visible.filter(
                  (s) => statusMap[s.style_id]?.status === "complete",
                ).length;
                return (
                  <Button onClick={downloadAll} disabled={done === 0}>
                    {`Download All Mockups (${done}/${visible.length})`}
                  </Button>
                );
              })()}
              <Button onClick={resetSession}>Upload New Artwork</Button>
            </InlineStack>
          </Card>

          <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="300">
            {rankedStyles(result)
              .slice(0, 3)
              .map((s, idx) => (
                <MockupCard
                  key={s.style_id}
                  style={s}
                  position={idx + 1}
                  status={statusMap[s.style_id]}
                  feedback={feedback[s.style_id]}
                  onRegenerate={() => regenerateStyle(s.style_id)}
                  onFeedback={(v) => submitFeedback(s.style_id, v)}
                  onZoom={(src, title) => setLightbox({ src, title })}
                />
              ))}
          </InlineGrid>

          {rankedStyles(result).length > 3 ? (
            revealedTo > 3 ? (
              <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="300">
                {rankedStyles(result)
                  .slice(3, revealedTo)
                  .map((s, idx) => (
                    <MockupCard
                      key={s.style_id}
                      style={s}
                      position={idx + 4}
                      status={statusMap[s.style_id]}
                      feedback={feedback[s.style_id]}
                      onRegenerate={() => regenerateStyle(s.style_id)}
                      onFeedback={(v) => submitFeedback(s.style_id, v)}
                      onZoom={(src, title) => setLightbox({ src, title })}
                    />
                  ))}
              </InlineGrid>
            ) : (
              <InlineStack align="center">
                <Button onClick={revealMore} disabled={submitting}>
                  {`Show ${Math.min(3, rankedStyles(result).length - 3)} More Styles`}
                </Button>
              </InlineStack>
            )
          ) : null}
        </BlockStack>
      ) : null}

      {lightbox ? (
        <MlLightbox
          src={lightbox.src}
          title={lightbox.title}
          onClose={() => setLightbox(null)}
        />
      ) : null}
    </BlockStack>
  );
}

// Inline confidence bar — Polaris ProgressBar tones don't include orange,
// so we render the same 3-band gradient (red < 60 < orange < 80 < green) as
// a custom span pair to preserve the visual.
function MlConfidenceBar({ conf }: { conf: number }) {
  const fill =
    conf >= 80
      ? "var(--p-color-bg-fill-success, #1a7f37)"
      : conf >= 60
        ? "#b45309"
        : "var(--p-color-bg-fill-critical, #c5221f)";
  return (
    <InlineStack gap="200" blockAlign="center">
      <span
        style={{
          flex: 1,
          height: 6,
          borderRadius: 3,
          background: "#eee",
          overflow: "hidden",
          display: "block",
          minWidth: 60,
        }}
        aria-label={`Confidence ${conf}%`}
      >
        <span
          style={{
            display: "block",
            width: `${conf}%`,
            height: "100%",
            background: fill,
            borderRadius: 3,
          }}
        />
      </span>
      <Text as="span" variant="bodySm" fontWeight="bold">
        {`${conf}%`}
      </Text>
    </InlineStack>
  );
}

// Reusable swatch picker — group of selectable Buttons with `pressed` state.
function SwatchGroup({
  label,
  required,
  value,
  options,
  onChange,
}: {
  label: string;
  required?: boolean;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <BlockStack gap="200">
      <Text as="span" variant="bodyMd" fontWeight="medium">
        {label}
        {required ? (
          <Text as="span" tone="critical">
            {" *"}
          </Text>
        ) : null}
      </Text>
      <InlineStack gap="200" wrap>
        {options.map((o) => (
          <Button
            key={o}
            pressed={value === o}
            onClick={() => onChange(o)}
          >
            {o}
          </Button>
        ))}
      </InlineStack>
    </BlockStack>
  );
}

// Polaris Modal handles Escape, focus trap, and overlay click.
function MlLightbox({
  src,
  title,
  onClose,
}: {
  src: string;
  title: string;
  onClose: () => void;
}) {
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      primaryAction={{ content: "Close", onAction: onClose }}
      secondaryActions={[
        { content: "Download", url: src, external: true },
        { content: "Open in new tab", url: src, external: true },
      ]}
    >
      <Modal.Section>
        <div style={{ textAlign: "center" }}>
          <img
            src={src}
            alt={title}
            style={{
              maxWidth: "100%",
              maxHeight: "75vh",
              display: "inline-block",
              borderRadius: 4,
            }}
          />
        </div>
      </Modal.Section>
    </Modal>
  );
}

// ─── Mockup card ──────────────────────────────────────────────────────────
function MockupCard({
  style,
  position,
  status,
  feedback,
  onRegenerate,
  onFeedback,
  onZoom,
}: {
  style: RankedStyle;
  position: number;
  status?: { status: string; mockup_url?: string };
  feedback?: "up" | "down";
  onRegenerate: () => void;
  onFeedback: (v: "up" | "down") => void;
  onZoom: (src: string, title: string) => void;
}) {
  const conf = mlConfPct(style.confidence || 0);
  const detKey = (style.determination || "REVIEW").toUpperCase();
  const det = ML_DET_META[detKey] || ML_DET_META.REVIEW;
  const name =
    style.style_name ||
    style.style_display_name ||
    STYLE_LABELS[style.style_id] ||
    style.style_id;
  const assess = style.assessment || style.reasoning || "";
  const mockupUrl = status?.mockup_url;
  const mockupStatus = status?.status;
  const isComplete = mockupStatus === "complete" && !!mockupUrl;
  const isError =
    mockupStatus === "error" ||
    mockupStatus === "timeout" ||
    mockupStatus === "failed";
  const canDownload = isComplete;
  const canFeedback = isComplete && !feedback;
  const canRegen = isComplete || isError;

  return (
    <Card padding="400">
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="span" variant="headingSm">
            {name}
          </Text>
          <Text as="span" variant="bodySm" tone="subdued" fontWeight="bold">
            {`#${position}`}
          </Text>
        </InlineStack>
        <InlineStack gap="200" blockAlign="center" wrap>
          <div style={{ flex: 1, minWidth: 80 }}>
            <MlConfidenceBar conf={conf} />
          </div>
          <Badge tone={det.tone}>{det.label}</Badge>
        </InlineStack>
        {assess ? (
          <Text as="p" variant="bodySm" tone="subdued">
            {assess}
          </Text>
        ) : null}
        <Box
          background="bg-surface-secondary"
          padding="300"
          borderRadius="200"
          minHeight="200px"
        >
          {isComplete ? (
            <button
              type="button"
              onClick={() => onZoom(mockupUrl as string, name)}
              style={{
                border: "none",
                background: "transparent",
                padding: 0,
                cursor: "zoom-in",
                width: "100%",
                display: "block",
              }}
              aria-label={`Zoom mockup for ${name}`}
              title="Click to zoom"
            >
              <img
                src={mockupUrl}
                alt={name}
                style={{
                  width: "100%",
                  maxHeight: 240,
                  objectFit: "contain",
                  display: "block",
                }}
              />
            </button>
          ) : isError ? (
            <Box padding="400">
              <BlockStack gap="100" inlineAlign="center">
                <Text as="span" variant="bodyMd" tone="critical">
                  {mockupStatus === "timeout"
                    ? "Timed out"
                    : "Generation failed"}
                </Text>
              </BlockStack>
            </Box>
          ) : (
            <Box padding="400">
              <BlockStack gap="200" inlineAlign="center">
                <Spinner accessibilityLabel="Rendering mockup" size="small" />
                <Text as="span" variant="bodySm" tone="subdued">
                  Rendering now…
                </Text>
              </BlockStack>
            </Box>
          )}
        </Box>
        <InlineStack gap="100" align="space-between" blockAlign="center">
          <Button
            url={canDownload ? mockupUrl : undefined}
            disabled={!canDownload}
            external
            download={canDownload ? `${name}.png` : undefined}
          >
            Download
          </Button>
          <ButtonGroup>
            <Button
              pressed={feedback === "up"}
              disabled={!canFeedback && feedback !== "up"}
              onClick={() => onFeedback("up")}
              accessibilityLabel="Looks right"
            >
              Looks right
            </Button>
            <Button
              pressed={feedback === "down"}
              disabled={!canFeedback && feedback !== "down"}
              onClick={() => onFeedback("down")}
              accessibilityLabel="Looks wrong"
            >
              Looks wrong
            </Button>
            <Button
              disabled={!canRegen}
              onClick={onRegenerate}
              accessibilityLabel="Regenerate this mockup"
            >
              Regenerate
            </Button>
          </ButtonGroup>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

function fileToBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () =>
      resolve(
        typeof r.result === "string"
          ? r.result.split(",")[1] || r.result
          : "",
      );
    r.onerror = reject;
    r.readAsDataURL(f);
  });
}
