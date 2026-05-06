// Worth Noting - content.js
// Runs on every page. Triggered by popup scan button.

const browser = window.browser || window.chrome;

// --- Article body detection ---
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
    ".ArticleBody",
    ".article__body",
    ".StoryBodyCompanionColumn",
    ".article-text",
    ".zn-body__paragraph",
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
const TITLE_PATTERN = /\b(?:President|Vice\s+President|Sen\.?|Senator|Rep\.?|Representative|Gov\.?|Governor|Mayor|Secretary|Sec\.?)\s+([A-Z][a-z]+(?:[-'\s][A-Z][a-z]+)?)/g;

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
    return { error: "No article content detected on this page." };
  }

  const politicians = extractPoliticianNames(articleText);
  console.log("[Worth Noting] politicians found:", politicians);

  return {
    politicians,
    articleText: articleText.slice(0, 5000), // cap at 5k chars for message size
    text_length: articleText.length
  };
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
