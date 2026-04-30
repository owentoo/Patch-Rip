import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const client = new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" });

function getBucket(): string {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    throw new Error("S3_BUCKET env var is required when STORAGE_BACKEND=s3");
  }
  return bucket;
}

export async function writeFile(
  storageKey: string,
  data: Buffer,
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: getBucket(),
      Key: storageKey,
      Body: data,
    }),
  );
}

export async function readFile(storageKey: string): Promise<Buffer> {
  const result = await client.send(
    new GetObjectCommand({ Bucket: getBucket(), Key: storageKey }),
  );
  if (!result.Body) {
    throw new Error(`S3 object missing or empty: ${storageKey}`);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of result.Body as AsyncIterable<Buffer | Uint8Array>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
