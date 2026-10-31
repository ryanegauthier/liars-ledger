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

// Leading words removed before lookup: titles, honorifics, party labels, and
// role words (with or without a trailing period, case-insensitive). The last
// remaining word is never removed, because some of these are also surnames
// ("Sen. Jim Justice", "Rep. Speaker" style edge cases).
const LEADING_TITLE_WORDS = new Set([
  "u.s", "us", "state", "former", "the",
  "rep", "representative", "congressman", "congresswoman", "congressmember",
  "sen", "senator", "gov", "governor", "lt", "lieutenant", "mayor",
  "president", "vice", "secretary", "sec", "speaker", "leader", "majority",
  "minority", "whip", "attorney", "general", "ag", "del", "delegate",
  "resident", "commissioner", "assemblymember", "assemblyman", "assemblywoman",
  "councilmember", "councilman", "councilwoman", "chair", "chairman",
  "chairwoman", "judge", "justice", "sheriff",
  "dr", "mr", "mrs", "ms", "mx", "gen", "col", "colonel", "sgt", "sergeant",
  "capt", "captain", "adm", "admiral", "rev",
  "democrat", "democratic", "republican", "gop", "independent",
]);

// Words that are never a person's name. A candidate made only of these
// ("Republican Gov", "U.S. Rep") is a title fragment, not a person, and is
// dropped instead of looked up. Deliberately excludes words that are also
// surnames (Justice, Speaker, Judge, Mayor, ...).
const NEVER_A_NAME_WORDS = new Set([
  "u.s", "us", "state", "former", "the",
  "rep", "representative", "congressman", "congresswoman", "congressmember",
  "sen", "senator", "gov", "governor", "lt", "lieutenant", "secretary", "sec",
  "attorney", "ag", "del", "delegate", "commissioner",
  "dr", "mr", "mrs", "ms", "mx", "gen", "col", "sgt", "capt", "adm", "rev",
  "democrat", "democratic", "republican", "gop", "independent",
]);

function titleWord(token) {
  return token.toLowerCase().replace(/\.+$/, "");
}

/**
 * Removes leading titles/party/role words and trailing party-state tags
 * (", R-Ohio", "(D-Texas)"), generational suffixes, and possessives, keeping
 * the original capitalization of what remains.
 *   "Republican Gov. Joe Lombardo" -> "Joe Lombardo"
 *   "U.S. Rep. Jasmine Crockett"   -> "Jasmine Crockett"
 *   "Dr. Jane Smith, R-Ohio"       -> "Jane Smith"
 */
