// Liar's Ledger - server/providers/verify.js
// Claim-vs-record verification via Claude Haiku.
//
// Takes a politician's extracted claim and their actual congressional record,
// asks the LLM whether the record supports the claim.
//
// Returns:
//   { ok: true,  verdict, explanation }
//   { ok: false, error }

const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODEL   = "claude-haiku-4-5-20251001";
const MAX_RECORD_CHARS = 8000;

function buildVerifyPrompt(claim, member, record) {
  const bills = [];

  if (record.sponsored?.length) {
    bills.push("SPONSORED BILLS:\n" + record.sponsored.map((b) =>
      `- ${b.title || b.number || "untitled"}${b.url ? ` (${b.url})` : ""}`
    ).join("\n"));
  }

  if (record.cosponsored?.length) {
    bills.push("COSPONSORED BILLS:\n" + record.cosponsored.map((b) =>
      `- ${b.title || b.number || "untitled"}${b.url ? ` (${b.url})` : ""}`
    ).join("\n"));
  }

  if (record.rollCallVotes?.length) {
    bills.push("ROLL-CALL VOTES:\n" + record.rollCallVotes.map((v) =>
      `- ${v.question || v.description || "vote"}: ${v.position || "unknown"}${v.bill_title ? ` (${v.bill_title})` : ""}`
    ).join("\n"));
  }

  if (record.ratings?.length) {
    bills.push("INTEREST GROUP RATINGS:\n" + record.ratings.map((r) =>
      `- ${r.sigName || r.group}: ${r.rating}`
    ).join("\n"));
  }

  if (record.vsVotes?.length) {
    bills.push("VOTESMART KEY VOTES:\n" + record.vsVotes.map((v) =>
      `- ${v.title || v.billNumber || "vote"}: ${v.vote || v.action || "unknown"}`
    ).join("\n"));
  }

  const recordText = bills.join("\n\n").slice(0, MAX_RECORD_CHARS);

  return (
    "You are a nonpartisan congressional fact-checker for a browser extension called Liar's Ledger.\n\n" +
    "A news article made the following claim about a member of Congress. " +
    "Below the claim is that member's actual legislative record - bills they sponsored or cosponsored, " +
    "roll-call votes, and interest group ratings.\n\n" +
    "Your job: determine whether the RECORD supports, contradicts, or is mixed on the CLAIM.\n\n" +
    "Output ONLY valid JSON (no markdown) with this exact shape:\n" +
    '{"verdict":"supported|contradicted|mixed|insufficient",' +
    '"explanation":"1-3 sentences citing specific bills, votes, or ratings that justify the verdict"}\n\n' +
    "Verdict definitions:\n" +
    '- "supported" - the record clearly backs the claim (relevant bills sponsored, votes cast, ratings align)\n' +
    '- "contradicted" - the record clearly opposes the claim (voted against, low ratings from aligned groups, no relevant action)\n' +
    '- "mixed" - some evidence supports and some contradicts\n' +
    '- "insufficient" - not enough relevant data in the record to judge\n\n' +
    "Rules:\n" +
    "- Base your verdict ONLY on the record provided. Do not use outside knowledge.\n" +
    "- Be specific - cite bill names, vote positions, or rating scores.\n" +
    "- If the claim is vague or not policy-related, return insufficient.\n" +
    "- Do not editorialize. State facts from the record.\n\n" +
    `MEMBER: ${member}\n\n` +
    `CLAIM: ${claim}\n\n` +
    `RECORD:\n${recordText}`
  );
}

function parseVerifyResponse(content) {
  let raw = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) raw = raw.slice(start, end + 1);

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Verification returned unparseable JSON" };
  }

  const verdict = ["supported", "contradicted", "mixed", "insufficient"].includes(parsed?.verdict)
    ? parsed.verdict
    : "insufficient";

  const explanation = typeof parsed?.explanation === "string"
    ? parsed.explanation.trim()
    : "No explanation provided.";

  return { ok: true, verdict, explanation };
}

async function verifyClaim(claim, member, record) {
  if (!claim || typeof claim !== "string" || !claim.trim()) {
    return { ok: true, verdict: "insufficient", explanation: "No claim to verify." };
  }

  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) return { ok: false, error: "Claude API key not configured" };

  let res;
  try {
    res = await fetch(CLAUDE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:       CLAUDE_MODEL,
        max_tokens:  512,
        temperature: 0.0,
        messages: [{ role: "user", content: buildVerifyPrompt(claim, member, record) }],
      }),
      // Found via security review: this fetch had no timeout at all, unlike
      // server/providers/claude.js's matching pattern (AbortSignal.timeout
      // (30000)) and src/verify.js's client-side equivalent — both already
      // had one. A Pro user triggering verification while Claude's API is
      // experiencing elevated latency would hold the request open
      // indefinitely (until the OS socket timeout, typically minutes); a
      // hanging fetch doesn't reject, so wrap()'s promise-rejection catch
      // never sees it. Low severity (requires Pro + unusual API conditions,
      // not exploitable for abuse beyond tying up one request) but a real
      // reliability gap — fixed to match the existing 30s pattern.
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    const isTimeout = e?.name === "TimeoutError" || e?.name === "AbortError";
    return { ok: false, error: isTimeout ? "Verification request timed out" : `Verification request failed: ${e.message}` };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, error: `Claude HTTP ${res.status}: ${body.slice(0, 120)}` };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: "Claude returned non-JSON response" };
  }

  const content = data?.content?.[0]?.text;
  if (typeof content !== "string" || !content.trim()) {
    return { ok: false, error: "Claude returned empty verification response" };
  }

  return parseVerifyResponse(content);
}

export { verifyClaim };