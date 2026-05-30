// Liars Ledger - content.js v0.9.0
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
  try {
    const result = await browser.storage.session.get("ll_debug_log");
    const entries = result.ll_debug_log || [];
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    entries.push(`[${ts}] content: ${message}`);
    if (entries.length > 200) entries.splice(0, entries.length - 200);
    await browser.storage.session.set({ ll_debug_log: entries });
  } catch (e) {}
}

// --- Sidebar ---
// Design system from liarsledger.com:
// --navy: #121f44  --accent: #c8a96e  --alert: #c73a25
// --text: #f1eedf  --muted: #c4c9d7  --faint: #5a5f6e
// --border: rgba(239,233,221,0.12)  --border-acc: rgba(200,169,110,0.35)
// Fonts: Oswald (headings/brand) + IBM Plex Mono (data/mono) — loaded via Google Fonts

function initSidebar() {
  if (document.getElementById("ll-bar")) return;

  // Google Fonts
  if (!document.getElementById("ll-fonts")) {
    const link = document.createElement("link");
    link.id = "ll-fonts";
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Oswald:wght@400;500&family=IBM+Plex+Mono:wght@400;500&display=swap";
    document.head.appendChild(link);
  }

  const style = document.createElement("style");
  style.textContent = `
    #ll-bar {
      position: fixed; bottom: 0; left: 0; right: 0; z-index: 2147483647;
      background: #0b1530;
      border-top: 2px solid #c8a96e;
      font-family: "IBM Plex Mono", monospace;
      font-size: 0.72rem;
      color: #f1eedf;
      box-shadow: 0 -8px 32px rgba(0,0,0,0.5);
      transform: translateY(100%);
      transition: transform 0.3s cubic-bezier(0.16,1,0.3,1);
    }
    #ll-bar.ll-visible { transform: translateY(0); }

    /* Header — mirrors site nav */
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
      font-family: "IBM Plex Mono", monospace;
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

    /* Individual politician card — mirrors .mockup-bar card */
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
    .ll-card-claim.ll-verified {
      border-left-color: #1b8a84;
      border-left-width: 3px;
      background: rgba(27,138,132,0.08);
    }
    .ll-card-claim.ll-ambiguous { border-left-color: #c8a96e; font-style: normal; }

    .ll-verified-label {
      font-size: 0.5rem; color: #1b8a84;
      text-transform: uppercase; letter-spacing: 0.12em;
      margin-bottom: 4px; display: block;
      font-style: normal;
    }
    .ll-ambiguous-label {
      font-size: 0.5rem; color: #c8a96e;
      text-transform: uppercase; letter-spacing: 0.1em;
      margin-bottom: 3px; display: block;
    }
    .ll-ambiguous-model {
      font-size: 0.52rem; color: #5a5f6e;
      text-transform: uppercase; letter-spacing: 0.08em;
      margin-bottom: 1px; display: block;
    }
    .ll-ambiguous-text {
      font-size: 0.58rem; color: #c4c9d7;
      line-height: 1.5; font-style: italic;
      display: block; margin-bottom: 4px;
    }
    .ll-verified-badge {
      display: inline-block; font-size: 0.48rem;
      color: #1b8a84; border: 1px solid rgba(27,138,132,0.4);
      padding: 1px 5px; letter-spacing: 0.08em;
      text-transform: uppercase; margin-top: 4px;
    }

    /* Green card border-top for dual-verified politicians */
    .ll-card.ll-card-verified { border-top-color: #1b8a84; }
    .ll-card.ll-card-verified:hover { border-top-color: #1b8a84; }

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

    /* Detail panel — expandable below cards */
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
        <span class="ll-ticker-dot"></span>
        <span id="ll-version">v0.9.0</span>
      </div>
    </div>
  `;
  document.body.appendChild(bar);

  document.getElementById("ll-close").addEventListener("click", function() {
    bar.classList.remove("ll-visible");
    document.body.style.marginBottom = _savedMargin;
    setTimeout(function() { bar.remove(); }, 350);
  });
}

let _savedMargin = "";

