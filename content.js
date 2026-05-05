// Worth Noting - content.js
// Runs on every page. Triggered by popup scan button.

const browser = window.browser || window.chrome;

// --- Article body detection ---
// Try selectors in priority order, fall back to body
function findArticleBody() {
  const selectors = [
    "article",
    "[role='main']",
    "main",
    ".article-body",
    ".article-content",
    ".story-body",
    ".post-content",
    ".entry-content",
    ".content-body",
    "#article-body",
    "#main-content",
    ".ArticleBody",              // Reuters
    ".article__body",            // The Guardian
    ".StoryBodyCompanionColumn", // NYT
    ".article-text",             // Fox News
    ".zn-body__paragraph",       // CNN
  ];

  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el && el.innerText.trim().length > 200) {
      console.log("[Worth Noting] article body found via selector:", selector);
      return el;
    }
  }

  console.warn("[Worth Noting] no article selector matched, falling back to document.body");
  return document.body;
}

// --- Politician name extraction ---
// Matches patterns like:
//   Sen. Warren / Senator Warren
//   Rep. Bush / Representative Bush
//   President Biden / Vice President Harris
//   Governor Newsom / Gov. Newsom
//   Mayor Adams
//   Secretary Blinken

const TITLE_PATTERN = /\b(?:President|Vice\s+President|Sen\.?|Senator|Rep\.?|Representative|Gov\.?|Governor|Mayor|Secretary|Sec\.?)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g;

function extractPoliticianNames(text) {
  const found = new Set();

  let match;
  while ((match = TITLE_PATTERN.exec(text)) !== null) {
    found.add(match[0].trim());
  }

  return [...found];
}

// --- Main scan function ---
function scanPage() {
  console.log("[Worth Noting] scan triggered");

  const articleEl = findArticleBody();
  const articleText = articleEl.innerText;

  if (articleText.length < 100) {
    console.warn("[Worth Noting] article text too short, may not be a news page");
    return { error: "No article content detected on this page." };
  }

  const politicians = extractPoliticianNames(articleText);

  if (politicians.length === 0) {
    console.log("[Worth Noting] no politician names found");
    return { politicians: [], text_length: articleText.length };
  }

  console.log("[Worth Noting] politicians found:", politicians);
  return { politicians, text_length: articleText.length };
}

// --- Message listener ---
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "scan") {
    const result = scanPage();
    sendResponse(result);
  }
  return true;
});

console.log("[Worth Noting] content script loaded on:", window.location.hostname);
