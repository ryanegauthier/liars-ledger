// Liars Ledger - src/lookup.js
// Resolves politician names extracted from articles to dictionary entries.

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
// Keys are common nicknames/informal names; values are the official first name
// as it appears in the Congress.gov API (and therefore the dictionary).
// All lowercase. Add entries as LLM extraction surfaces new misses.
const NICKNAME_FIRST = {
  // Senate
  "chuck":    "charles",   // Chuck Schumer → Charles Schumer
  "dick":     "richard",   // Dick Durbin → Richard Durbin
  "tim":      "timothy",   // Tim Scott, Tim Kaine
  "tom":      "thomas",    // Tom Cotton, Tom Carper
  "ted":      "rafael",    // Ted Cruz (official: Rafael)
  "mike":     "michael",   // Mike Lee, Mike Crapo, Mike Rounds
  "bob":      "robert",    // Bob Casey, Bob Menendez
  "bill":     "william",   // Bill Cassidy, Bill Hagerty
  "jim":      "james",     // Jim Jordan, Jim Risch
  "joe":      "joseph",    // Joe Manchin, Joe Morelle
  "ben":      "benjamin",  // Ben Cardin, Ben Ray Luján
  "pat":      "patrick",   // Pat Leahy, Pat Toomey
  "rick":     "richard",   // Rick Scott (also richard)
  "rob":      "robert",    // Rob Portman, Rob Wittman
  "jon":      "jonathan",  // Jon Ossoff
  "chris":    "christopher", // Chris Murphy, Chris Coons, Chris Van Hollen
  "dan":      "daniel",    // Dan Sullivan, Dan Goldman
  "dave":     "david",     // Dave McCormick, Dave Joyce
  "ed":       "edward",    // Ed Markey
  "jack":     "john",      // Jack Reed (official: John)
  "jeff":     "jeffrey",   // Jeff Merkley (official: Jeffrey)
  "jerry":    "gerald",    // Jerry Nadler (official: Jerrold/Gerald)
  "john":     "jonathan",  // fallback — most Johns stay "john"
  "liz":      "elizabeth", // Liz Warren, Liz Cheney
  "beth":     "elizabeth",
  "alex":     "alexander",
  "al":       "alan",      // Al Franken — but he's gone; keep for safety
  "pete":     "peter",     // Pete Sessions, Pete Stauber
  "maggie":   "margaret",  // Maggie Hassan
  "marcy":    "marcia",    // Marcy Kaptur
  "max":      "maximilian",
  "cathy":    "cathleen",  // Cathy McMorris Rodgers
  "kay":      "kathleen",
  "suzan":    "suzanne",   // Suzan DelBene
  "cheri":    "cheryl",    // Cheri Bustos
  "mike":     "michael",
  "mitch":    "addison",   // Mitch McConnell (official: Addison)
  "rand":     "randal",    // Rand Paul (official: Randal)
  "marco":    "marco",     // stays marco
  "bernie":   "bernard",   // Bernie Sanders
  "amy":      "amy",       // stays amy
  "tammy":    "tamara",    // Tammy Baldwin, Tammy Duckworth
  "sherrod":  "sherrod",   // stays sherrod
  "tina":     "christina", // Tina Smith (official: Christina)
  "gary":     "garland",   // Gary Peters (official: Gary — stays)
  "ron":      "ronald",    // Ron Wyden, Ron Johnson
  "roger":    "roger",     // stays roger
  "thom":     "thomas",    // Thom Tillis
  "shelley":  "shelley",   // stays shelley
  "mazie":    "mazie",     // stays mazie
  "angus":    "angus",     // stays angus
  "mark":     "mark",      // stays mark
  "john":     "john",      // stays john (most common)
};

// Full name overrides — for cases where first-name substitution isn't enough
// Key: normalized full name as LLM returns it
// Value: normalized key to look up in dictionary
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
  // House members commonly referenced by nickname
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
  console.log("[Liars Ledger] dictionary loaded,", Object.keys(_dictionary).length, "keys");
  return _dictionary;
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

// Try nickname substitution on a stripped name.
// "chuck schumer" → try FULL_NAME_OVERRIDES first, then first-name swap.
function applyNicknames(stripped) {
  // Full name override first (most precise)
  if (FULL_NAME_OVERRIDES[stripped]) return FULL_NAME_OVERRIDES[stripped];

  // First-name substitution
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
  if (dict[key]) return { status: "found", entry: dict[key] };

  // 2. Strip title, try again
  const stripped = stripTitle(rawName);
  if (dict[stripped]) return { status: "found", entry: dict[stripped] };

  // 3. Nickname substitution on stripped name
  const nicknamedStripped = applyNicknames(stripped);
  if (nicknamedStripped && dict[nicknamedStripped]) {
    return { status: "found", entry: dict[nicknamedStripped] };
  }

  // 4. Nickname substitution on raw key (handles "Chuck Schumer" without title)
  const nicknamedKey = applyNicknames(key);
  if (nicknamedKey && dict[nicknamedKey]) {
    return { status: "found", entry: dict[nicknamedKey] };
  }

  // 5. Last-name-only fallback (handles "Schumer" with no first name)
  const parts = stripped.split(/\s+/);
  if (parts.length > 1) {
    const lastNameOnly = parts[parts.length - 1];
    if (dict[lastNameOnly]) return { status: "found", entry: dict[lastNameOnly] };
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
  const resolved   = [];
  const notMembers = [];
  const notFound   = [];

  for (const name of names) {
    const result = await resolvePolitician(name);

    if (result.status === "found") {
      if (!resolved.find(r => r.bioguide_id === result.entry.bioguide_id)) {
        resolved.push({ matched_as: name, ...result.entry });
      }
    } else if (result.status === "not_member") {
      notMembers.push(name);
    } else {
      notFound.push(name);
    }
  }

  console.log("[Liars Ledger] resolved:", resolved.map(r => r.full_name));
  if (notMembers.length) console.log("[Liars Ledger] not current members:", notMembers);
  if (notFound.length)   console.log("[Liars Ledger] not found:", notFound);

  return { resolved, notMembers, notFound };
}