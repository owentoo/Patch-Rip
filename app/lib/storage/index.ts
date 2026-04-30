import path from "node:path";

import * as local from "./local";
import * as s3 from "./s3";

const backend = process.env.STORAGE_BACKEND === "s3" ? s3 : local;

export const writeFile = backend.writeFile;
export const readFile = backend.readFile;

export const ACCEPTED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/tiff",
  "image/gif",
  "image/bmp",
  "image/svg+xml",
  "application/pdf",
  "application/postscript", // .ai, .eps
  "application/illustrator",
  "application/photoshop",
  "image/vnd.adobe.photoshop",
  "application/zip",
  "application/x-zip-compressed",
  "application/octet-stream", // catch-all for AI/EPS/PSD when browser doesn't sniff right
]);

export const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;

export function buildStorageKey(args: {
  shopId: string;
  proofId: string;
  versionNumber: number;
  filename: string;
}): string {
  const safeFilename = args.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.posix.join(
    args.shopId,
    args.proofId,
    `v${args.versionNumber}`,
    safeFilename,
  );
}

export function isPreviewableInBrowser(mimeType: string): boolean {
  return (
    mimeType.startsWith("image/") &&
    mimeType !== "image/tiff" &&
    mimeType !== "image/vnd.adobe.photoshop"
  );
}
