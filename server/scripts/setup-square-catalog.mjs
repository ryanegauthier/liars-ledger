#!/usr/bin/env node
// server/scripts/setup-square-catalog.mjs
//
// ONE-TIME SETUP — run this once to create the subscription plan and
// plan variation in Square. After running, copy the printed IDs into
// your Render environment variables:
//
//   SQUARE_PLAN_ID=<plan object id>
//   SQUARE_PLAN_VARIATION_ID=<variation object id>
//
// Usage:
//   node server/scripts/setup-square-catalog.mjs
//
// Requires these env vars (set in .env or shell):
//   SQUARE_ACCESS_TOKEN   — from Square Developer Console
//   SQUARE_ENVIRONMENT    — "sandbox" or "production"
//
// The script is idempotent-safe: if you run it twice you just get two
// separate plan objects. Keep track of the IDs from the first run.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

// Load .env from server directory if present
try {
  const dotenv = await import("dotenv");
  dotenv.config({ path: new URL("../.env", import.meta.url).pathname });
} catch {}

const ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const ENV          = process.env.SQUARE_ENVIRONMENT || "sandbox";

if (!ACCESS_TOKEN) {
  console.error("[setup] SQUARE_ACCESS_TOKEN is not set. Aborting.");
  process.exit(1);
}

const BASE_URL = ENV === "production"
  ? "https://connect.squareup.com"
  : "https://connect.squareupsandbox.com";

// Square API version pinned — bump only after reviewing changelog
const SQUARE_VERSION = "2026-05-20";

async function squarePost(path, body) {
  const res = await fetch(`${BASE_URL}/v2${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${ACCESS_TOKEN}`,
      "Content-Type":  "application/json",
      "Square-Version": SQUARE_VERSION,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    const errs = (data.errors || []).map(e => `${e.category}/${e.code}: ${e.detail}`).join("\n  ");
    throw new Error(`Square ${res.status} on ${path}:\n  ${errs}`);
  }
  return data;
}

async function main() {
  console.log(`[setup] environment: ${ENV}`);
  console.log(`[setup] creating Liar's Ledger Pro subscription plan…\n`);

  // ── Step 1: Create SUBSCRIPTION_PLAN ─────────────────────────────────────
  // A service-level subscription plan — no physical items, no categories.
  // `all_items: false` with no `eligible_*` IDs means it's a pure service plan.
  const planResult = await squarePost("/catalog/object", {
    idempotency_key: randomUUID(),
    object: {
      type: "SUBSCRIPTION_PLAN",
      id:   "#pro_plan",
      subscription_plan_data: {
        name:      "Liar's Ledger Pro",
        all_items: false,
      },
    },
  });

  const planId = planResult.catalog_object.id;
  console.log(`✓ SUBSCRIPTION_PLAN created`);
  console.log(`  id:      ${planId}`);
  console.log(`  name:    ${planResult.catalog_object.subscription_plan_data.name}\n`);

  // ── Step 2: Create SUBSCRIPTION_PLAN_VARIATION ───────────────────────────
  // Single phase, STATIC pricing, $5.00/month, no end date (perpetual).
  // STATIC pricing means no order template is needed — Square handles the
  // recurring billing entirely; we only need to create the customer and
  // call CreateSubscription.
  const variationResult = await squarePost("/catalog/object", {
    idempotency_key: randomUUID(),
    object: {
      type: "SUBSCRIPTION_PLAN_VARIATION",
      id:   "#pro_monthly",
      subscription_plan_variation_data: {
        name:                 "Monthly",
        subscription_plan_id: planId,
        phases: [
          {
            ordinal: 0,
            cadence: "MONTHLY",
            // No `periods` field → phase never ends (perpetual subscription)
            pricing: {
              type:  "STATIC",
              price: {
                amount:   500, // $5.00 in cents
                currency: "USD",
              },
            },
          },
        ],
      },
    },
  });

  const variationId = variationResult.catalog_object.id;
  console.log(`✓ SUBSCRIPTION_PLAN_VARIATION created`);
  console.log(`  id:      ${variationId}`);
  console.log(`  name:    ${variationResult.catalog_object.subscription_plan_variation_data.name}`);
  console.log(`  price:   $${variationResult.catalog_object.subscription_plan_variation_data.phases[0].pricing.price.amount / 100}/month\n`);

  // ── Output env vars to copy ───────────────────────────────────────────────
  console.log("─".repeat(60));
  console.log("Add these to your Render environment variables:\n");
  console.log(`SQUARE_PLAN_ID=${planId}`);
  console.log(`SQUARE_PLAN_VARIATION_ID=${variationId}`);
  console.log("─".repeat(60));
  console.log("\nDone. Keep these IDs — they're used by /checkout/create.");
}

main().catch(err => {
  console.error("[setup] fatal:", err.message);
  process.exit(1);
});
