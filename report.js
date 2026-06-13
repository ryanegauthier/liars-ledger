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

function renderRecord(record) {
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
    mixed: "⚠ Mixed — record partially supports, partially contradicts",
    insufficient: "— Insufficient record data to verify",
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
              <div>${escapeHtml(truncate(bill.title, 120))}</div>
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
            <div class="ll-row-left ${voteClass(v.position)}">${escapeHtml(v.position || "—")}<br>
              <span style="font-size:0.56rem;color:#5a5f6e">${escapeHtml(v.date || "")}</span>
            </div>
            <div class="ll-row-right">
              <div>${escapeHtml(truncate(v.question, 120))}</div>
              <div class="ll-row-sub">${v.legislation ? escapeHtml(v.legislation) + " · " : ""}${vurl}</div>
            </div>
          </div>`;
      }).join("");

  // VoteSmart votes
  const vsVotes = record.voteSmartVotes || [];
  const vsVotesHtml = vsVotes.length === 0
    ? `<div class="ll-empty">No topic-matched votes found.</div>`
    : vsVotes.map(v => `
        <div class="ll-row">
          <div class="ll-row-left ${voteClass(v.vote)}">${escapeHtml(v.vote)}<br>
            <span style="font-size:0.56rem;color:#5a5f6e">${escapeHtml(v.date || "")}</span>
          </div>
          <div class="ll-row-right">
            <div>${escapeHtml(truncate(v.title, 120))}</div>
            <div class="ll-row-sub">${escapeHtml(v.billNumber || "")}${v.stage ? " · " + escapeHtml(v.stage) : ""}${v.categories?.length ? " · " + v.categories.map(escapeHtml).join(", ") : ""}</div>
          </div>
        </div>`).join("");

  // VoteSmart ratings
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
            <div class="ll-rating-text">${escapeHtml(truncate(r.ratingText, 120))}</div>
          </div>`;
      }).join("");

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

    <div class="ll-section">
      <div class="ll-section-title">Vote History <span class="ll-section-source">· votesmart</span></div>
      ${vsVotesHtml}
    </div>

    <div class="ll-section">
      <div class="ll-section-title">Interest Group Ratings <span class="ll-section-source">· votesmart</span></div>
      ${vsRatingsHtml}
    </div>

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
    document.title = `Liar's Ledger — ${records[0].politician?.full_name || "Report"}`;
  }

  document.getElementById("reportContent").innerHTML = records.map(renderRecord).join("");
}

document.addEventListener("DOMContentLoaded", loadReport);
