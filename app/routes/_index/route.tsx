import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>PatchSensei</h1>
        <p className={styles.text}>
          AI-assisted artwork review and mockup generation for Ninja Patches.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input
                className={styles.input}
                type="text"
                name="shop"
                placeholder="ninjapoddd.myshopify.com"
              />
              <span>e.g. ninjapoddd.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Artwork review queue</strong>. Internal reps approve or
            CAN orders flagged by Lambda 1 with a single click — tag swap,
            metafield write, mockup queue dispatch all happen in one action.
          </li>
          <li>
            <strong>Mockup Lab</strong>. Upload a piece of artwork and Claude
            ranks it across all 21 patch styles, then generates realistic
            mockups for the top 3 — no Shopify order required.
          </li>
          <li>
            <strong>Embedded in Shopify Admin</strong>. Built on the official
            Shopify Remix template with Polaris and App Bridge — session-token
            auth, no overlay tricks.
          </li>
        </ul>
      </div>
    </div>
  );
}
