/**
 * ll-bar.js - Liar's Ledger in-page bottom bar
 *
 * Injected into article pages by content.js after scan completes.
 * Call: LiarsLedgerBar.show(result) to render, LiarsLedgerBar.hide() to remove.
 *
 * Mirrors the .mockup-bar aesthetic from liarsledger.com:
 * navy bg, gold accent border-top, IBM Plex Mono + Oswald, no border-radius.
 *
 * Usage in content.js:
 *   import/importScripts this file, then:
 *   LiarsLedgerBar.show(result);
 */

const LiarsLedgerBar = (() => {

  const BAR_ID = "ll-bottom-bar";

  const FONTS = `
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Oswald:wght@400;500&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
  `;

  const STYLES = `
    :host {
      all: initial;
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      z-index: 2147483647;
      font-family: "IBM Plex Mono", monospace;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    .ll-bar {
      background: #0f1b3a;
      border-top: 2px solid #c8a96e;
      color: #f1eedf;
      font-family: "IBM Plex Mono", monospace;
      font-size: 0.72rem;
      max-height: 320px;
      display: flex;
      flex-direction: column;
      box-shadow: 0 -8px 32px rgba(0,0,0,0.45);
    }

    /* Header row */
    .ll-bar-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 16px;
      background: #121f44;
      border-bottom: 1px solid rgba(239,233,221,0.12);
      flex-shrink: 0;
    }

    .ll-brand {
      font-family: Oswald, sans-serif;
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: -0.01em;
      line-height: 1;
    }
    .ll-brand-liars  { color: #f1eedf; }
    .ll-brand-ledger { color: #c8a96e; }

    .ll-header-right {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .ll-topics {
      font-size: 0.54rem;
      color: rgba(239,233,221,0.45);
      letter-spacing: 0.1em;
      text-transform: uppercase;
      max-width: 420px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .ll-close {
      background: none;
      border: none;
      color: rgba(239,233,221,0.4);
      cursor: pointer;
      font-family: "IBM Plex Mono", monospace;
      font-size: 0.6rem;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      padding: 2px 6px;
      transition: color 0.15s;
    }
    .ll-close:hover { color: #c8a96e; }

    /* Cards scroll area */
    .ll-cards {
      display: flex;
      flex-direction: row;
      gap: 1px;
      overflow-x: auto;
      overflow-y: hidden;
      padding: 10px 14px;
      background: #0b1530;
      flex: 1;
    }

    .ll-cards::-webkit-scrollbar { height: 3px; }
    .ll-cards::-webkit-scrollbar-thumb { background: rgba(200,169,110,0.3); }
    .ll-cards::-webkit-scrollbar-track { background: transparent; }

    /* Individual card - mirrors .mockup-bar card structure */
    .ll-card {
      background: #121f44;
      border-top: 2px solid #9c7f4e;
      padding: 8px 12px 10px;
      min-width: 240px;
      max-width: 300px;
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      gap: 0;
    }

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
    }

    .ll-party-pill {
      display: inline-block;
      font-family: "IBM Plex Mono", monospace;
      font-size: 0.46rem;
      letter-spacing: 0.1em;
      padding: 1px 5px;
      border: 1px solid;
      margin-left: 5px;
      vertical-align: middle;
      position: relative; top: -1px;
    }
    .ll-party-D { color: #6a9abf; border-color: rgba(106,154,191,0.4); }
    .ll-party-R { color: #bf6a6a; border-color: rgba(191,106,106,0.4); }
    .ll-party-I { color: #5a5f6e; border-color: #5a5f6e; }

    .ll-card-meta {
      font-size: 0.54rem;
      color: #c4c9d7;
      letter-spacing: 0.04em;
      margin: 2px 0 6px;
    }

    .ll-card-claim {
      font-size: 0.6rem;
      color: #c4c9d7;
      line-height: 1.5;
      margin-bottom: 6px;
      padding: 5px 8px;
      border-left: 2px solid #9c7f4e;
      background: rgba(0,0,0,0.2);
      font-style: italic;
    }

    .ll-bill-row {
      display: flex;
      align-items: baseline;
      gap: 6px;
      padding: 4px 0;
      border-top: 1px solid rgba(239,233,221,0.1);
    }

    .ll-bill-id {
      font-size: 0.54rem;
      color: #c8a96e;
      white-space: nowrap;
      flex-shrink: 0;
      letter-spacing: 0.04em;
    }

    .ll-bill-title {
      font-size: 0.56rem;
      color: #c4c9d7;
      line-height: 1.35;
      flex: 1;
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }

    .ll-bill-link {
      font-size: 0.54rem;
      color: #e8c98f;
      text-decoration: none;
      flex-shrink: 0;
    }
    .ll-bill-link:hover { color: #c8a96e; }

    .ll-no-bills {
      font-size: 0.54rem;
      color: #5a5f6e;
      padding: 4px 0;
      border-top: 1px solid rgba(239,233,221,0.1);
    }

    /* Footer strip */
    .ll-bar-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 16px;
      background: #0b1530;
      border-top: 1px solid rgba(239,233,221,0.08);
      flex-shrink: 0;
    }

    .ll-footer-source {
      font-size: 0.5rem;
      color: #5a5f6e;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }

    .ll-footer-right {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .ll-ticker-dot {
      width: 5px; height: 5px;
      border-radius: 50%;
      background: #1b8a84;
      display: inline-block;
      animation: ll-pulse 2.5s ease-in-out infinite;
    }

    @keyframes ll-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.2; }
    }

    .ll-version {
      font-size: 0.5rem;
      color: #3a3f4e;
      letter-spacing: 0.06em;
    }
  `;

  function truncate(str, max = 72) {
    if (!str) return "";
    return str.length > max ? str.slice(0, max) + "…" : str;
  }

  function buildBillId(bill) {
    if (bill.type && bill.number) return `${bill.type} ${bill.number}`;
    if (bill.amendmentNumber)     return `AMDT ${bill.amendmentNumber}`;
    return "-";
  }

  function buildBillUrl(bill) {
    if (!bill.url) return null;
    return bill.url
      .replace("api.congress.gov/v3", "congress.gov")
      .replace("?format=json", "");
  }

  function buildCardHTML(record) {
    const member = record.politician;
    const party  = member.party || "";
    const partyClass = party === "D" ? "ll-party-D" : party === "R" ? "ll-party-R" : "ll-party-I";
    const partyLabel = party === "D" ? "DEM" : party === "R" ? "REP" : party || "-";
    const chamber = member.chamber
      ? member.chamber.charAt(0).toUpperCase() + member.chamber.slice(1).toLowerCase()
      : "";
    const eyebrow = [chamber, member.state].filter(Boolean).join(" · ");

    const claimHtml = record.claim
      ? `<div class="ll-card-claim">${record.claim}</div>`
      : "";

    const allBills = [...(record.sponsored || []), ...(record.cosponsored || [])];
    const seen = new Set();
    const bills = allBills.filter(b => {
      const k = b.url || (b.type + b.number);
      if (seen.has(k)) return false;
      seen.add(k); return true;
    }).slice(0, 4);

    const billsHtml = bills.length
      ? bills.map(b => {
          const url = buildBillUrl(b);
          return `<div class="ll-bill-row">
            <span class="ll-bill-id">${buildBillId(b)}</span>
            <span class="ll-bill-title">${truncate(b.title)}</span>
            ${url ? `<a class="ll-bill-link" href="${url}" target="_blank">↗</a>` : ""}
          </div>`;
        }).join("")
      : `<div class="ll-no-bills">No matching bills in 119th Congress.</div>`;

    return `
      <div class="ll-card">
        <div class="ll-card-eyebrow">${eyebrow}</div>
        <div class="ll-card-name">
          ${member.full_name || member.matched_as}
          <span class="ll-party-pill ${partyClass}">${partyLabel}</span>
        </div>
        <div class="ll-card-meta">119th Congress · ${member.bioguide_id || ""}</div>
        ${claimHtml}
        ${billsHtml}
      </div>
    `;
  }

  function show(result) {
    hide(); // remove any existing bar

    if (!result?.records?.length) return;

    const topics = result.topics?.length
      ? "Topics: " + result.topics.map(t => t.toUpperCase()).join(" · ")
      : "Source: Congress.gov · 119th Congress";

    const cardsHtml = result.records.map(buildCardHTML).join("");

    // Use Shadow DOM to isolate from host page styles
    const host = document.createElement("div");
    host.id = BAR_ID;
    document.body.appendChild(host);

    const shadow = host.attachShadow({ mode: "open" });

    shadow.innerHTML = `
      ${FONTS}
      <style>${STYLES}</style>
      <div class="ll-bar">
        <div class="ll-bar-header">
          <div class="ll-brand">
            <span class="ll-brand-liars">Liar's </span><span class="ll-brand-ledger">Ledger</span>
          </div>
          <div class="ll-header-right">
            <span class="ll-topics">${topics}</span>
            <button class="ll-close" id="ll-close-btn">✕ Close</button>
          </div>
        </div>
        <div class="ll-cards">
          ${cardsHtml}
        </div>
        <div class="ll-bar-footer">
          <span class="ll-footer-source">congress.gov · official record · non-partisan</span>
          <div class="ll-footer-right">
            <span class="ll-ticker-dot"></span>
            <span class="ll-version">v0.17.2</span>
          </div>
        </div>
      </div>
    `;

    shadow.getElementById("ll-close-btn").addEventListener("click", hide);

    // Nudge page content up so bar doesn't cover it
    _savedMargin = document.body.style.marginBottom;
    document.body.style.marginBottom = "180px";
  }

  function hide() {
    const existing = document.getElementById(BAR_ID);
    if (existing) existing.remove();
    if (_savedMargin !== null) {
      document.body.style.marginBottom = _savedMargin;
      _savedMargin = null;
    }
  }

  let _savedMargin = null;

  return { show, hide };

})();
