// Liar's Ledger - popup.js v0.17.0

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

// ── Check for existing results on popup open ──────────────────────────────────
// Previously this auto-closed the popup after restoring results to the
// sidebar, with no way to trigger a fresh scan of the same page short of
// closing/reopening the tab or browser. Now it keeps the popup open and
// relabels the scan button to "Rescan This Page" — a deliberate action,
// since a rescan costs a real scan from the daily pool, same as any scan.
browser.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!tab) return;
  browser.storage.session.get(["ll_results", "ll_results_url"], (data) => {
    if (data.ll_results?.status === "ok" && data.ll_results_url === tab.url) {
      browser.tabs.sendMessage(tab.id, { action: "showResults" }, () => {
        if (browser.runtime.lastError) return;
      });
      const count = data.ll_results.records?.length || 0;
      setStatus(`Showing cached results (${count} member${count !== 1 ? "s" : ""}). Rescan for an update.`, "");
      scanBtn.textContent = "Rescan This Page";
    }
  });
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
  return "-";
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
    const partyLabel = party === "D" ? "DEM" : party === "R" ? "REP" : party || "-";

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
      // Save URL so results are tab-specific
      browser.storage.session.set({ ll_results_url: tab.url });
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
  // Refresh scan count display — background.js's syncTier() call after
  // /api/scan/start means storage.sync should already reflect the new
  // count by now, regardless of which branch below fires.
  loadScanInfo();

  if (result.status === "error") {
    setStatus("Error: " + result.message, "error");
  } else if (result.status === "no_members") {
    setStatus(result.message || "No current Congress members found.", "");
  } else if (result.status === "no_topics") {
    setStatus("Members found but no policy topics detected.", "");
  } else if (result.status === "rate_limited") {
    setStatus("Daily scan limit reached.", "error");
    const upgradeUrl = result.upgrade_url || "https://liarsledger.com/pricing";
    cardsContainer.innerHTML = `
      <div class="upgrade-prompt">
        <div class="upgrade-heading">Upgrade to Pro</div>
        <div class="upgrade-body">All accounts share a daily scan pool. Pro unlocks AI summaries, claim verdicts, and full VoteSmart data.</div>
        <a class="upgrade-btn" id="upgradeBtn" href="${upgradeUrl}" target="_blank">View Pricing →</a>
      </div>`;
    // Append the install token as a query param so /pricing can pre-fill
    // and auto-redirect to Square without the user copy/pasting anything —
    // same mechanism as the Account panel's pricing link (see below).
    // Done after the innerHTML write (rather than templated into it above)
    // because the token read from chrome.storage.sync is async.
    browser.storage.sync.get("ll_auth_token", (data) => {
      const id = data.ll_auth_token?.tokenId;
      const btn = document.getElementById("upgradeBtn");
      if (id && btn) {
        btn.href = `${upgradeUrl}?token=${encodeURIComponent(id)}`;
      }
    });
  } else if (result.status === "ok") {
    const count = result.records?.length || 0;
    setStatus(`✓ ${count} member${count !== 1 ? "s" : ""} · record retrieved`, "success");
    // Close popup after brief delay - results show in sidebar
    setTimeout(() => window.close(), 800);
  }
}

// ── Tier / scan count display ─────────────────────────────────────────────────
function loadScanInfo() {
  const scanInfoEl = document.getElementById("scanInfo");
  if (!scanInfoEl) return;
  browser.storage.sync.get("ll_auth_token", (data) => {
    const token = data.ll_auth_token;
    if (!token) return;
    const used = token.scansToday ?? 0;
    const limit = token.limit ?? 30;
    const remaining = token.remaining ?? (limit - used);
    const tierLabel = token.tier === "pro" ? "Pro" : "Free";

    // token.downgradeReason is expected to be copied through from
    // /api/scan-status's response by src/token.js's syncTier() — same
    // pattern as tier/scansToday/limit/remaining above. If syncTier()
    // doesn't yet pass this field through into chrome.storage.sync,
    // this will just silently be undefined and fall through to the
    // normal label below — nothing breaks, but the explanation won't
    // show until that wiring is confirmed/added on the syncTier() side.
    if (token.tier === "free" && token.downgradeReason === "payment_failed") {
      scanInfoEl.textContent = "Pro paused — your card was declined. Update it in Square to resume.";
      scanInfoEl.className = "scan-info exhausted"; // reuses the existing alert-red state, no new CSS needed
      return;
    }

    scanInfoEl.textContent = `${tierLabel} · ${remaining} scan${remaining !== 1 ? "s" : ""} remaining today`;
    scanInfoEl.className = "scan-info" + (token.tier === "pro" ? " pro" : "") + (remaining === 0 ? " exhausted" : remaining <= 1 ? " low" : "");
  });
}

loadScanInfo();

// ── Account panel: token display, copy, restore ───────────────────────────────

const accountToggle = document.getElementById("accountToggle");
const accountPanel  = document.getElementById("accountPanel");
const tokenDisplay  = document.getElementById("tokenDisplay");
const copyTokenBtn  = document.getElementById("copyTokenBtn");
const upgradeProBtn = document.getElementById("upgradeProBtn");
const upgradeProMsg = document.getElementById("upgradeProMsg");
const restoreInput  = document.getElementById("restoreInput");
const restoreBtn    = document.getElementById("restoreBtn");
const restoreStatus = document.getElementById("restoreStatus");

// Toggle panel open/closed
accountToggle?.addEventListener("click", () => {
  const isOpen = accountPanel.classList.toggle("open");
  accountToggle.classList.toggle("open", isOpen);
  accountToggle.setAttribute("aria-expanded", String(isOpen));
});

