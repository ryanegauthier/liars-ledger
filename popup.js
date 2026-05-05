// Worth Noting - popup.js

const browser = window.browser || window.chrome;
const toggle = document.getElementById("enableToggle");
const scanBtn = document.getElementById("scanBtn");
const statusEl = document.getElementById("status");

// Load saved toggle state
browser.storage.local.get("enabled", (data) => {
  toggle.checked = data.enabled !== false;
});

// Save toggle state on change
toggle.addEventListener("change", () => {
  browser.storage.local.set({ enabled: toggle.checked });
});

// Scan button
scanBtn.addEventListener("click", () => {
  statusEl.textContent = "Scanning...";
  scanBtn.disabled = true;

  browser.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    browser.tabs.sendMessage(tab.id, { action: "scan" }, (response) => {
      scanBtn.disabled = false;

      if (browser.runtime.lastError) {
        statusEl.textContent = "Error: could not reach page.";
        return;
      }

      if (response.error) {
        statusEl.textContent = response.error;
        return;
      }

      const count = response.politicians.length;
      if (count === 0) {
        statusEl.textContent = "No politicians detected.";
      } else {
        statusEl.textContent = `Found ${count} politician${count > 1 ? "s" : ""}. Check DevTools console for names.`;
      }
    });
  });
});
