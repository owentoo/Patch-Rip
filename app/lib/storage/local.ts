import { promises as fs } from "node:fs";
import path from "node:path";

const STORAGE_ROOT = path.resolve(process.cwd(), "uploads");

export async function writeFile(
  storageKey: string,
  data: Buffer,
): Promise<void> {
  const fullPath = path.join(STORAGE_ROOT, storageKey);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, data);
}

export async function readFile(storageKey: string): Promise<Buffer> {
  const fullPath = path.join(STORAGE_ROOT, storageKey);
  return fs.readFile(fullPath);
}
