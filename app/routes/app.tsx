import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import legacyStyles from "../styles/legacy.css?url";
import orderDetailStyles from "../styles/order-detail.css?url";

import { authenticate } from "../shopify.server";

export const links = () => [
  { rel: "stylesheet", href: polarisStyles },
  { rel: "stylesheet", href: legacyStyles },
  { rel: "stylesheet", href: orderDetailStyles },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();
  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      {/* Shopify admin sidebar sub-nav. Each link jumps straight to the
          matching tab inside the embedded app — same pattern the old
          ProofSensei app used. The dashboard reads ?tab=… on mount and
          on URL change so a click here lands on the right tab. */}
      <NavMenu>
        <Link to="/app" rel="home">
          Home
        </Link>
        <Link to="/app/queue">Needs Review</Link>
        <Link to="/app/approved">Approved</Link>
        <Link to="/app/proofs">Proofs</Link>
        <Link to="/app/analytics">Analytics</Link>
        <Link to="/app/mockuplab">Mockup Lab</Link>
        <Link to="/app/settings">Settings</Link>
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
