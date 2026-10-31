// One-time setup: registers a new anonymous Liar's Ledger token for the bot
// to scan through, the same way a fresh extension install would. Run once,
// save the printed token as LL_BOT_TOKEN in server/.env, then upgrade it to
// Pro (see the printed curl command) - /api/verify-claim requires Pro tier,
// and the bot needs verdicts, not just the raw record.
//
// Run from server/:  node bot/registerBotToken.js
import "dotenv/config";
import { randomUUID } from "node:crypto";

async function main() {
  const apiBase = process.env.LL_API_BASE || "https://api.liarsledger.com";

  // The extension generates its own UUID client-side and registers it -
  // /register doesn't mint one server-side (see server/index.js:316-321,
  // requires a client-supplied tokenId of at least 16 chars). Mirroring
  // that here rather than expecting the server to hand one back.
  const tokenId = randomUUID();

  const res = await fetch(`${apiBase}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tokenId }),
  });
  if (!res.ok) {
    throw new Error(`/register HTTP ${res.status} - ${await res.text().catch(() => "")}`);
  }
  const data = await res.json();
  if (data.status !== "created") {
    throw new Error(`unexpected /register response (expected a fresh "created" status): ${JSON.stringify(data)}`);
  }

  console.log(`\nRegistered a new token: ${tokenId}`);
  console.log(`\n1. Add this to server/.env:\n\n   LL_BOT_TOKEN=${tokenId}`);
  console.log(
    `\n2. Upgrade it to Pro (required for /api/verify-claim) via the Upstash REST API - ` +
      `see CLAUDE.md's "Redis data model" section. Using the Upstash console UI mangles ` +
      `JSON quotes; use curl:\n`
  );
  console.log(
    `   curl -X POST https://YOUR_UPSTASH_URL/set/token:${tokenId} \\\n` +
      `     -H "Authorization: Bearer YOUR_UPSTASH_TOKEN" \\\n` +
      `     -d '{"tier":"pro","createdAt":"${new Date().toISOString()}","upgradedAt":"${new Date().toISOString()}"}'\n`
  );
  console.log("Replace YOUR_UPSTASH_URL / YOUR_UPSTASH_TOKEN with the values already in server/.env.");
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
