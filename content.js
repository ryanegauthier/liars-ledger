// Liars Ledger - content.js v0.17.8
const browser = window.browser || window.chrome;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- Logger ---
async function clog(message) {
  console.log("[Liars Ledger]", message);
}

// --- Sidebar ---
// Design system from liarsledger.com:
// --navy: #121f44  --accent: #c8a96e  --alert: #c73a25
// --text: #f1eedf  --muted: #c4c9d7  --faint: #5a5f6e
// --border: rgba(239,233,221,0.12)  --border-acc: rgba(200,169,110,0.35)
// Fonts: Oswald (headings/brand) + Inter (body/data/labels) - loaded via Google Fonts

function initSidebar() {
  const existing = document.getElementById("ll-bar");
  if (existing) {
    existing.classList.add("ll-visible");
    _savedMargin = document.body.style.marginBottom;
    document.body.style.marginBottom = existing.offsetHeight + "px";
    return;
  }

  // Google Fonts
  if (!document.getElementById("ll-fonts")) {
    const link = document.createElement("link");
    link.id = "ll-fonts";
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Oswald:wght@400;500&family=Inter:wght@400;500;600;700&display=swap";
    document.head.appendChild(link);
  }

  const style = document.createElement("style");
  style.textContent = `
    #ll-bar {
      position: fixed; bottom: 0; left: 0; right: 0; z-index: 2147483647;
      background: #0b1530;
      border-top: 2px solid #c8a96e;
      font-family: "Inter", sans-serif;
      font-size: 0.72rem;
      color: #f1eedf;
      box-shadow: 0 -8px 32px rgba(0,0,0,0.5);
      transform: translateY(100%);
      transition: transform 0.3s cubic-bezier(0.16,1,0.3,1);
    }
    #ll-bar.ll-visible { transform: translateY(0); }

    /* Header - mirrors site nav */
    #ll-header {
      display: flex; align-items: center;
      padding: 6px 16px; gap: 12px;
      background: #121f44;
      border-bottom: 1px solid rgba(239,233,221,0.12);
      min-height: 38px;
    }

    #ll-logo {
      font-family: Oswald, sans-serif;
      font-size: 0.95rem;
      text-transform: uppercase;
      letter-spacing: -0.01em;
      line-height: 1;
      white-space: nowrap;
      flex-shrink: 0;
    }
    #ll-logo .ll-liars  { color: #f1eedf; }
    #ll-logo .ll-ledger { color: #c8a96e; }

    #ll-topics {
      flex: 1;
      font-size: 0.54rem;
      color: rgba(239,233,221,0.4);
      letter-spacing: 0.1em;
      text-transform: uppercase;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #ll-topics span { color: rgba(239,233,221,0.55); margin-right: 8px; }

    #ll-close {
      background: none; border: none;
      color: rgba(239,233,221,0.35);
      cursor: pointer;
      font-family: "Inter", sans-serif;
      font-size: 0.56rem;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      padding: 3px 6px;
      transition: color 0.15s;
      flex-shrink: 0;
    }
    #ll-close:hover { color: #c8a96e; }

    /* Cards scroll row */
    #ll-cards {
      display: flex;
      overflow-x: auto;
      overflow-y: hidden;
      background: #0b1530;
      scrollbar-width: thin;
      scrollbar-color: rgba(200,169,110,0.25) transparent;
      padding: 0;
      gap: 1px;
    }
    #ll-cards::-webkit-scrollbar { height: 3px; }
    #ll-cards::-webkit-scrollbar-thumb { background: rgba(200,169,110,0.25); }

    /* Individual politician card - mirrors .mockup-bar card */
    .ll-card {
      min-width: 230px; max-width: 290px;
      padding: 10px 14px 12px;
      border-right: 1px solid rgba(239,233,221,0.08);
      border-top: 2px solid transparent;
      cursor: pointer;
      transition: background 0.15s, border-top-color 0.15s;
      flex-shrink: 0;
      background: #0f1b3a;
    }
    .ll-card:hover      { background: #121f44; border-top-color: rgba(200,169,110,0.4); }
    .ll-card.ll-active  { background: #121f44; border-top-color: #c8a96e; }

    .ll-card-eyebrow {
      font-size: 0.54rem;
      color: #c8a96e;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      margin-bottom: 1px;
    }

    .ll-card-name {
      font-family: Oswald, sans-serif;
      font-size: 0.92rem;
      color: #f1eedf;
      text-transform: uppercase;
      letter-spacing: -0.01em;
      line-height: 1.1;
      margin-bottom: 2px;
    }

    .ll-card-meta {
      font-size: 0.54rem;
      color: #c4c9d7;
      letter-spacing: 0.04em;
      margin-bottom: 6px;
    }

    .ll-party-D { color: #6a9abf; }
    .ll-party-R { color: #bf6a6a; }
    .ll-party-I { color: #5a5f6e; }

    .ll-indicators { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 4px; }

    .ll-indicator {
      font-size: 0.54rem;
      padding: 2px 7px;
      white-space: nowrap;
      letter-spacing: 0.04em;
    }
    .ll-indicator-green {
      background: rgba(27,138,132,0.15);
      color: #1b8a84;
      border: 1px solid rgba(27,138,132,0.3);
    }
    .ll-indicator-gray {
      background: rgba(239,233,221,0.05);
      color: #5a5f6e;
      border: 1px solid rgba(239,233,221,0.1);
    }

    .ll-card-claim {
      font-size: 0.58rem;
      color: #c4c9d7;
      line-height: 1.5;
      margin-top: 6px;
      padding: 5px 8px;
      border-left: 2px solid #9c7f4e;
      background: rgba(0,0,0,0.2);
      font-style: italic;
    }

    .ll-verdict-label {
      font-size: 0.5rem;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      margin-bottom: 4px;
      display: block;
      font-style: normal;
    }
    .ll-verdict-explanation {
      font-size: 0.54rem;
      color: rgba(196,201,215,0.7);
      line-height: 1.5;
      margin-top: 4px;
      font-style: normal;
    }

    .ll-card-claim.ll-verdict-supported {
      border-left-color: #1b8a84;
      border-left-width: 3px;
      background: rgba(27,138,132,0.08);
    }
    .ll-card-claim.ll-verdict-supported .ll-verdict-label { color: #1b8a84; }

    .ll-card-claim.ll-verdict-contradicted {
      border-left-color: #c73a25;
      border-left-width: 3px;
      background: rgba(199,58,37,0.08);
    }
    .ll-card-claim.ll-verdict-contradicted .ll-verdict-label { color: #c73a25; }

    .ll-card-claim.ll-verdict-mixed {
      border-left-color: #c8a96e;
      border-left-width: 3px;
      background: rgba(200,169,110,0.08);
    }
    .ll-card-claim.ll-verdict-mixed .ll-verdict-label { color: #c8a96e; }

    .ll-card-claim.ll-verdict-insufficient {
      border-left-color: #5a5f6e;
    }
    .ll-card-claim.ll-verdict-insufficient .ll-verdict-label { color: #5a5f6e; }
    .ll-verified-badge {
      display: inline-block; font-size: 0.48rem;
      padding: 1px 5px; letter-spacing: 0.08em;
      text-transform: uppercase; margin-top: 4px;
    }

    /* Card border-top colors by verdict */
    .ll-card.ll-card-supported { border-top-color: #1b8a84; }
    .ll-card.ll-card-supported:hover { border-top-color: #1b8a84; }
    .ll-card.ll-card-contradicted { border-top-color: #c73a25; }
    .ll-card.ll-card-contradicted:hover { border-top-color: #c73a25; }
    .ll-card.ll-card-mixed { border-top-color: #c8a96e; }
    .ll-card.ll-card-mixed:hover { border-top-color: #c8a96e; }

    .ll-report-btn {
      font-family: "Inter", sans-serif;
      font-size: 0.5rem;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: rgba(200,169,110,0.6);
      background: none;
      border: 1px solid rgba(200,169,110,0.2);
      padding: 2px 7px;
      cursor: pointer;
      transition: color 0.15s, border-color 0.15s;
    }
    .ll-report-btn:hover {
      color: #c8a96e;
      border-color: rgba(200,169,110,0.5);
    }

    /* Not-found cards */
    .ll-not-found-card {
      min-width: 160px;
      padding: 10px 14px;
      border-right: 1px solid rgba(239,233,221,0.08);
      flex-shrink: 0;
      opacity: 0.35;
      background: #0f1b3a;
    }
    .ll-not-found-name   { font-size: 0.7rem; color: #c4c9d7; margin-bottom: 2px; font-family: Oswald, sans-serif; text-transform: uppercase; }
    .ll-not-found-reason { font-size: 0.54rem; color: #5a5f6e; font-style: italic; }

    /* Detail panel - expandable below cards */
    #ll-detail {
      border-top: 1px solid rgba(239,233,221,0.12);
      padding: 10px 16px;
      max-height: 180px;
      overflow-y: auto;
      display: none;
      background: #0f1b3a;
      scrollbar-width: thin;
      scrollbar-color: rgba(200,169,110,0.2) transparent;
    }
    #ll-detail.ll-visible { display: block; }
    #ll-detail::-webkit-scrollbar { width: 3px; }
    #ll-detail::-webkit-scrollbar-thumb { background: rgba(200,169,110,0.2); }

    .ll-detail-title {
      font-size: 0.58rem;
      color: #c8a96e;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      margin-bottom: 6px;
    }

    .ll-detail-claim {
      font-size: 0.62rem;
      color: #c4c9d7;
      line-height: 1.5;
      margin-bottom: 10px;
      padding-bottom: 8px;
      padding-left: 8px;
      border-left: 2px solid #9c7f4e;
      border-bottom: 1px solid rgba(239,233,221,0.1);
      font-style: italic;
    }

    .ll-bill {
      padding: 6px 0;
      border-bottom: 1px solid rgba(239,233,221,0.08);
      display: flex;
      gap: 10px;
      align-items: flex-start;
    }
    .ll-bill:last-child { border-bottom: none; }

    .ll-bill-type {
      font-size: 0.54rem;
      color: #c8a96e;
      white-space: nowrap;
      min-width: 72px;
      padding-top: 2px;
      letter-spacing: 0.04em;
    }

    .ll-bill-title {
      font-size: 0.62rem;
      color: #f1eedf;
      line-height: 1.4;
      margin-bottom: 2px;
    }

    .ll-bill-date {
      font-size: 0.54rem;
      color: #5a5f6e;
      letter-spacing: 0.04em;
    }

    .ll-bill-link {
      color: #e8c98f;
      text-decoration: none;
    }
    .ll-bill-link:hover { color: #c8a96e; }

    .ll-vote-pos {
      font-size: 0.56rem;
      color: #c8a96e;
      margin-top: 2px;
      letter-spacing: 0.04em;
    }

    .ll-empty {
      font-size: 0.58rem;
      color: #5a5f6e;
      font-style: italic;
      padding: 6px 0;
    }

    .ll-summary {
      font-size: 0.58rem;
      color: rgba(239,233,221,0.4);
      line-height: 1.5;
      margin-bottom: 4px;
      max-height: 3.2em;
      overflow: hidden;
      letter-spacing: 0.02em;
    }

    /* Footer strip */
    #ll-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 16px;
      background: #0b1530;
      border-top: 1px solid rgba(239,233,221,0.08);
      min-height: 24px;
    }
    #ll-footer-source {
      font-size: 0.5rem;
      color: #3a3f4e;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    #ll-footer-right {
      display: flex; align-items: center; gap: 8px;
    }
    .ll-ticker-dot {
      width: 5px; height: 5px; border-radius: 50%;
      background: #1b8a84;
      display: inline-block;
      animation: ll-pulse 2.5s ease-in-out infinite;
    }
    @keyframes ll-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.2; }
    }
    #ll-version { font-size: 0.5rem; color: #3a3f4e; }

    /* Shared button look across popup.html, report.html, and this file's
       injected panel - all three use this same gold/accent treatment as
       the single "upgrade to pro" standard. Same class name/rules kept in
       sync manually across all three files since none of them share a
       loaded stylesheet. If you change one, change all three. This file
       hardcodes the hex values (#c8a96e = --accent, #121f44 = --navy,
       #9c7f4e = --accent-dim) instead of CSS custom properties, since this
       stylesheet is injected into arbitrary host pages that don't define
       those variables. */
    .upgrade-to-pro-btn--accent {
      display: inline-block;
      padding: 8px 18px;
      background: #c8a96e;
      color: #121f44;
      font-family: "Inter", sans-serif;
      font-size: 0.66rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      text-decoration: none;
      width: fit-content;
      transition: background 0.18s ease;
    }
    .upgrade-to-pro-btn--accent:hover { background: #9c7f4e; }
  `;
  document.head.appendChild(style);

  const bar = document.createElement("div");
  bar.id = "ll-bar";
  bar.innerHTML = `
    <div id="ll-header">
      <div id="ll-logo">
        <span class="ll-liars">Liar's </span><span class="ll-ledger">Ledger</span>
      </div>
      <div id="ll-topics"></div>
      <button id="ll-close">✕ Close</button>
    </div>
    <div id="ll-cards"></div>
    <div id="ll-detail"></div>
    <div id="ll-footer">
      <span id="ll-footer-source">congress.gov · official record · non-partisan</span>
      <div id="ll-footer-right">
        <span id="ll-pro-badge" style="display:none;color:#c8a96e;font-family:'Inter',sans-serif;font-size:0.5rem;letter-spacing:0.1em;text-transform:uppercase;margin-right:8px;">★ Pro</span>
        <span class="ll-ticker-dot"></span>
        <span id="ll-version">v0.17.8</span>
      </div>
    </div>
  `;
  document.body.appendChild(bar);

  document.getElementById("ll-close").addEventListener("click", function() {
    bar.classList.remove("ll-visible");
    document.body.style.marginBottom = _savedMargin;
  });
}