function renderSidebar(results) {
  initSidebar();

  const topicsEl = document.getElementById("ll-topics");
  const cardsEl  = document.getElementById("ll-cards");
  const detailEl = document.getElementById("ll-detail");
  const bar      = document.getElementById("ll-bar");

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
    const partyLabel = partyCode === "D" ? "DEM" : partyCode === "R" ? "REP" : partyRaw || "—";

    const chamber = p.chamber
      ? p.chamber.charAt(0).toUpperCase() + p.chamber.slice(1).toLowerCase()
      : "";
    const eyebrow = [chamber, p.state].filter(Boolean).join(" · ");

    const indicator = total > 0
      ? `<span class="ll-indicator ll-indicator-green">&#x25CF; ${total} match${total > 1 ? "es" : ""}</span>`
      : `<span class="ll-indicator ll-indicator-gray">&#x25CB; No bills or votes found</span>`;

    // Claim — three states:
    // Claim — three states:
    // dual_verified: green border + "✓ Verified Statement" label + green card top border
    // ambiguous: amber border + both model interpretations
    // single_model/other: plain italic claim
    const isVerified = record._verification === "dual_verified";
    let claimLine = "";
    if (record._verification === "ambiguous" && (record._claude_claim || record._mistral_claim)) {
      claimLine = `<div class="ll-card-claim ll-ambiguous">
        <span class="ll-ambiguous-label">⚠ Models disagreed</span>
        ${record._claude_claim ? `<span class="ll-ambiguous-model">Claude</span><span class="ll-ambiguous-text">${escapeHtml(record._claude_claim)}</span>` : ""}
        ${record._mistral_claim ? `<span class="ll-ambiguous-model">Mistral</span><span class="ll-ambiguous-text">${escapeHtml(record._mistral_claim)}</span>` : ""}
      </div>`;
    } else if (record.claim) {
      claimLine = `<div class="ll-card-claim${isVerified ? " ll-verified" : ""}">
        ${isVerified ? `<span class="ll-verified-label">✓ Verified Statement</span>` : ""}
        ${escapeHtml(record.claim)}
      </div>`;
    }

    cardsHTML += `
      <div class="ll-card${isVerified ? " ll-card-verified" : ""}" data-idx="${idx}">
        <div class="ll-card-eyebrow">${escapeHtml(eyebrow)}</div>
        <div class="ll-card-name">${escapeHtml(p.full_name || p.matched_as || "")}</div>
        <div class="ll-card-meta">
          <span class="ll-party-${partyCode}">${partyLabel}</span>
          &nbsp;·&nbsp;119th Congress
        </div>
        <div class="ll-indicators">${indicator}</div>
        ${claimLine}
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
        .concat((record.cosponsored || []).map(b => Object.assign({}, b, { role: "Cosponsored" })));
      const rollVotes = record.rollCallVotes || [];

      let html = `<div class="ll-detail-title">${escapeHtml(p.full_name || p.matched_as || "")} &mdash; ${(record.topics || []).map(escapeHtml).join(", ")}</div>`;

      if (record._verification === "ambiguous" && (record._claude_claim || record._mistral_claim)) {
        html += `<div class="ll-detail-claim" style="border-left-color:#c8a96e">
          <strong style="color:#c8a96e;font-size:0.54rem;text-transform:uppercase;letter-spacing:0.1em">⚠ Models disagreed on this claim</strong><br><br>
          ${record._claude_claim ? `<span style="color:#5a5f6e;font-size:0.52rem;text-transform:uppercase">Claude:</span><br>${escapeHtml(record._claude_claim)}<br><br>` : ""}
          ${record._mistral_claim ? `<span style="color:#5a5f6e;font-size:0.52rem;text-transform:uppercase">Mistral:</span><br>${escapeHtml(record._mistral_claim)}` : ""}
        </div>`;
      } else if (record.claim) {
        const isVerified = record._verification === "dual_verified";
        html += `<div class="ll-detail-claim"${isVerified ? ' style="border-left-color:#1b8a84"' : ""}>
          ${escapeHtml(record.claim)}
          ${isVerified ? `<br><span style="color:#1b8a84;font-size:0.52rem;text-transform:uppercase;letter-spacing:0.08em">✓ Dual verified — Claude &amp; Mistral agree</span>` : ""}
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
                <div class="ll-vote-pos">Position: ${escapeHtml(v.position || "—")}</div>
              </div>
            </div>`;
        });
      }

      if (allBills.length > 0) {
        const typeMap = {
          s: "senate-bill", hr: "house-bill",
          sjres: "senate-joint-resolution", hjres: "house-joint-resolution",
          sres: "senate-resolution", hres: "house-simple-resolution",
          sconres: "senate-concurrent-resolution", hconres: "house-concurrent-resolution"
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
        html += `<div class="ll-empty">No sponsored or cosponsored bills found on these topics in the 119th Congress.</div>`;
      }

      detailEl.innerHTML = html;
      detailEl.classList.add("ll-visible");
    });
  });

  // Nudge page content so bar doesn't cover footer
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

// --- Poll for results ---
function startPolling() {
  console.log("[Liars Ledger] poll started");
  const poll = setInterval(function() {
    browser.runtime.sendMessage({ action: "getResults" }, function(response) {
      if (browser.runtime.lastError) return;
      if (!response || response.status === "working") return;
      clearInterval(poll);
      if (response.status === "ok") renderSidebar(response);
    });
  }, 500);
  setTimeout(function() { clearInterval(poll); }, 30000);
}

// --- Message listener ---
browser.runtime.onMessage.addListener(function(message, sender, sendResponse) {
  if (message.action === "scan") {
    browser.storage.session.set({ ll_results: { status: "working" } });
    scanPage().then(function(result) { sendResponse(result); });
    return true;
  }
  if (message.action === "startResultsPoll") {
    startPolling();
    sendResponse({ ok: true });
    return true;
  }
  return true;
});

clog("content script loaded");