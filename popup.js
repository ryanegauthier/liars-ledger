// Worth Noting - popup.js

const browser = window.browser || window.chrome;
const toggle = document.getElementById("enableToggle");
const scanBtn = document.getElementById("scanBtn");
const statusEl = document.getElementById("status");

// Load saved toggle state
browser.storage.local.get("enabled", (data) => {
  toggle.checked = data.enabled !== false;
});

toggle.addEventListener("change", () => {
  browser.storage.local.set({ enabled: toggle.checked });
});

// Load API key from storage (set once by user)
async function getApiKey() {
  return CONFIG?.CONGRESS_API_KEY || null;
}

// Scan button
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
    // Step 1: scan the page for politicians + article text
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

      // Step 2: send to background for API lookup
      browser.runtime.sendMessage({
        action: "analyze",
        payload: { politicians, articleText, apiKey }
      }, (response) => {
        scanBtn.disabled = false;

        if (!response) {
          statusEl.textContent = "Error: no response from background worker.";
          return;
        }

        if (response.status === "error") {
          statusEl.textContent = "Error: " + response.message;
          return;
        }

        if (response.status === "no_members") {
          statusEl.textContent = "No current Congress members found.";
          return;
        }

        if (response.status === "no_topics") {
          statusEl.textContent = `Found members but no policy topics detected.`;
          return;
        }

        if (response.status === "ok") {
          const count = response.records.length;
          const topicList = response.topics.join(", ");
          statusEl.textContent = `✓ ${count} member${count > 1 ? "s" : ""} on: ${topicList}. Check console for records.`;
          console.log("[Worth Noting] results:", JSON.stringify(response, null, 2));
        }
      });
    });
  });
});