let _savedMargin = "";

function renderSidebar(results) {
  initSidebar();

  const topicsEl = document.getElementById("ll-topics");
  const cardsEl  = document.getElementById("ll-cards");
  const detailEl = document.getElementById("ll-detail");
  const bar      = document.getElementById("ll-bar");

  // Pro badge - visible only for pro tier
  const proBadge = document.getElementById("ll-pro-badge");
  if (proBadge) proBadge.style.display = results.tier === "pro" ? "inline" : "none";

  // Topics / summary strip
  const summaryHtml = results.articleSummary
    ? `<div class="ll-summary">${escapeHtml(results.articleSummary)}</div>`
    : "";
  topicsEl.innerHTML = summaryHtml +
    (results.topics || []).map(t => `<span>${escapeHtml(t)}</span>`).join("");

  // Cards
  let cardsHTML = "";

  (results.records || []).forEach(function(record, idx) {
    const p = record.politician;
    const sponsored   = record.sponsored   || [];
    const cosponsored = record.cosponsored || [];
    const rollVotes   = record.rollCallVotes || [];
    const total = sponsored.length + cosponsored.length + rollVotes.length;

    // Normalize party
    const partyRaw = p.party || "";
    const partyCode = partyRaw === "D" || partyRaw === "Democratic"   ? "D"
                    : partyRaw === "R" || partyRaw === "Republican"   ? "R"
                    : "I";
    const partyLabel = partyCode === "D" ? "DEM" : partyCode === "R" ? "REP" : partyRaw || "-";

    const chamber = p.chamber
      ? p.chamber.charAt(0).toUpperCase() + p.chamber.slice(1).toLowerCase()
      : "";
    const eyebrow = [chamber, p.state].filter(Boolean).join(" · ");

    const indicator = total > 0
      ? `<span class="ll-indicator ll-indicator-green">&#x25CF; ${total} match${total > 1 ? "es" : ""}</span>`
      : `<span class="ll-indicator ll-indicator-gray">&#x25CB; No bills or votes found</span>`;

    // Claim + verdict
    const displayClaim = record.claim || record._claude_claim || record._mistral_claim || "";
    const verdict = record.verdict || "";
    const verdictLabels = {
      supported: "✓ Record supports this claim",
      contradicted: "✗ Record contradicts this claim",
      mixed: "⚠ Mixed - record partially supports, partially contradicts",
      insufficient: "- Insufficient record data to verify",
    };
    let claimLine = "";
    if (displayClaim) {
      const verdictClass = verdict ? ` ll-verdict-${verdict}` : "";
      const verdictLabel = verdictLabels[verdict] || "";
      const explanation = record.verdict_explanation || "";
      claimLine = `<div class="ll-card-claim${verdictClass}">
        ${verdictLabel ? `<span class="ll-verdict-label">${verdictLabel}</span>` : ""}
        ${escapeHtml(displayClaim)}
        ${explanation ? `<span class="ll-verdict-explanation">${escapeHtml(explanation)}</span>` : ""}
      </div>`;
    }

    const cardClass = verdict === "supported" ? " ll-card-supported"
                    : verdict === "contradicted" ? " ll-card-contradicted"
                    : verdict === "mixed" ? " ll-card-mixed"
                    : "";

    const congressLabel = p.is_current === false
      ? `Former Member · ${p.congresses ? p.congresses[0] + "th–" + p.congresses[p.congresses.length - 1] + "th Congress" : "Previously served"}`
      : "119th Congress";

    cardsHTML += `
      <div class="ll-card${cardClass}" data-idx="${idx}">
        <div class="ll-card-eyebrow">${escapeHtml(eyebrow)}</div>
        <div class="ll-card-name">${escapeHtml(p.full_name || p.matched_as || "")}</div>
        <div class="ll-card-meta">
          <span class="ll-party-${partyCode}">${partyLabel}</span>
          &nbsp;·&nbsp;${congressLabel}
        </div>
        <div class="ll-indicators">${indicator}</div>
        ${claimLine}
        <div style="margin-top:6px">
          <button class="ll-report-btn" data-idx="${idx}">↗ Full Report</button>
        </div>
      </div>`;
  });

  (results.notFound || []).forEach(function(name) {
    cardsHTML += `
      <div class="ll-not-found-card">
        <div class="ll-not-found-name">${escapeHtml(name)}</div>
        <div class="ll-not-found-reason">Not in current Congress</div>
      </div>`;
  });

  (results.notMembers || []).forEach(function(name) {
    cardsHTML += `
      <div class="ll-not-found-card">
        <div class="ll-not-found-name">${escapeHtml(name)}</div>
        <div class="ll-not-found-reason">Not a member of Congress</div>
      </div>`;
  });

  cardsEl.innerHTML = cardsHTML;

  // Click → expand detail panel
  cardsEl.querySelectorAll(".ll-card").forEach(function(card) {
    card.addEventListener("click", function() {
      const idx    = parseInt(card.dataset.idx);
      const record = results.records[idx];
      const wasActive = card.classList.contains("ll-active");

      cardsEl.querySelectorAll(".ll-card").forEach(c => c.classList.remove("ll-active"));

      if (wasActive) {
        detailEl.classList.remove("ll-visible");
        return;
      }

      card.classList.add("ll-active");

      const p = record.politician;
      const allBills = []
        .concat((record.sponsored   || []).map(b => Object.assign({}, b, { role: "Sponsored"   })))
        .concat((record.cosponsored || []).map(b => Object.assign({}, b, { role: "Cosponsored" })))
        allBills.sort((a, b) => (b.introducedDate || "").localeCompare(a.introducedDate || ""));
        const rollVotes = record.rollCallVotes || [];

      let html = `<div class="ll-detail-title">${escapeHtml(p.full_name || p.matched_as || "")} - ${(record.topics || []).map(escapeHtml).join(", ")}</div>`;

      const detailClaim = record.claim || record._claude_claim || record._mistral_claim || "";
      const detailVerdict = record.verdict || "";
      const detailVerdictLabels = {
        supported: "✓ RECORD SUPPORTS THIS CLAIM",
        contradicted: "✗ RECORD CONTRADICTS THIS CLAIM",
        mixed: "⚠ MIXED - PARTIAL SUPPORT, PARTIAL CONTRADICTION",
        insufficient: "- INSUFFICIENT DATA TO VERIFY",
      };
      const detailVerdictColors = {
        supported: "#1b8a84",
        contradicted: "#c73a25",
        mixed: "#c8a96e",
        insufficient: "#5a5f6e",
      };
      if (detailClaim) {
        const vColor = detailVerdictColors[detailVerdict] || "#9c7f4e";
        const vLabel = detailVerdictLabels[detailVerdict] || "";
        const vExplanation = record.verdict_explanation || "";
        html += `<div class="ll-detail-claim" style="border-left-color:${vColor}">
          ${escapeHtml(detailClaim)}
          ${vLabel ? `<br><span style="color:${vColor};font-size:0.52rem;text-transform:uppercase;letter-spacing:0.08em">${vLabel}</span>` : ""}
          ${vExplanation ? `<br><span style="color:rgba(196,201,215,0.7);font-size:0.54rem;font-style:normal">${escapeHtml(vExplanation)}</span>` : ""}
        </div>`;
      } else if (results.tier !== "pro") {
        // Pro upsell for the AI claim-vs-record verdict specifically - NOT
        // for VoteSmart, which is free for everyone now (see below). Shown
        // only when there's genuinely no claim content (free tier, field
        // stripped server-side) - a Pro user whose article simply made no
        // claim about this politician sees nothing here, same as before.
        //
        // KEEP THIS CARD'S COPY IN SYNC WITH background.js's gating block
        // (search "PRO-TIER GATING" in handleAnalyze) and with report.js's
        // proFeaturesUpsellHtml. All should agree on what Pro unlocks.
        html += `
          <div style="
            background: rgba(200,169,110,0.07);
            border: 1px solid rgba(200,169,110,0.25);
            border-radius: 3px;
            padding: 14px 16px;
            margin: 6px 0 4px;
            display: flex;
            flex-direction: column;
            gap: 6px;
          ">
            <div style="
              font-family: 'Inter', sans-serif;
              font-size: 0.64rem;
              color: #c8a96e;
              text-transform: uppercase;
              letter-spacing: 0.08em;
              font-weight: 600;
            ">★ Pro feature</div>
            <div style="font-size: 0.72rem; color: #c4c9d7; line-height: 1.55;">
              See an AI-generated summary and claim-vs-record verdict with Pro.
            </div>
            <a href="${escapeHtml(results.upgradeUrl || "https://liarsledger.com/pricing")}" target="_blank"
               class="upgrade-to-pro-btn--accent" style="margin-top: 4px;">Upgrade to Pro →</a>
          </div>`;
      }

      if (rollVotes.length > 0) {
        html += `<div class="ll-detail-title" style="margin-top:10px">Roll-call votes</div>`;
        rollVotes.forEach(function(v) {
          const vurl = v.voteUrl ? escapeHtml(v.voteUrl) : "";
          const link = vurl ? ` &nbsp;<a class="ll-bill-link" href="${vurl}" target="_blank">↗ Vote page</a>` : "";
          html += `
            <div class="ll-bill">
              <div class="ll-bill-type">Roll ${escapeHtml(String(v.rollNumber || ""))}<br>${escapeHtml(String(v.session || ""))}</div>
              <div>
                <div class="ll-bill-title">${escapeHtml(v.question || "Roll call vote")}</div>
                <div class="ll-bill-date">${escapeHtml(v.date || "")}${v.legislation ? " &middot; " + escapeHtml(v.legislation) : ""}${link}</div>
                <div class="ll-vote-pos">Position: ${escapeHtml(v.position || "-")}</div>
              </div>
            </div>`;
        });
      }

      if (allBills.length > 0) {
        const typeMap = {
          s:       "senate-bill",
          hr:      "house-bill",
          sjres:   "senate-joint-resolution",
          hjres:   "house-joint-resolution",
          sres:    "senate-resolution",
          hres:    "house-resolution",
          hconres: "house-concurrent-resolution",
          sconres: "senate-concurrent-resolution",
        };
        allBills.forEach(function(bill) {
          const congress  = bill.congress || 119;
          const type      = (bill.type || "").toLowerCase();
          const number    = bill.number || "";
          const typeName  = typeMap[type] || type;
          const url       = `https://www.congress.gov/bill/${congress}th-congress/${typeName}/${number}`;
          html += `
            <div class="ll-bill">
              <div class="ll-bill-type">${escapeHtml(bill.role)}<br>${escapeHtml(bill.type || "")} ${escapeHtml(String(number))}</div>
              <div>
                <div class="ll-bill-title">${escapeHtml(bill.title || "Untitled")}</div>
                <div class="ll-bill-date">${escapeHtml(bill.introducedDate || "")} &middot; <a class="ll-bill-link" href="${url}" target="_blank">View on congress.gov →</a></div>
              </div>
            </div>`;
        });
      }

      if (allBills.length === 0 && rollVotes.length === 0) {
        html += `<div class="ll-empty">No sponsored or cosponsored bills found on these topics.</div>`;
      }

      // VoteSmart - free for everyone now (sourced data, not AI-generated).
      // Used to be Pro-gated; ungated as of the AI-vs-sourced-data tier
      // split. See background.js's PRO-TIER GATING comment for the full
      // reasoning. The claim/verdict upsell above is the real Pro pitch now.

      // VoteSmart vote history
      const vsVotes = record.voteSmartVotes || [];
      if (vsVotes.length > 0) {
        html += `<div class="ll-detail-title" style="margin-top:10px">Vote History <span style="color:#5a5f6e;font-size:0.48rem;text-transform:uppercase;letter-spacing:0.08em">&nbsp;· VoteSmart</span></div>`;
        vsVotes.forEach(function(v) {
          const posColor = v.vote === "Yea" ? "#1b8a84" : v.vote === "Nay" ? "#c73a25" : "#5a5f6e";
          html += `
            <div class="ll-bill">
              <div class="ll-bill-type" style="color:${posColor};font-weight:500">${escapeHtml(v.vote)}<br><span style="color:#5a5f6e;font-weight:400">${escapeHtml(v.date || "")}</span></div>
              <div>
                <div class="ll-bill-title">${escapeHtml(v.title || v.billNumber || "")}</div>
                <div class="ll-bill-date">${escapeHtml(v.billNumber || "")}${v.stage ? " &middot; " + escapeHtml(v.stage) : ""}${v.categories?.length ? " &middot; " + v.categories.map(escapeHtml).join(", ") : ""}</div>
              </div>
            </div>`;
        });
      }

      // VoteSmart interest group ratings
      const vsRatings = record.voteSmartRatings || [];
      if (vsRatings.length > 0) {
        html += `<div class="ll-detail-title" style="margin-top:10px">Interest Group Ratings <span style="color:#5a5f6e;font-size:0.48rem;text-transform:uppercase;letter-spacing:0.08em">&nbsp;· VoteSmart</span></div>`;
        vsRatings.forEach(function(r) {
          const pct     = typeof r.rating === "number" ? r.rating : parseInt(r.rating, 10);
          const barColor = pct >= 70 ? "#1b8a84" : pct >= 40 ? "#c8a96e" : "#c73a25";
          html += `
            <div class="ll-bill">
              <div class="ll-bill-type" style="color:${barColor};font-weight:500;font-size:0.78rem">${pct}%<br><span style="color:#5a5f6e;font-weight:400;font-size:0.5rem">${escapeHtml(r.year || "")}</span></div>
              <div>
                <div class="ll-bill-title">${escapeHtml(r.sigName || "")}</div>
                <div class="ll-bill-date">${escapeHtml(r.categories?.join(", ") || "")}</div>
              </div>
            </div>`;
        });
      }

      detailEl.innerHTML = html;
      detailEl.classList.add("ll-visible");
    });
  });

  // Report button - open standalone report page in new tab.
  // Routed through background.js via chrome.tabs.create rather than calling
  // window.open() directly here. Two reasons, found together:
  //   1. Reliability - window.open() called from a content script (running
  //      in the host page's context) is subject to that page's popup-
  //      blocking behavior and Chrome's same heuristics, which can produce
  //      ERR_BLOCKED_BY_CLIENT inconsistently depending on the host page
  //      and the user's installed extensions, even though pasting the exact
  //      same chrome-extension:// URL into a new tab directly works fine.
  //      chrome.tabs.create() from the background script's own extension
  //      context isn't subject to the host page's popup-blocking at all.
  //   2. Security - this is the same fix already noted as deferred in
  //      SECURITY.md's "Token in URL Query Parameters" section: opening via
  //      window.open(browser.runtime.getURL(...)) meant the report URL
  //      briefly existed as a value content.js's own code touched in the
  //      host page's JS context. Routing the actual chrome.tabs.create()
  //      call through background.js means content.js only ever sends an
  //      index, never constructs or touches the report URL itself.
  cardsEl.querySelectorAll(".ll-report-btn").forEach(function(btn) {
    btn.addEventListener("click", function(e) {
      e.stopPropagation(); // don't trigger card expand
      const idx = btn.dataset.idx;
      browser.runtime.sendMessage({ action: "openReport", idx });
    });
  });
  _savedMargin = document.body.style.marginBottom || "";
  document.body.style.marginBottom = "200px";

  requestAnimationFrame(function() { bar.classList.add("ll-visible"); });
}