function cleanName(name) {
  let s = String(name || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s,]*\(?\b[RDI]-[A-Za-z. ]+\)?$/, "")      // ", R-Ohio" / "(D-Texas)"
    .replace(/,?\s+(jr|sr|ii|iii|iv)\.?$/i, "")          // ", Jr."
    .replace(/['’]s$/i, "")                          // possessive
    .trim();
  const tokens = s.split(" ").filter(Boolean);
  while (tokens.length > 1 && LEADING_TITLE_WORDS.has(titleWord(tokens[0]))) tokens.shift();
  return tokens.join(" ");
}

function stripTitle(name) {
  return cleanName(name).toLowerCase();
}

// True when the candidate is only titles/party/role words, e.g. "Republican Gov".
function isTitleOnly(name) {
  const tokens = String(name || "").trim().split(/\s+/).filter(Boolean);
  return tokens.length === 0 || tokens.every((t) => NEVER_A_NAME_WORDS.has(titleWord(t)));
}

// For the last-name-only fallback: a full name only matches a member by
// surname if the first names are compatible, so a non-member who shares a
// common surname ("John Smith", a state senator) is not resolved to a member
// of Congress ("Adrian Smith").
function firstNameCompatible(first, entry) {
  const f = (first || "").toLowerCase().replace(/\./g, "");
  const candidates = [entry.first_name, (entry.full_name || "").split(/\s+/)[0]]
    .map((x) => (x || "").toLowerCase().split(/\s+/)[0].replace(/\./g, ""))
    .filter(Boolean);
  if (!f || !candidates.length) return true;
  return candidates.some((ef) =>
    f === ef ||
    NICKNAME_FIRST[f] === ef ||
    NICKNAME_FIRST[ef] === f ||
    (f.length === 1 && ef.startsWith(f)) ||
    (f.length >= 3 && ef.startsWith(f)) ||
    (ef.length >= 3 && f.startsWith(ef)));
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
  // 0. A title fragment with no actual name ("Republican Gov") is not a
  //    person; drop it instead of reporting it as someone not found.
  if (isTitleOnly(rawName)) return { status: "invalid", name: rawName };

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

  // 5. Last-name-only fallback, only when the first name is compatible
  const parts = stripped.split(/\s+/);
  if (parts.length > 1) {
    const lastNameOnly = parts[parts.length - 1];
    const m5 = lookupAlias(dict, lastNameOnly);
    if (m5 && firstNameCompatible(parts[0], m5)) return { status: m5.is_current ? "found" : "former", entry: m5 };
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

  // Bare surname mentions ("Rep. Smith") are ambiguous whenever more than
  // one current member shares that last name - the dictionary's alias
  // table can only point a bare surname at one hardcoded bioguide_id.
  // Confirmed live: "smith" always resolves to Adrian Smith (R-NE)
  // regardless of context, even in a scan that had already resolved
  // "Rep. Adam Smith" (D-WA) from a fuller mention moments earlier in the
  // same article - producing two unrelated members in one report instead
  // of one. Journalism convention introduces a person by full name once
  // and refers back to them by surname alone afterward, so within a single
  // scan, a bare surname already resolved earlier in this same name list
  // takes priority over the dictionary's single hardcoded alias - but only
  // when exactly ONE distinct person with that surname has been resolved
  // so far. An article naming two different same-surname members by full
  // name (e.g. both "Adam Smith" and "Jason Smith" discussed in the same
  // piece) before a later bare "Smith" is genuinely ambiguous, not a safe
  // back-reference to either - guessing between two real in-scan
  // candidates would be confidently wrong in a new way, worse than the
  // dictionary's already-known-arbitrary fallback. Once a surname has 2+
  // distinct bioguide_ids seen this scan, it's treated as unresolved
  // ambiguity and falls through to that same old fallback instead.
  const lastNameSeen = new Map(); // lowercased last_name -> Set of bioguide_ids resolved this batch

  for (const name of names) {
    const bareSurname = stripTitle(name);
    if (bareSurname && !bareSurname.includes(" ")) {
      const seenIds = lastNameSeen.get(bareSurname);
      if (seenIds && seenIds.size === 1) {
        continue;
      }
    }

    const result = await resolvePolitician(name);

    if (result.status === "found") {
      if (!resolved.find(r => r.bioguide_id === result.entry.bioguide_id)) {
        resolved.push({ matched_as: name, ...result.entry });
      }
      const last = (result.entry.last_name || "").toLowerCase();
      if (last) {
        if (!lastNameSeen.has(last)) lastNameSeen.set(last, new Set());
        lastNameSeen.get(last).add(result.entry.bioguide_id);
      }
    } else if (result.status === "former") {
      if (!formerMembers.find(r => r.bioguide_id === result.entry.bioguide_id)) {
        formerMembers.push({ matched_as: name, ...result.entry });
      }
      const last = (result.entry.last_name || "").toLowerCase();
      if (last) {
        if (!lastNameSeen.has(last)) lastNameSeen.set(last, new Set());
        lastNameSeen.get(last).add(result.entry.bioguide_id);
      }
    } else if (result.status === "invalid") {
      console.log("[Liars Ledger] dropped title-only candidate:", name);
    } else {
      // Both lists are shown as "Not a current member of Congress" with the
      // cleaned name (titles removed), deduplicated. notMembers keeps the
      // separate bucket for people whose title marks them as a non-member.
      const list = result.status === "not_member" ? notMembers : notFound;
      const display = cleanName(name);
      if (display && !list.some((n) => n.toLowerCase() === display.toLowerCase())) list.push(display);
    }
  }

  console.log("[Liars Ledger] resolved:", resolved.map(r => r.full_name));
  if (formerMembers.length) console.log("[Liars Ledger] former members:", formerMembers.map(r => r.full_name));
  if (notMembers.length) console.log("[Liars Ledger] not current members:", notMembers);
  if (notFound.length)   console.log("[Liars Ledger] not found:", notFound);

  return { resolved, formerMembers, notMembers, notFound };
}
