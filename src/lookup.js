// Worth Noting - src/lookup.js
// Resolves politician names extracted from articles to dictionary entries.

let _dictionary = null;

// --- People who appear in news but aren't in Congress ---
// Presidents, former members, governors etc.
// These get a special "not a current member" response
const NON_MEMBER_TITLES = [
  /^president\s/i,
  /^vice\s+president\s/i,
  /^former\s/i,
  /^ex-/i,
  /^gov\.?\s/i,
  /^governor\s/i,
  /^mayor\s/i,
  /^secretary\s/i,
  /^sec\.?\s/i,
];

function isNonMemberTitle(name) {
  return NON_MEMBER_TITLES.some(pattern => pattern.test(name.trim()));
}

// --- Load dictionary from bundled JSON ---
async function loadDictionary() {
  if (_dictionary) return _dictionary;
  const url = browser.runtime.getURL("src/data/politicians.json");
  const res = await fetch(url);
  _dictionary = await res.json();
  console.log("[Worth Noting] dictionary loaded,", Object.keys(_dictionary).length, "keys");
  return _dictionary;
}

// --- Normalize a name for lookup ---
function normalizeKey(name) {
  return name.toLowerCase().trim();
}

// Strip title prefix for fallback lookup: "Sen. Warren" → "warren"
function stripTitle(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/^(rep\.?|sen\.?|senator|representative|president|vice\s+president|gov\.?|governor|mayor|secretary|sec\.?|democrat|republican|independent)\s+/i, "")
    .trim();
}

// --- Resolve a single name ---
async function resolvePolitician(rawName) {
  const dict = await loadDictionary();

  // Try exact normalized match
  const key = normalizeKey(rawName);
  if (dict[key]) return { status: "found", entry: dict[key] };

  // Try stripped title
  const stripped = stripTitle(rawName);
  if (dict[stripped]) return { status: "found", entry: dict[stripped] };

  // Check if it's a known non-member title (President, Governor, etc.)
  if (isNonMemberTitle(rawName)) {
    return { status: "not_member", name: rawName };
  }

  // Genuinely not found
  return { status: "not_found", name: rawName };
}

// --- Resolve a list of names ---
// Returns { resolved, notMembers, notFound }
async function resolveAll(names) {
  const resolved = [];
  const notMembers = [];
  const notFound = [];

  for (const name of names) {
    const result = await resolvePolitician(name);

    if (result.status === "found") {
      // Deduplicate by bioguide_id
      if (!resolved.find(r => r.bioguide_id === result.entry.bioguide_id)) {
        resolved.push({ matched_as: name, ...result.entry });
      }
    } else if (result.status === "not_member") {
      notMembers.push(name);
    } else {
      notFound.push(name);
    }
  }

  console.log("[Worth Noting] resolved:", resolved.map(r => r.full_name));
  if (notMembers.length) console.log("[Worth Noting] not current members:", notMembers);
  if (notFound.length) console.log("[Worth Noting] not found:", notFound);

  return { resolved, notMembers, notFound };
}