// Populate token display and set pricing link hash when panel is visible
browser.storage.sync.get("ll_auth_token", (data) => {
  const token = data.ll_auth_token;
  if (!token?.tokenId) return;

  // Show truncated token in the panel
  const id = token.tokenId;
  if (tokenDisplay) tokenDisplay.textContent = `${id.slice(0, 8)}…${id.slice(-8)}`;
  if (tokenDisplay) tokenDisplay.title = id; // full value on hover


});

// Copy token to clipboard
copyTokenBtn?.addEventListener("click", () => {
  browser.storage.sync.get("ll_auth_token", (data) => {
    const id = data.ll_auth_token?.tokenId;
    if (!id) return;
    navigator.clipboard.writeText(id).then(() => {
      copyTokenBtn.textContent = "Copied!";
      copyTokenBtn.classList.add("copied");
      setTimeout(() => {
        copyTokenBtn.textContent = "Copy";
        copyTokenBtn.classList.remove("copied");
      }, 1800);
    }).catch(() => {
      // Clipboard API may fail without focus; fall back to selection
      if (tokenDisplay) {
        tokenDisplay.textContent = id;
        const range = document.createRange();
        range.selectNode(tokenDisplay);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
      }
    });
  });
});

// Upgrade to Pro: POSTs token directly to /pricing/checkout, opens Square URL
upgradeProBtn?.addEventListener("click", () => {
  browser.storage.sync.get("ll_auth_token", async (stored) => {
    const tokenId = stored.ll_auth_token?.tokenId;
    if (!tokenId) return;

    const proxyUrl = (typeof CONFIG !== "undefined" && CONFIG.PROXY_URL)
      || "https://api.liarsledger.com";

    upgradeProBtn.disabled = true;
    upgradeProBtn.textContent = "Creating checkout…";
    if (upgradeProMsg) { upgradeProMsg.textContent = ""; upgradeProMsg.className = "upgrade-pro-msg"; }

    try {
      const res  = await fetch(`${proxyUrl}/pricing/checkout`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ token: tokenId }),
      });
      const data = await res.json();

      if (res.status === 409) {
        if (upgradeProMsg) { upgradeProMsg.textContent = "This token already has Pro access."; upgradeProMsg.className = "upgrade-pro-msg ok"; }
        upgradeProBtn.disabled    = false;
        upgradeProBtn.textContent = "Subscribe to Pro";
        return;
      }

      if (!res.ok || !data.url) {
        if (upgradeProMsg) { upgradeProMsg.textContent = data.error || "Something went wrong. Try again."; upgradeProMsg.className = "upgrade-pro-msg error"; }
        upgradeProBtn.disabled    = false;
        upgradeProBtn.textContent = "Subscribe to Pro";
        return;
      }

      browser.tabs.create({ url: data.url });
    } catch (_) {
      if (upgradeProMsg) { upgradeProMsg.textContent = "Network error. Check your connection."; upgradeProMsg.className = "upgrade-pro-msg error"; }
      upgradeProBtn.disabled    = false;
      upgradeProBtn.textContent = "Subscribe to Pro";
    }
  });
});

// Restore Pro access: takes Square order reference from receipt, calls
// /restore-token which returns the anonymous token linked to that order.
restoreBtn?.addEventListener("click", () => {
  const orderReference = restoreInput.value.trim();
  if (!orderReference) {
    restoreStatus.textContent = "Paste your Square order number from your receipt email first.";
    restoreStatus.className = "restore-status error";
    return;
  }
  if (orderReference.length < 8) {
    restoreStatus.textContent = "Order reference looks too short — check and try again.";
    restoreStatus.className = "restore-status error";
    return;
  }

  restoreBtn.disabled = true;
  restoreStatus.textContent = "Looking up your order…";
  restoreStatus.className = "restore-status";

  const proxyUrl = (typeof CONFIG !== "undefined" && CONFIG.PROXY_URL)
    || "https://api.liarsledger.com";

  fetch(`${proxyUrl}/restore-token`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ orderReference }),
  })
    .then(async r => {
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `Server returned ${r.status}`);

      const restoredTokenId = data.token;
      if (!restoredTokenId) throw new Error("No token in response");

      // Validate the restored token against scan-status to get current tier/limits
      const statusRes = await fetch(`${proxyUrl}/api/scan-status`, {
        headers: { "Authorization": `Bearer ${restoredTokenId}` },
      });
      const status = statusRes.ok ? await statusRes.json() : {};

      // Swap the stored token in chrome.storage.sync
      browser.storage.sync.get("ll_auth_token", (stored) => {
        const current = stored.ll_auth_token || {};
        const updated = {
          ...current,
          tokenId:    restoredTokenId,
          tier:       status.tier       ?? "pro",
          scansToday: status.scansToday ?? 0,
          limit:      status.limit      ?? 30,
          remaining:  status.remaining  ?? 30,
        };
        browser.storage.sync.set({ ll_auth_token: updated }, () => {
          restoreStatus.textContent = `✓ Pro access restored. Your token has been updated.`;
          restoreStatus.className = "restore-status ok";
          loadScanInfo();
          // Refresh token display
          if (tokenDisplay) {
            tokenDisplay.textContent = `${restoredTokenId.slice(0, 8)}…${restoredTokenId.slice(-8)}`;
            tokenDisplay.title = restoredTokenId;
          }

          restoreInput.value = "";
        });
      });
    })
    .catch(err => {
      restoreStatus.textContent = err.message || "Failed to restore. Check the order number and try again.";
      restoreStatus.className = "restore-status error";
    })
    .finally(() => { restoreBtn.disabled = false; });
});