// Orchestrates one full pass: article URL -> claim-vs-record verdict draft.
// Deliberately mirrors background.js's real handleAnalyze() pipeline as
// closely as possible, reusing the same sandboxed src/*.js logic
// (loadExtensionScript.js) rather than re-deriving any of it - see that
// file's header comment for which pieces are reused and why.
import { getExtensionSandbox } from "./loadExtensionScript.js";
import { extractArticleText } from "./extractArticle.js";

const REPLY_CHAR_LIMIT = 280;

// Thrown for "nothing to report" cases (no members detected, no claim
// verifiable, daily scan limit hit) - expected outcomes for a lot of
// mentions, not bugs. pollMentions.js treats this differently from a
// thrown Error: skip silently rather than logging it as a failure.
export class AnalysisSkipped extends Error {}

export async function runAnalysis({ articleUrl, apiBase, botToken }) {
  const sandbox = getExtensionSandbox(botToken, apiBase);

  const { scanToken, commitToken } = await reserveScan(apiBase, botToken);

  const { title, text } = await extractArticleText(articleUrl);

  const analysis = await sandbox.extractArticleAnalysisDualVerified(text, {
    claudeEndpoint: `${apiBase}/api/claude/extract`,
    mistralEndpoint: `${apiBase}/api/mistral/extract`,
    scanToken,
  });
  if (!analysis.ok) {
    throw new Error(`extraction failed: ${analysis.error}`);
  }

  const { main_topics: mainTopicsGlobal, figures } = analysis;
  if (!figures.length) {
    throw new AnalysisSkipped("no members of Congress detected in this article");
  }

  const { resolved } = await sandbox.resolveAll(figures.map((f) => f.lookup_name));
  if (!resolved.length) {
    throw new AnalysisSkipped("could not resolve any named figure to a current member of Congress");
  }

  const fallbackTopics = sandbox.getSearchTerms(text);

  const memberJobs = resolved.map((member) => {
    const fig = figureForMember(figures, member);
    const topics = sandbox.mergeTopicsForMember(fig, mainTopicsGlobal, fallbackTopics);
    return {
      member: { ...member, _llm_search_terms: fig?.search_terms || [], _main_topics: fallbackTopics },
      topics,
      claim: fig?.claim || null,
    };
  });

  const records = await sandbox.lookupAll(
    memberJobs.map(({ member, topics }) => ({ member, topics })),
    { skipVoteSmart: false },
  );
  records.forEach((record, i) => {
    record.claim = memberJobs[i].claim;
  });

  // Matches background.js's scan-charging fairness rule: don't commit if
  // every member had a fully failed lookup.
  const anySourceOk = records.some((r) => !r._sources_errored);
  if (anySourceOk) {
    await commitScan(apiBase, botToken, commitToken).catch(() => {});
  }

  const verified = await sandbox.verifyAllClaims(records);

  const best =
    verified.find((r) => r.claim && r.verdict && r.verdict !== "insufficient") ||
    verified.find((r) => r.claim) ||
    null;
  if (!best) {
    throw new AnalysisSkipped("no verifiable claim found for any resolved member");
  }

  return {
    articleTitle: title,
    articleUrl,
    memberName: best.politician.full_name,
    claim: best.claim,
    verdict: best.verdict,
    explanation: best.verdict_explanation,
    replyText: formatReplyText(best),
  };
}

// Ported directly from background.js's figureForMember() - plain matching
// logic, not worth sandbox-loading a whole extra file for.
function figureForMember(figures, member) {
  if (!figures?.length) return null;
  const last = (member.last_name || "").toLowerCase().replace(/\./g, "").trim();
  if (last) {
    const hit = figures.find((f) => (f.lookup_name || "").toLowerCase().includes(last));
    if (hit) return hit;
  }
  return null;
}

async function reserveScan(apiBase, botToken) {
  const res = await fetch(`${apiBase}/api/scan/start`, {
    method: "POST",
    headers: { Authorization: `Bearer ${botToken}` },
  });
  if (res.status === 429) {
    const body = await res.json().catch(() => ({}));
    throw new AnalysisSkipped(`daily scan limit reached (limit: ${body.limit ?? "unknown"})`);
  }
  if (!res.ok) {
    throw new Error(`/api/scan/start HTTP ${res.status}`);
  }
  const { scanToken, commitToken } = await res.json();
  return { scanToken, commitToken };
}

async function commitScan(apiBase, botToken, commitToken) {
  return fetch(`${apiBase}/api/scan/commit`, {
    method: "POST",
    headers: { Authorization: `Bearer ${botToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ commitToken }),
  });
}

const VERDICT_LABEL = {
  supported: "Record supports this",
  contradicted: "Record contradicts this",
  mixed: "Record is mixed on this",
  insufficient: "Not enough record to judge",
};

// Cites one concrete piece of the actual record, matching the product's own
// "every verdict cites specific bills, vote positions" principle (README.md)
// - a bare verdict with no citation is exactly the kind of unsupported claim
// this product exists to check.
function citeEvidence(record) {
  const bill = record.sponsored?.[0] || record.cosponsored?.[0];
  if (bill?.title) return `via "${bill.title}"`;
  const vote = record.rollCallVotes?.[0];
  if (vote?.question || vote?.bill_title) {
    return `via vote on "${vote.bill_title || vote.question}"`;
  }
  return "source: Congress.gov/GovTrack (see liarsledger.com)";
}

function formatReplyText(record) {
  const name = record.politician.full_name;
  const label = VERDICT_LABEL[record.verdict] || record.verdict;
  const citation = citeEvidence(record);
  const header = `${name}: ${label} - ${citation}.`;
  const budget = REPLY_CHAR_LIMIT - header.length - 1;
  const explanation = (record.verdict_explanation || "").slice(0, Math.max(0, budget));
  return `${header} ${explanation}`.trim().slice(0, REPLY_CHAR_LIMIT);
}
