import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";

import { authenticate } from "../shopify.server";

// Server-side proxy to Lambda 3's /api/* routes. The Remix loaders/components
// fetch through this proxy so that:
//   - All Shopify auth happens here (session.accessToken passed downstream)
//   - The legacy backend's data shapes are reused without re-implementing
//     /api/queue, /api/approve, /api/can, /api/email, etc. in TypeScript
//   - As we incrementally rewrite endpoints in TS we can flip per-route
//     without touching the React.

const API_BASE =
  process.env.PATCHSENSEI_API_URL ||
  "https://4jk3bxx239.execute-api.us-east-1.amazonaws.com";

async function proxy(request: Request) {
  const { session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const targetUrl = `${API_BASE.replace(/\/$/, "")}${url.pathname}${url.search}`;

  const headers = new Headers();
  headers.set("X-Shopify-Shop-Domain", session.shop);
  headers.set(
    "Authorization",
    `Bearer ${request.headers.get("authorization")?.replace(/^Bearer\s+/, "") || ""}`,
  );
  // Forward the offline access token Lambda 3 needs to call Shopify
  headers.set("X-Shopify-Access-Token", session.accessToken ?? "");
  const ct = request.headers.get("content-type");
  if (ct) headers.set("Content-Type", ct);

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }

  const upstream = await fetch(targetUrl, init);
  const respHeaders = new Headers();
  upstream.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (lk === "content-encoding" || lk === "transfer-encoding") return;
    respHeaders.set(k, v);
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: respHeaders,
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => proxy(request);
export const action = async ({ request }: ActionFunctionArgs) => proxy(request);
