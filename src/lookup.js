// Liars Ledger - src/lookup.js
// Resolves politician names extracted from articles to dictionary entries.
// Works with the condensed dictionary format:
//   { members: { bioguide_id: {...} }, aliases: { name: bioguide_id } }

let _dictionary = null;

// --- People who appear in news but aren't in Congress ---
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

// --- Nickname → official first name map ---
const NICKNAME_FIRST = {
  "chuck":    "charles",
  "dick":     "richard",
  "tim":      "timothy",
  "tom":      "thomas",
  "ted":      "rafael",
  "mike":     "michael",
  "bob":      "robert",
  "bill":     "william",
  "jim":      "james",
  "joe":      "joseph",
  "ben":      "benjamin",
  "pat":      "patrick",
  "rick":     "richard",
  "rob":      "robert",
  "jon":      "jonathan",
  "chris":    "christopher",
  "dan":      "daniel",
  "dave":     "david",
  "ed":       "edward",
  "jack":     "john",
  "jeff":     "jeffrey",
  "jerry":    "gerald",
  "liz":      "elizabeth",
  "beth":     "elizabeth",
  "alex":     "alexander",
  "al":       "alan",
  "pete":     "peter",
  "maggie":   "margaret",
  "marcy":    "marcia",
  "max":      "maximilian",
  "cathy":    "cathleen",
  "kay":      "kathleen",
  "suzan":    "suzanne",
  "cheri":    "cheryl",
  "mitch":    "addison",
  "rand":     "randal",
  "marco":    "marco",
  "bernie":   "bernard",
  "amy":      "amy",
  "tammy":    "tamara",
  "sherrod":  "sherrod",
  "tina":     "christina",
  "gary":     "garland",
  "ron":      "ronald",
  "roger":    "roger",
  "thom":     "thomas",
  "shelley":  "shelley",
  "mazie":    "mazie",
  "angus":    "angus",
  "mark":     "mark",
  "john":     "john",
};

// Full name overrides
const FULL_NAME_OVERRIDES = {
  "chuck schumer":        "charles schumer",
  "mitch mcconnell":      "addison mcconnell",
  "ted cruz":             "rafael cruz",
  "rand paul":            "randal paul",
  "bernie sanders":       "bernard sanders",
  "dick durbin":          "richard durbin",
  "tim scott":            "timothy scott",
  "tom cotton":           "thomas cotton",
  "bill cassidy":         "william cassidy",
  "bill hagerty":         "william hagerty",
  "mike lee":             "michael lee",
  "mike crapo":           "michael crapo",
  "mike rounds":          "michael rounds",
  "mike braun":           "michael braun",
  "bob menendez":         "robert menendez",
  "rob portman":          "robert portman",
  "pat leahy":            "patrick leahy",
  "jack reed":            "john reed",
  "jeff merkley":         "jeffrey merkley",
  "jerry nadler":         "jerrold nadler",
  "liz cheney":           "elizabeth cheney",
  "pete sessions":        "peter sessions",
  "maggie hassan":        "margaret hassan",
  "tina smith":           "christina smith",
  "thom tillis":          "thomas tillis",
  "tammy baldwin":        "tamara baldwin",
  "tammy duckworth":      "tamara duckworth",
  "ron wyden":            "ronald wyden",
  "ron johnson":          "ronald johnson",
  "ed markey":            "edward markey",
  "chris murphy":         "christopher murphy",
  "chris coons":          "christopher coons",
  "chris van hollen":     "christopher van hollen",
  "dan sullivan":         "daniel sullivan",
  "joe manchin":          "joseph manchin",
  "ben cardin":           "benjamin cardin",
  "rick scott":           "richard scott",
  "jim jordan":           "james jordan",
  "jim risch":            "james risch",
  "dave mccormick":       "david mccormick",
  "jerry connolly":       "gerald connolly",
  "jim clyburn":          "james clyburn",
  "jim mcgovern":         "james mcgovern",
  "jim himes":            "james himes",
  "marcy kaptur":         "marcia kaptur",
  "cathy mcmorris rodgers": "cathleen mcmorris rodgers",
};

