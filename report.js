// Liars Ledger - report.js
// Standalone politician report page script.

const browser = window.browser || window.chrome;

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function truncate(str, len) {
  if (!str) return "";
  return str.length > len ? str.slice(0, len) + "…" : str;
}

function ratingColor(pct) {
  return pct >= 70 ? "#1b8a84" : pct >= 40 ? "#c8a96e" : "#c73a25";
}

function voteClass(vote) {
  if (vote === "Yea") return "ll-vote-yea";
  if (vote === "Nay") return "ll-vote-nay";
  return "ll-vote-notvoting";
}

function renderRecord(record, tier) {
  const p         = record.politician || {};
  const partyRaw  = p.party || "";
  const partyCode = partyRaw === "D" || partyRaw === "Democratic" ? "D"
                  : partyRaw === "R" || partyRaw === "Republican"  ? "R" : "I";
  const partyLabel = partyCode === "D" ? "DEM" : partyCode === "R" ? "REP" : partyRaw || "IND";
  const chamber   = p.chamber ? p.chamber.charAt(0).toUpperCase() + p.chamber.slice(1).toLowerCase() : "";
  const eyebrow   = [chamber, p.state].filter(Boolean).join(" · ");

  // Claim + verdict
  const displayClaim = record.claim || record._claude_claim || record._mistral_claim || "";
  const verdict = record.verdict || "";
  const verdictLabels = {
    supported: "✓ Record supports this claim",
    contradicted: "✗ Record contradicts this claim",
    mixed: "⚠ Mixed - record partially supports, partially contradicts",
    insufficient: "- Insufficient record data to verify",
  };
  let claimHtml = "";
  if (displayClaim) {
    const verdictClass = verdict ? ` ll-verdict-${verdict}` : "";
    const verdictLabel = verdictLabels[verdict] || "";
    const explanation = record.verdict_explanation || "";
    claimHtml = `
      <div class="ll-claim${verdictClass}">
        ${verdictLabel ? `<span class="ll-claim-label ${verdict}">${verdictLabel}</span>` : ""}
        ${escapeHtml(displayClaim)}
        ${explanation ? `<span class="ll-verdict-explanation">${escapeHtml(explanation)}</span>` : ""}
      </div>`;
  }

  // Bills
  const typeMap = {
    s: "senate-bill", hr: "house-bill",
    sjres: "senate-joint-resolution", hjres: "house-joint-resolution",
    sres: "senate-resolution", hres: "house-simple-resolution",
  };
  const allBills = []
    .concat((record.sponsored   || []).map(b => ({ ...b, role: "Sponsored"   })))
    .concat((record.cosponsored || []).map(b => ({ ...b, role: "Cosponsored" })));

  const billsHtml = allBills.length === 0
    ? `<div class="ll-empty">No sponsored or cosponsored bills found on these topics.</div>`
    : allBills.map(bill => {
        const type = (bill.type || "").toLowerCase();
        const num  = bill.number || "";
        const url  = `https://www.congress.gov/bill/${bill.congress || 119}th-congress/${typeMap[type] || type}/${num}`;
        return `
          <div class="ll-row">
            <div class="ll-row-left" style="color:#c8a96e">
              ${escapeHtml(bill.role)}<br>
              <span style="font-size:0.58rem">${escapeHtml(bill.type || "")} ${escapeHtml(String(num))}</span>
            </div>
            <div class="ll-row-right">
              <div>${escapeHtml(bill.title || "")}</div>
              <div class="ll-row-sub">${escapeHtml(bill.introducedDate || "")} · <a href="${escapeHtml(url)}" target="_blank">View on congress.gov →</a></div>
            </div>
          </div>`;
      }).join("");

  // GovTrack roll-call votes
  const rollVotes = record.rollCallVotes || [];
  const rollHtml = rollVotes.length === 0
    ? `<div class="ll-empty">No roll-call votes found on these topics.</div>`
    : rollVotes.map(v => {
        const vurl = v.voteUrl ? `<a href="${escapeHtml(v.voteUrl)}" target="_blank">↗ Vote page</a>` : "";
        return `
          <div class="ll-row">
            <div class="ll-row-left ${voteClass(v.position)}">${escapeHtml(v.position || "-")}<br>
              <span style="font-size:0.56rem;color:#5a5f6e">${escapeHtml(v.date || "")}</span>
            </div>
            <div class="ll-row-right">
              <div>${escapeHtml(v.question || "")}</div>
              <div class="ll-row-sub">${v.legislation ? escapeHtml(v.legislation) + " · " : ""}${vurl}</div>
            </div>
          </div>`;
      }).join("");

  // VoteSmart — gated behind Pro. Free tier sees a single upsell card
  // instead of the real sections (or a broken-looking empty state).
  const isPro = tier === "pro";

  // Combined pro-features upsell — shown once, replacing both VoteSmart
  // sections, when the user is on free tier.
  //
  // KEEP THIS BULLET LIST IN SYNC WITH background.js's gating block
  // (search "PRO-TIER GATING" in handleAnalyze). Each bullet here should
  // correspond to a field that's actually being stripped there for free
  // tier — if you add/remove a gated field in background.js, update this
  // list too.
  const proFeaturesUpsellHtml = `
    <div style="
      background: rgba(200,169,110,0.07);
      border: 1px solid rgba(200,169,110,0.25);
      border-radius: 3px;
      padding: 18px 20px;
      margin: 8px 0;
      display: flex;
      flex-direction: column;
      gap: 10px;
    ">
      <a href="https://liarsledger.com/pricing" target="_blank" style="
        display: inline-block;
        padding: 8px 18px;
        background: #c8a96e;
        color: #121f44;
        font-family: 'Inter', sans-serif;
        font-size: 0.66rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        text-decoration: none;
        width: fit-content;
      ">Upgrade to Pro →</a>
      <div style="
        font-family: 'Inter', sans-serif;
        font-size: 0.62rem;
        color: #c8a96e;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        font-weight: 600;
        margin-top: 4px;
      ">Pro features</div>
      <ul style="
        margin: 0;
        padding-left: 18px;
        font-size: 0.74rem;
        color: #c4c9d7;
        line-height: 1.9;
      ">
        <li>Full VoteSmart vote history for every politician</li>
        <li>Interest group ratings and scorecards</li>
        <li>AI-generated article summary</li>
        <li>AI claim-vs-record analysis and verdicts</li>
      </ul>
    </div>`;

  // VoteSmart votes (pro only — used in the pro-tier section below)
  const vsVotes = record.voteSmartVotes || [];
  const vsVotesHtml = vsVotes.length === 0
    ? `<div class="ll-empty">No topic-matched votes found.</div>`
    : vsVotes.map(v => `
        <div class="ll-row">
          <div class="ll-row-left ${voteClass(v.vote)}">${escapeHtml(v.vote)}<br>
            <span style="font-size:0.56rem;color:#5a5f6e">${escapeHtml(v.date || "")}</span>
          </div>
          <div class="ll-row-right">
            <div>${escapeHtml(v.title || "")}</div>
            <div class="ll-row-sub">${escapeHtml(v.billNumber || "")}${v.stage ? " · " + escapeHtml(v.stage) : ""}${v.categories?.length ? " · " + v.categories.map(escapeHtml).join(", ") : ""}</div>
          </div>
        </div>`).join("");

  // VoteSmart ratings (pro only — used in the pro-tier section below)
  const vsRatings = record.voteSmartRatings || [];
  const vsRatingsHtml = vsRatings.length === 0
    ? `<div class="ll-empty">No interest group ratings found.</div>`
    : vsRatings.map(r => {
        const pct   = typeof r.rating === "number" ? r.rating : parseInt(r.rating, 10);
        const color = ratingColor(pct);
        return `
          <div class="ll-rating-row">
            <div class="ll-rating-score" style="color:${color}">${pct}%
              <div class="ll-rating-year">${escapeHtml(r.year || "")}</div>
            </div>
            <div>
              <div class="ll-rating-name">${escapeHtml(r.sigName || "")}</div>
              <div class="ll-rating-cats">${escapeHtml((r.categories || []).join(", "))}</div>
              <div class="ll-rating-bar-wrap">
                <div class="ll-rating-bar" style="width:${pct}%;background:${color}"></div>
              </div>
            </div>
            <div class="ll-rating-text">${escapeHtml(r.ratingText || "")}</div>
          </div>`;
      }).join("");

  // Combined VoteSmart section — split into two sub-sections for pro,
  // single upsell card with section title for free.
  const voteSmartSectionHtml = !isPro
    ? `
      <div class="ll-section">
        <div class="ll-section-title">Vote History &amp; Interest Group Ratings <span class="ll-section-source">· votesmart</span></div>
        ${proFeaturesUpsellHtml}
      </div>`
    : `
      <div class="ll-section">
        <div class="ll-section-title">Vote History <span class="ll-section-source">· votesmart</span></div>
        ${vsVotesHtml}
      </div>

      <div class="ll-section">
        <div class="ll-section-title">Interest Group Ratings <span class="ll-section-source">· votesmart</span></div>
        ${vsRatingsHtml}
      </div>`;

  const congressLabel = p.is_current === false
    ? `Former Member · ${p.congresses ? p.congresses[0] + "th–" + p.congresses[p.congresses.length - 1] + "th Congress" : "Previously served"}`
    : "119th Congress";

  const headerBorderColor = verdict === "supported" ? "#1b8a84"
                         : verdict === "contradicted" ? "#c73a25"
                         : verdict === "mixed" ? "#c8a96e"
                         : "#c8a96e";

  return `
    <div class="ll-politician-header" style="border-top-color:${headerBorderColor}">
      <div class="ll-eyebrow">${escapeHtml(eyebrow)}</div>
      <div class="ll-name">${escapeHtml(p.full_name || p.matched_as || "")}
        <span class="ll-party-pill ll-party-${partyCode}">${partyLabel}</span>
      </div>
      <div class="ll-party-meta">${congressLabel} · ${escapeHtml(p.bioguide_id || "")}</div>
      ${claimHtml}
    </div>

    <div class="ll-section">
      <div class="ll-section-title">Legislation <span class="ll-section-source">· congress.gov</span></div>
      ${billsHtml}
    </div>

    <div class="ll-section">
      <div class="ll-section-title">Roll-Call Votes <span class="ll-section-source">· govtrack</span></div>
      ${rollHtml}
    </div>

    ${voteSmartSectionHtml}

    <hr style="border:none;border-top:1px solid rgba(239,233,221,0.12);margin:32px 0">
  `;
}

async function loadReport() {
  document.getElementById("reportDate").textContent =
    new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  const params = new URLSearchParams(window.location.search);
  const idx    = params.get("idx") !== null ? parseInt(params.get("idx")) : null;

  const storage = await browser.storage.session.get("ll_results");
  const results = storage.ll_results;

  if (!results || results.status !== "ok" || !results.records?.length) {
    document.getElementById("reportContent").innerHTML = `
      <div class="ll-error">
        <h2>No data available</h2>
        <p>Scan a news article first, then open a report from the sidebar.</p>
      </div>`;
    return;
  }

  const records = idx !== null && results.records[idx]
    ? [results.records[idx]]
    : results.records;

  if (records.length === 1) {
    document.title = `Liar's Ledger - ${records[0].politician?.full_name || "Report"}`;
  }

  document.getElementById("reportContent").innerHTML =
    records.map(r => renderRecord(r, results.tier)).join("");
}

document.addEventListener("DOMContentLoaded", loadReport);
