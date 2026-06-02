// Liar's Ledger - src/verify.js
// Client-side claim verification — calls the backend /api/verify-claim endpoint.
// Loaded via importScripts in background.js.

/**
 * Verify a single claim against a member's congressional record.
 *
 * @param {string} claim - The extracted claim about the politician
 * @param {string} memberName - Full name (e.g. "Lauren Boebert")
 * @param {object} record - The record object from lookupAll()
 * @param {object} [options]
 * @param {string} [options.proxyUrl] - Backend URL (defaults to CONFIG.PROXY_URL)
 * @param {number} [options.timeoutMs] - Request timeout (default 15000)
 * @returns {Promise<{verdict: string, explanation: string}>}
 */
async function verifyClaimViaProxy(claim, memberName, record, options = {}) {
  if (!claim || !claim.trim()) {
    return { verdict: "insufficient", explanation: "No claim to verify." };
  }

  const proxyUrl = options.proxyUrl
    || (typeof CONFIG !== "undefined" && CONFIG.PROXY_URL)
    || "https://api.liarsledger.com";
  const timeoutMs = options.timeoutMs ?? 15000;

  // Build a compact record payload — only the fields the prompt needs
  const payload = {
    claim,
    member: memberName,
    record: {
      sponsored: (record.sponsored || []).map((b) => ({
        title: b.title || b.number,
        number: b.number,
        url: b.url,
      })),
      cosponsored: (record.cosponsored || []).map((b) => ({
        title: b.title || b.number,
        number: b.number,
        url: b.url,
      })),
      rollCallVotes: (record.rollCallVotes || []).map((v) => ({
        question: v.question || v.description,
        position: v.position,
        bill_title: v.bill_title,
      })),
      ratings: (record.vsRatings || record.ratings || []).map((r) => ({
        sigName: r.sigName || r.group,
        rating: r.rating,
      })),
      vsVotes: (record.vsVotes || []).map((v) => ({
        title: v.title || v.billNumber,
        vote: v.vote || v.action,
      })),
    },
  };

  try {
    const res = await fetch(`${proxyUrl}/api/verify-claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn("verify", `HTTP ${res.status}: ${body.slice(0, 120)}`);
      return { verdict: "insufficient", explanation: "Verification request failed." };
    }

    const data = await res.json();

    if (!data?.ok) {
      logger.warn("verify", data?.error || "unknown error");
      return { verdict: "insufficient", explanation: "Verification returned an error." };
    }

    return { verdict: data.verdict, explanation: data.explanation };
  } catch (e) {
    logger.warn("verify", `verify failed: ${e.message}`);
    return { verdict: "insufficient", explanation: "Verification timed out or failed." };
  }
}

/**
 * Verify all claims in a records array. Runs in parallel.
 *
 * @param {Array} records - Records from lookupAll(), each with .claim and .full_name
 * @param {object} [options]
 * @returns {Promise<Array>} - Same records with .verdict and .verdict_explanation attached
 */
async function verifyAllClaims(records, options = {}) {
  const jobs = records.map(async (record) => {
    if (!record.claim) {
      record.verdict = "insufficient";
      record.verdict_explanation = "No claim extracted for this member.";
      return record;
    }

    const result = await verifyClaimViaProxy(
      record.claim,
      record.full_name,
      record,
      options,
    );

    record.verdict = result.verdict;
    record.verdict_explanation = result.explanation;
    return record;
  });

  return Promise.all(jobs);
}
