// Worth Noting - content.js
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
  console.log("[Worth Noting]", message);
  try {
    const result = await browser.storage.session.get("wn_debug_log");
    const entries = result.wn_debug_log || [];
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    entries.push(`[${ts}] content: ${message}`);
    if (entries.length > 200) entries.splice(0, entries.length - 200);
    await browser.storage.session.set({ wn_debug_log: entries });
  } catch (e) {}
}

// --- Sidebar ---
function initSidebar() {
  if (document.getElementById("wn-bar")) return;

  const style = document.createElement("style");
  style.textContent = [
    "#wn-bar { position:fixed; bottom:0; left:0; right:0; z-index:2147483647;",
    "  background:#0f1117; border-top:2px solid #c8a96e;",
    "  font-family:Georgia,serif; font-size:13px; color:#e8e4d9;",
    "  box-shadow:0 -4px 24px rgba(0,0,0,0.5);",
    "  transform:translateY(100%); transition:transform 0.35s cubic-bezier(0.16,1,0.3,1); }",
    "#wn-bar.wn-visible { transform:translateY(0); }",
    "#wn-header { display:flex; align-items:center; padding:8px 16px; gap:12px; border-bottom:1px solid #2a2d35; }",
    "#wn-logo { font-size:13px; color:#c8a96e; letter-spacing:0.08em; white-space:nowrap; }",
    "#wn-topics { font-size:11px; color:#5a5855; flex:1; }",
    "#wn-topics span { color:#8a8680; margin-right:8px; }",
    "#wn-close { background:none; border:none; color:#5a5855; cursor:pointer; font-size:20px; line-height:1; padding:2px 6px; transition:color 0.15s; }",
    "#wn-close:hover { color:#c8a96e; }",
    "#wn-cards { display:flex; overflow-x:auto; scrollbar-width:thin; scrollbar-color:#2a2d35 transparent; }",
    ".wn-card { min-width:220px; max-width:280px; padding:12px 16px; border-right:1px solid #1a1d25; cursor:pointer; transition:background 0.15s; flex-shrink:0; }",
    ".wn-card:hover { background:#161920; }",
    ".wn-card.wn-active { background:#161920; border-top:2px solid #c8a96e; }",
    ".wn-card-name { font-size:14px; color:#e8e4d9; margin-bottom:2px; }",
    ".wn-card-meta { font-size:11px; color:#5a5855; margin-bottom:8px; }",
    ".wn-party-D { color:#5a8ac8; } .wn-party-R { color:#c85a5a; } .wn-party-I { color:#8a8680; }",
    ".wn-indicators { display:flex; gap:6px; flex-wrap:wrap; }",
    ".wn-indicator { font-size:11px; padding:2px 8px; border-radius:2px; white-space:nowrap; }",
    ".wn-indicator-green { background:#1e3a2f; color:#4caf82; border:1px solid #2a5a3f; }",
    ".wn-indicator-gray  { background:#1a1d25; color:#5a5855; border:1px solid #2a2d35; }",
    ".wn-card-claim { font-size:11px; color:#8a8680; line-height:1.35; margin-top:6px; font-style:italic; }",
    ".wn-not-found-card { min-width:160px; padding:12px 16px; border-right:1px solid #1a1d25; flex-shrink:0; opacity:0.4; }",
    ".wn-not-found-name { font-size:12px; color:#8a8680; margin-bottom:2px; }",
    ".wn-not-found-reason { font-size:10px; color:#3a3835; font-style:italic; }",
    "#wn-detail { border-top:1px solid #2a2d35; padding:12px 16px; max-height:160px; overflow-y:auto; display:none; scrollbar-width:thin; scrollbar-color:#2a2d35 transparent; }",
    "#wn-detail.wn-visible { display:block; }",
    ".wn-detail-title { font-size:12px; color:#c8a96e; margin-bottom:8px; }",
    ".wn-detail-claim { font-size:12px; color:#a8a49a; line-height:1.4; margin-bottom:10px; padding-bottom:8px; border-bottom:1px solid #1a1d25; }",
    ".wn-bill { padding:6px 0; border-bottom:1px solid #1a1d25; display:flex; gap:10px; align-items:flex-start; }",
    ".wn-bill:last-child { border-bottom:none; }",
    ".wn-bill-type { font-size:10px; color:#5a5855; white-space:nowrap; min-width:70px; padding-top:2px; }",
    ".wn-bill-title { font-size:12px; color:#e8e4d9; line-height:1.4; margin-bottom:2px; }",
    ".wn-bill-date { font-size:10px; color:#5a5855; }",
    ".wn-bill-link { font-size:10px; color:#c8a96e; text-decoration:none; }",
    ".wn-bill-link:hover { text-decoration:underline; }",
    ".wn-empty { font-size:12px; color:#5a5855; font-style:italic; padding:8px 0; }"
  ].join("\n");
  document.head.appendChild(style);

  const bar = document.createElement("div");
  bar.id = "wn-bar";
  bar.innerHTML =
    '<div id="wn-header">' +
      '<div id="wn-logo">Worth Noting</div>' +
      '<div id="wn-topics"></div>' +
      '<button id="wn-close" title="Close">\u00d7</button>' +
    '</div>' +
    '<div id="wn-cards"></div>' +
    '<div id="wn-detail"></div>';
  document.body.appendChild(bar);

  document.getElementById("wn-close").addEventListener("click", function() {
    bar.classList.remove("wn-visible");
    setTimeout(function() { bar.remove(); }, 400);
  });
}