// --- Article detection ---
function findArticleBody() {
  const selectors = [
    "article", "[role='main']", "main",
    ".article-body", ".article-content", ".story-body",
    ".post-content", ".entry-content", ".content-body",
    "#article-body", "#main-content",
    ".ArticleBody", ".article__body",
    ".StoryBodyCompanionColumn", ".article-text", ".zn-body__paragraph"
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.innerText.trim().length > 200) return { el, selector: sel };
  }
  return { el: document.body, selector: "document.body (fallback)" };
}

// --- Name extraction ---
const TITLE_PATTERN = /\b(?:President|Vice\s+President|Sen\.?|Senator|Rep\.?|Representative|Gov\.?|Governor|Mayor|Secretary|Sec\.?|Democrat|Republican|Independent)\s+([A-Z][a-z]+(?:[-'\s][A-Z][a-z]+)?)/g;

function extractPoliticianNames(text) {
  const found = new Set();
  let match;
  TITLE_PATTERN.lastIndex = 0;
  while ((match = TITLE_PATTERN.exec(text)) !== null) {
    found.add(match[0].trim());
  }
  return Array.from(found);
}

// --- Scan ---
async function scanPage() {
  await clog("scan triggered on " + window.location.hostname);
  const found = findArticleBody();
  await clog("article body found via: " + found.selector);
  const articleText = found.el.innerText;
  if (articleText.length < 100) {
    await clog("article text too short");
    return { error: "No article content detected on this page." };
  }
  await clog("article text length: " + articleText.length + " chars");
  const politicians = extractPoliticianNames(articleText);
  await clog("politicians found: " + (politicians.length > 0 ? politicians.join(", ") : "none"));
  return {
    politicians,
    articleText: articleText.slice(0, 24000),
    text_length: articleText.length
  };
}

// --- Rate-limited sidebar ---
function renderRateLimited(response) {
  initSidebar();
  const cardsEl  = document.getElementById("ll-cards");
  const detailEl = document.getElementById("ll-detail");
  const topicsEl = document.getElementById("ll-topics");
  const bar      = document.getElementById("ll-bar");

  topicsEl.innerHTML = "";
  detailEl.classList.remove("ll-visible");

  const upgradeUrl = response.upgrade_url || "https://liarsledger.com/pricing";
  cardsEl.innerHTML = `
    <div style="
      padding: 18px 20px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      border-right: 1px solid rgba(239,233,221,0.08);
      min-width: 300px;
    ">
      <div style="
        font-size: 0.54rem;
        color: #c73a25;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        margin-bottom: 2px;
      ">⊘ Daily scan limit reached</div>
      <div style="
        font-family: Oswald, sans-serif;
        font-size: 0.9rem;
        color: #f1eedf;
        text-transform: uppercase;
        letter-spacing: -0.01em;
        line-height: 1.2;
      ">Upgrade to Pro</div>
      <div style="
        font-size: 0.58rem;
        color: #c4c9d7;
        line-height: 1.5;
      ">All accounts share a daily scan pool. Pro unlocks AI summaries, claim verdicts, and full VoteSmart data.</div>
      <a href="${escapeHtml(upgradeUrl)}" target="_blank" style="
        display: inline-block;
        margin-top: 4px;
        padding: 5px 12px;
        background: #c73a25;
        color: #fff6ef;
        font-family: 'Inter', sans-serif;
        font-size: 0.54rem;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        text-decoration: none;
        width: fit-content;
      ">View Pricing →</a>
    </div>`;

  requestAnimationFrame(function() { bar.classList.add("ll-visible"); });
}

// --- Capacity warning nudge (shown after successful scan when user count is 2500-4999) ---
// Not shown to pro users - they already know they're pro, no need to upsell.
function renderCapacityWarning(upgradeUrl) {
  const footer = document.getElementById("ll-footer-source");
  if (!footer || document.getElementById("ll-capacity-warning")) return;
  const nudge = document.createElement("span");
  nudge.id = "ll-capacity-warning";
  nudge.style.cssText = [
    "display:inline-block",
    "margin-left:8px",
    "font-family:'Inter',sans-serif",
    "font-size:0.5rem",
    "color:#c8a96e",
    "letter-spacing:0.08em",
    "text-transform:uppercase",
  ].join(";");
  const url = escapeHtml(upgradeUrl || "https://liarsledger.com/pricing");
  nudge.innerHTML = `⚠ High demand - <a href="${url}" target="_blank" style="color:#c8a96e;">upgrade for guaranteed access</a>`;
  footer.appendChild(nudge);
}

// --- Poll for results ---
function startPolling() {
  console.log("[Liars Ledger] poll started");
  const poll = setInterval(function() {
    browser.runtime.sendMessage({ action: "getResults" }, function(response) {
      if (browser.runtime.lastError) return;
      if (!response || response.status === "working") return;
      clearInterval(poll);
      if (response.status === "ok") {
        renderSidebar(response);
        if (response.capacityWarning && response.tier !== "pro") renderCapacityWarning(response.upgradeUrl);
      }
      else if (response.status === "rate_limited") renderRateLimited(response);
    });
  }, 500);
  setTimeout(function() { clearInterval(poll); }, 30000);
}

// --- Message listener ---
browser.runtime.onMessage.addListener(function(message, sender, sendResponse) {
  if (message.action === "scan") {
    scanPage().then(function(result) { sendResponse(result); });
    return true;
  }
  if (message.action === "startResultsPoll") {
    startPolling();
    sendResponse({ ok: true });
    return true;
  }
  if (message.action === "showResults") {
    browser.runtime.sendMessage({ action: "getResults" }, function(response) {
      if (response?.status === "ok") {
        renderSidebar(response);
        if (response.capacityWarning && response.tier !== "pro") renderCapacityWarning(response.upgradeUrl);
      }
      else if (response?.status === "rate_limited") renderRateLimited(response);
    });
    sendResponse({ ok: true });
    return true;
  }
  return true;
});

clog("content script loaded");