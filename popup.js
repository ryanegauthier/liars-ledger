// Liar's Ledger - popup.js v0.11.2

const browser = window.browser || window.chrome;
const toggle         = document.getElementById("enableToggle");
const scanBtn        = document.getElementById("scanBtn");
const statusEl       = document.getElementById("status");
const cardsContainer = document.getElementById("cardsContainer");
const tickerText     = document.getElementById("tickerText");
const versionLabel   = document.getElementById("versionLabel");

// ── Toggle ────────────────────────────────────────────────────────────────────
browser.storage.local.get("enabled", (data) => {
  toggle.checked = data.enabled !== false;
});
toggle.addEventListener("change", () => {
  browser.storage.local.set({ enabled: toggle.checked });
});

// ── Proxy check ───────────────────────────────────────────────────────────────
function getProxyUrl() {
  return CONFIG?.PROXY_URL || CONFIG?.CLAUDE_API_ENDPOINT || null;
}

// ── Status helpers ────────────────────────────────────────────────────────────
function setStatus(text, type = "") {
  statusEl.textContent = text;
  statusEl.className = "status" + (type ? " " + type : "");
}

// ── Card rendering ─────────────────────────────────────────────────────────────
function buildBillId(bill) {
  if (bill.type && bill.number) return `${bill.type} ${bill.number}`;
  if (bill.amendmentNumber)     return `AMDT ${bill.amendmentNumber}`;
  return "—";
}

function buildBillUrl(bill) {
  if (!bill.url) return null;
  return bill.url
    .replace("api.congress.gov/v3", "congress.gov")
    .replace("?format=json", "");
}

function truncate(str, max = 75) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max) + "…" : str;
}

function renderCards(result) {
  cardsContainer.innerHTML = "";
  if (!result?.records?.length) return;

  if (result.topics?.length) {
    tickerText.textContent =
      `Topics: ${result.topics.map(t => t.toUpperCase()).join(" · ")}`;
  }

  for (const record of result.records) {
    const member = record.politician;
    const card = document.createElement("div");
    card.className = "ledger-card";

    const party = member.party || "";
    const partyClass = party === "D" ? "party-D" : party === "R" ? "party-R" : "party-I";
    const partyLabel = party === "D" ? "DEM" : party === "R" ? "REP" : party || "—";

    const chamber = member.chamber
      ? member.chamber.charAt(0).toUpperCase() + member.chamber.slice(1).toLowerCase()
      : "";
    const eyebrow = [chamber, member.state].filter(Boolean).join(" · ");

    const claimHtml = record.claim
      ? `<div class="card-claim">${record.claim}</div>`
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
          return `<div class="bill-row">
            <span class="bill-id">${buildBillId(b)}</span>
            <span class="bill-title">${truncate(b.title)}</span>
            ${url ? `<a class="bill-link" href="${url}" target="_blank">↗</a>` : ""}
          </div>`;
        }).join("")
      : `<div class="no-bills">No matching bills in 119th Congress.</div>`;

    card.innerHTML = `
      <div class="card-eyebrow">${eyebrow}</div>
      <div class="card-name">
        ${member.full_name || member.matched_as}
        <span class="party-pill ${partyClass}">${partyLabel}</span>
      </div>
      <div class="card-meta">119th Congress · ${member.bioguide_id || ""}</div>
      ${claimHtml}
      ${billsHtml}
    `;

    cardsContainer.appendChild(card);
  }
}

// ── Scan ──────────────────────────────────────────────────────────────────────
scanBtn.addEventListener("click", async () => {
  cardsContainer.innerHTML = "";
  setStatus("Scanning page…", "working");
  scanBtn.disabled = true;

  if (!getProxyUrl()) {
    setStatus("Proxy not configured. Check src/config.js.", "error");
    scanBtn.disabled = false;
    return;
  }

  const analyzeTimeoutMs = 45000;

  browser.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    browser.tabs.sendMessage(tab.id, { action: "scan" }, (scanResult) => {
      if (browser.runtime.lastError || !scanResult) {
        setStatus("Could not reach page. Try refreshing.", "error");
        scanBtn.disabled = false;
        return;
      }
      if (scanResult.error) {
        setStatus(scanResult.error, "error");
        scanBtn.disabled = false;
        return;
      }

      const { politicians, articleText } = scanResult;

      if (!articleText || articleText.trim().length < 200) {
        setStatus("Not enough article text to analyze.", "");
        scanBtn.disabled = false;
        return;
      }

      const hint = politicians.length
        ? `Found ${politicians.length} politician${politicians.length !== 1 ? "s" : ""}. Analyzing…`
        : "Analyzing with AI…";
      setStatus(hint, "working");

      browser.runtime.sendMessage(
        { action: "analyze", payload: { politicians: politicians || [], articleText } },
        () => {
          browser.tabs.sendMessage(tab.id, { action: "startResultsPoll" }, () => {});

          let elapsed = 0;
          const poll = setInterval(() => {
            elapsed += 500;

            browser.storage.session.get("ll_results", (data) => {
              const result = data.ll_results;
              if (!result || result.status === "working") return;

              clearInterval(poll);
              scanBtn.disabled = false;
              handleResult(result);
            });
          }, 500);

          // On timeout: do one final check before giving up
          setTimeout(() => {
            clearInterval(poll);
            browser.storage.session.get("ll_results", (data) => {
              scanBtn.disabled = false;
              const result = data.ll_results;
              if (result && result.status === "ok") {
                handleResult(result);
              } else if (result && result.status !== "working") {
                handleResult(result);
              } else {
                setStatus("Timed out. Try again.", "error");
              }
            });
          }, analyzeTimeoutMs);
        }
      );
    });
  });
});

function handleResult(result) {
  if (result.status === "error") {
    setStatus("Error: " + result.message, "error");
  } else if (result.status === "no_members") {
    setStatus(result.message || "No current Congress members found.", "");
  } else if (result.status === "no_topics") {
    setStatus("Members found but no policy topics detected.", "");
  } else if (result.status === "ok") {
    const count = result.records?.length || 0;
    setStatus(`✓ ${count} member${count !== 1 ? "s" : ""} · record retrieved`, "success");
    // Close popup after brief delay — results show in sidebar
    setTimeout(() => window.close(), 800);
  }
}