function renderSidebar(results) {
  initSidebar();

  var topicsEl = document.getElementById("wn-topics");
  var cardsEl  = document.getElementById("wn-cards");
  var detailEl = document.getElementById("wn-detail");
  var bar      = document.getElementById("wn-bar");

  topicsEl.innerHTML = results.topics.map(function(t) {
    return "<span>" + escapeHtml(t) + "</span>";
  }).join("");

  var cardsHTML = "";

  (results.records || []).forEach(function(record, idx) {
    var p = record.politician;
    var sponsored   = record.sponsored   || [];
    var cosponsored = record.cosponsored || [];
    var total = sponsored.length + cosponsored.length;
    var partyCode = p.party === "Democratic" ? "D" : p.party === "Republican" ? "R" : "I";
    var indicator = total > 0
      ? '<span class="wn-indicator wn-indicator-green">&#x1F7E2; ' + total + ' bill' + (total > 1 ? "s" : "") + " found</span>"
      : '<span class="wn-indicator wn-indicator-gray">&#x26AA; No bills found</span>';

    var claimLine = record.claim
      ? '<div class="wn-card-claim">' + escapeHtml(record.claim) + "</div>"
      : "";

    cardsHTML +=
      '<div class="wn-card" data-idx="' + idx + '">' +
        '<div class="wn-card-name">' + p.display + "</div>" +
        '<div class="wn-card-meta"><span class="wn-party-' + partyCode + '">' + partyCode + "</span> &middot; " + p.state + " &middot; " + p.chamber + "</div>" +
        '<div class="wn-indicators">' + indicator + "</div>" +
        claimLine +
      "</div>";
  });

  (results.notFound || []).forEach(function(name) {
    cardsHTML +=
      '<div class="wn-not-found-card">' +
        '<div class="wn-not-found-name">' + name + "</div>" +
        '<div class="wn-not-found-reason">Not in current Congress</div>' +
      "</div>";
  });

  (results.notMembers || []).forEach(function(name) {
    cardsHTML +=
      '<div class="wn-not-found-card">' +
        '<div class="wn-not-found-name">' + name + "</div>" +
        '<div class="wn-not-found-reason">Not a member of Congress</div>' +
      "</div>";
  });

  cardsEl.innerHTML = cardsHTML;

  cardsEl.querySelectorAll(".wn-card").forEach(function(card) {
    card.addEventListener("click", function() {
      var idx    = parseInt(card.dataset.idx);
      var record = results.records[idx];
      var wasActive = card.classList.contains("wn-active");

      cardsEl.querySelectorAll(".wn-card").forEach(function(c) {
        c.classList.remove("wn-active");
      });

      if (wasActive) {
        detailEl.classList.remove("wn-visible");
        return;
      }

      card.classList.add("wn-active");

      var p = record.politician;
      var allBills = []
        .concat((record.sponsored   || []).map(function(b) { return Object.assign({}, b, { role: "Sponsored"   }); }))
        .concat((record.cosponsored || []).map(function(b) { return Object.assign({}, b, { role: "Cosponsored" }); }));

      var html = '<div class="wn-detail-title">' + escapeHtml(p.full_name) + " &mdash; " + record.topics.map(escapeHtml).join(", ") + "</div>";

      if (record.claim) {
        html += '<div class="wn-detail-claim">' + escapeHtml(record.claim) + "</div>";
      }

      if (allBills.length === 0) {
        html += '<div class="wn-empty">No sponsored or cosponsored bills found on these topics in the 119th Congress.</div>';
      } else {
        allBills.forEach(function(bill) {
          var congress = bill.congress || 119;
          var type = (bill.type || "").toLowerCase();
          var number = bill.number || "";
          var typeMap = {
            s: "senate-bill",
            hr: "house-bill",
            sjres: "senate-joint-resolution",
            hjres: "house-joint-resolution",
            sres: "senate-resolution",
            hres: "house-simple-resolution",
            sconres: "senate-concurrent-resolution",
            hconres: "house-concurrent-resolution"
          };
          var typeName = typeMap[type] || type;
          var url = "https://www.congress.gov/bill/" + congress + "th-congress/" + typeName + "/" + number;
            html +=
            '<div class="wn-bill">' +
              '<div class="wn-bill-type">' + bill.role + "<br>" + (bill.type || "") + " " + (bill.number || "") + "</div>" +
              "<div>" +
                '<div class="wn-bill-title">' + escapeHtml(bill.title || "Untitled") + "</div>" +
                '<div class="wn-bill-date">' + (bill.introducedDate || "") +
                  ' &middot; <a class="wn-bill-link" href="' + url + '" target="_blank">View &rarr;</a>' +
                "</div>" +
              "</div>" +
            "</div>";
        });
      }

      detailEl.innerHTML = html;
      detailEl.classList.add("wn-visible");
    });
  });

  requestAnimationFrame(function() { bar.classList.add("wn-visible"); });
}

