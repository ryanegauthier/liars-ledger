// VoteCheck - popup.js
const browser = window.browser || window.chrome;
const toggle = document.getElementById("enableToggle");

// Load saved state
browser.storage.local.get("enabled", (data) => {
  toggle.checked = data.enabled !== false; // default ON
});

// Save on change
toggle.addEventListener("change", () => {
  browser.storage.local.set({ enabled: toggle.checked });
});
