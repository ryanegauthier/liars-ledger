// Liars Ledger - popup.js

const browser = window.browser || window.chrome;
const toggle = document.getElementById("enableToggle");
const scanBtn = document.getElementById("scanBtn");
const statusEl = document.getElementById("status");
const logPanel = document.getElementById("logPanel");
const copyBtn = document.getElementById("copyBtn");
const clearBtn = document.getElementById("clearBtn");

// --- Load saved toggle state ---
browser.storage.local.get("enabled", (data) => {
  toggle.checked = data.enabled !== false;
});

toggle.addEventListener("change", () => {
  browser.storage.local.set({ enabled: toggle.checked });
});

// --- API key ---
async function getApiKey() {
  return CONFIG?.CONGRESS_API_KEY || null;
}

// --- Log panel ---
async function refreshLog() {
  browser.storage.session.get("ll_debug_log", (result) => {
    const entries = result.ll_debug_log || [];
    if (entries.length === 0) {
      logPanel.innerHTML = "";
      return;
    }
    logPanel.innerHTML = entries.map(entry => {
      let cls = "";
      if (entry.includes("WARN") || entry.includes("not found") || entry.includes("not current")) cls = "log-entry-warn";
      if (entry.includes("ERROR") || entry.includes("failed") || entry.includes("error")) cls = "log-entry-error";
      return `<div class="${cls}">${entry}</div>`;
    }).join("");
    logPanel.scrollTop = logPanel.scrollHeight;
  });
}

// Refresh log every second while popup is open
refreshLog();
const logInterval = setInterval(refreshLog, 1000);
window.addEventListener("unload", () => clearInterval(logInterval));

// --- Copy log to clipboard ---
copyBtn.addEventListener("click", () => {
  browser.storage.session.get("ll_debug_log", (result) => {
    const entries = result.ll_debug_log || [];
    navigator.clipboard.writeText(entries.join("\n")).then(() => {
      copyBtn.textContent = "Copied!";
      setTimeout(() => copyBtn.textContent = "Copy", 1500);
    });
  });
});

// --- Clear log ---
clearBtn.addEventListener("click", () => {
  browser.storage.session.set({ ll_debug_log: [] }, refreshLog);
});

// --- Scan button ---
scanBtn.addEventListener("click", async () => {
  statusEl.textContent = "Scanning page...";
  scanBtn.disabled = true;

  const apiKey = await getApiKey();

  if (!apiKey) {
    statusEl.textContent = "No API key set. See README to configure.";
    scanBtn.disabled = false;
    return;
  }

  browser.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    browser.tabs.sendMessage(tab.id, { action: "scan" }, (scanResult) => {
      if (browser.runtime.lastError || !scanResult) {
        statusEl.textContent = "Error: could not reach page. Try refreshing.";
        scanBtn.disabled = false;
        return;
      }

      if (scanResult.error) {
        statusEl.textContent = scanResult.error;
        scanBtn.disabled = false;
        return;
      }

      const { politicians, articleText } = scanResult;

      if (politicians.length === 0) {
        statusEl.textContent = "No politicians detected in this article.";
        scanBtn.disabled = false;
        return;
      }

      statusEl.textContent = `Found ${politicians.length} politician${politicians.length > 1 ? "s" : ""}. Looking up records...`;

      browser.runtime.sendMessage({
        action: "analyze",
        payload: { politicians, articleText, apiKey }
      }, () => {
        // Poll session storage for results
        const poll = setInterval(() => {
          browser.storage.session.get("ll_results", (data) => {
            const result = data.ll_results;
            if (!result || result.status === "working") return;
      
            clearInterval(poll);
            scanBtn.disabled = false;
      
            if (result.status === "error") {
              statusEl.textContent = "Error: " + result.message;
              return;
            }
            if (result.status === "no_members") {
              statusEl.textContent = "No current Congress members found.";
              return;
            }
            if (result.status === "no_topics") {
              statusEl.textContent = "Members found but no policy topics detected.";
              return;
            }
            if (result.status === "ok") {
              const count = result.records.length;
              const topicList = result.topics.join(", ");
              statusEl.textContent = `✓ ${count} member${count > 1 ? "s" : ""} on: ${topicList}`;
              console.log("[Liars Ledger] full results:", JSON.stringify(result, null, 2));
            }
          });
        }, 500); // check every 500ms
      
        // Timeout after 30 seconds
        setTimeout(() => {
          clearInterval(poll);
          scanBtn.disabled = false;
          statusEl.textContent = "Timed out. Try again.";
        }, 30000);
      });
    });
  });
});