// --- Load dictionary ---
async function loadDictionary() {
  if (_dictionary) return _dictionary;
  const url = browser.runtime.getURL("src/data/politicians.json");
  const res = await fetch(url);
  _dictionary = await res.json();
  const memberCount = Object.keys(_dictionary.members || {}).length;
  const aliasCount = Object.keys(_dictionary.aliases || {}).length;
  console.log(`[Liars Ledger] dictionary loaded, ${memberCount} members, ${aliasCount} aliases`);
  return _dictionary;
}

// --- Lookup helper: alias → member object ---
function lookupAlias(dict, alias) {
  const bioguide = dict.aliases[alias];
  if (!bioguide) return null;
  const member = dict.members[bioguide];
  if (!member) return null;
  return { ...member, bioguide_id: bioguide };
}

// --- Normalize ---
function normalizeKey(name) {
  return name.toLowerCase().trim();
}

function stripTitle(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/^(rep\.?|sen\.?|senator|representative|president|vice\s+president|gov\.?|governor|mayor|secretary|sec\.?|democrat|republican|independent)\s+/i, "")
    .trim();
}

function applyNicknames(stripped) {
  if (FULL_NAME_OVERRIDES[stripped]) return FULL_NAME_OVERRIDES[stripped];

  const parts = stripped.split(/\s+/);
  if (parts.length >= 2) {
    const first = parts[0];
    const rest  = parts.slice(1).join(" ");
    if (NICKNAME_FIRST[first]) {
      return `${NICKNAME_FIRST[first]} ${rest}`;
    }
  }

  return null;
}

// --- Resolve a single name ---
async function resolvePolitician(rawName) {
  const dict = await loadDictionary();

  // 1. Exact normalized match
  const key = normalizeKey(rawName);
  const m1 = lookupAlias(dict, key);
  if (m1) return { status: m1.is_current ? "found" : "former", entry: m1 };

  // 2. Strip title, try again
  const stripped = stripTitle(rawName);
  const m2 = lookupAlias(dict, stripped);
  if (m2) return { status: m2.is_current ? "found" : "former", entry: m2 };

  // 3. Nickname substitution on stripped name
  const nicknamedStripped = applyNicknames(stripped);
  if (nicknamedStripped) {
    const m3 = lookupAlias(dict, nicknamedStripped);
    if (m3) return { status: m3.is_current ? "found" : "former", entry: m3 };
  }

  // 4. Nickname substitution on raw key
  const nicknamedKey = applyNicknames(key);
  if (nicknamedKey) {
    const m4 = lookupAlias(dict, nicknamedKey);
    if (m4) return { status: m4.is_current ? "found" : "former", entry: m4 };
  }

  // 5. Last-name-only fallback
  const parts = stripped.split(/\s+/);
  if (parts.length > 1) {
    const lastNameOnly = parts[parts.length - 1];
    const m5 = lookupAlias(dict, lastNameOnly);
    if (m5) return { status: m5.is_current ? "found" : "former", entry: m5 };
  }

  // 6. Known non-member title
  if (isNonMemberTitle(rawName)) {
    return { status: "not_member", name: rawName };
  }

  // 7. Not found
  return { status: "not_found", name: rawName };
}

// --- Resolve a list ---
async function resolveAll(names) {
  const resolved      = [];
  const formerMembers = [];
  const notMembers    = [];
  const notFound      = [];

  for (const name of names) {
    const result = await resolvePolitician(name);

    if (result.status === "found") {
      if (!resolved.find(r => r.bioguide_id === result.entry.bioguide_id)) {
        resolved.push({ matched_as: name, ...result.entry });
      }
    } else if (result.status === "former") {
      if (!formerMembers.find(r => r.bioguide_id === result.entry.bioguide_id)) {
        formerMembers.push({ matched_as: name, ...result.entry });
      }
    } else if (result.status === "not_member") {
      notMembers.push(name);
    } else {
      notFound.push(name);
    }
  }

  console.log("[Liars Ledger] resolved:", resolved.map(r => r.full_name));
  if (formerMembers.length) console.log("[Liars Ledger] former members:", formerMembers.map(r => r.full_name));
  if (notMembers.length) console.log("[Liars Ledger] not current members:", notMembers);
  if (notFound.length)   console.log("[Liars Ledger] not found:", notFound);

  return { resolved, formerMembers, notMembers, notFound };
}