// --- Article detection ---
function findArticleBody() {
  var selectors = [
    "article", "[role='main']", "main",
    ".article-body", ".article-content", ".story-body",
    ".post-content", ".entry-content", ".content-body",
    "#article-body", "#main-content",
    ".ArticleBody", ".article__body",
    ".StoryBodyCompanionColumn", ".article-text", ".zn-body__paragraph"
  ];
  for (var i = 0; i < selectors.length; i++) {
    var el = document.querySelector(selectors[i]);
    if (el && el.innerText.trim().length > 200) {
      return { el: el, selector: selectors[i] };
    }
  }
  return { el: document.body, selector: "document.body (fallback)" };
}

// --- Name extraction ---
var TITLE_PATTERN = /\b(?:President|Vice\s+President|Sen\.?|Senator|Rep\.?|Representative|Gov\.?|Governor|Mayor|Secretary|Sec\.?|Democrat|Republican|Independent)\s+([A-Z][a-z]+(?:[-'\s][A-Z][a-z]+)?)/g;
function extractPoliticianNames(text) {
  var found = new Set();
  var match;
  TITLE_PATTERN.lastIndex = 0;
  while ((match = TITLE_PATTERN.exec(text)) !== null) {
    found.add(match[0].trim());
  }
  return Array.from(found);
}

// --- Scan ---
async function scanPage() {
  await clog("scan triggered on " + window.location.hostname);
  var found = findArticleBody();
  await clog("article body found via: " + found.selector);
  var articleText = found.el.innerText;
  if (articleText.length < 100) {
    await clog("article text too short");
    return { error: "No article content detected on this page." };
  }
  await clog("article text length: " + articleText.length + " chars");
  var politicians = extractPoliticianNames(articleText);
  await clog("politicians found: " + (politicians.length > 0 ? politicians.join(", ") : "none"));
  return {
    politicians: politicians,
    articleText: articleText.slice(0, 5000),
    text_length: articleText.length
  };
}

// --- Poll for results ---
function startPolling() {
  console.log("[Worth Noting] poll started");
  var poll = setInterval(function() {
    console.log("[Worth Noting] polling...");
    browser.runtime.sendMessage({ action: "getResults" }, function(response) {
      if (browser.runtime.lastError) return;
      if (!response || response.status === "working") return;
      clearInterval(poll);
      if (response.status === "ok") {
        renderSidebar(response);
      }
    });
  }, 500);
  setTimeout(function() { clearInterval(poll); }, 30000);
}

// --- Message listener ---
browser.runtime.onMessage.addListener(function(message, sender, sendResponse) {
  if (message.action === "scan") {
    browser.storage.session.set({ wn_results: { status: "working" } });
    scanPage().then(function(result) {
      sendResponse(result);
      if (result.politicians && result.politicians.length > 0) {
        console.log("[Worth Noting] starting poll...");  // ← add this
        startPolling();
      }
    });
  }
  return true;
});

clog("content script loaded");
