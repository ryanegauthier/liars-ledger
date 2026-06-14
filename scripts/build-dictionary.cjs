// Liars Ledger - scripts/build-dictionary.js
// Generates the condensed politician dictionary from Congress.gov.
// Pulls members from congresses 110–119 (2007–2026) for 20 years of coverage.
//
// Usage:
//   node scripts/build-dictionary.js <YOUR_CONGRESS_GOV_API_KEY>
//
// Output:
//   src/data/politicians.json (condensed format)
//
// Get a free API key at: https://api.congress.gov/sign-up/

const https = require("https");
const fs = require("fs");
const path = require("path");

const API_KEY = process.argv[2];

if (!API_KEY) {
  console.error("Usage: node scripts/build-dictionary.js <YOUR_CONGRESS_GOV_API_KEY>");
  process.exit(1);
}

const CONGRESSES = [110, 111, 112, 113, 114, 115, 116, 117, 118, 119];
const CURRENT_CONGRESS = 119;

// Well-known nicknames the API won't provide
const NICKNAME_OVERRIDES = {
  "G000596": ["mtg"],
  "O000172": ["aoc"],
  "S000033": ["bernie"],
  "M000355": ["mitch"],
  "P000197": ["nancy"],
  "F000457": ["al franken"],
};

// --- Fetch helpers ---

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error("Failed to parse JSON: " + data.slice(0, 200)));
        }
      });
    }).on("error", reject);
  });
}

async function fetchMembersForCongress(congress) {
  const members = [];
  let offset = 0;
  const limit = 250;

  while (true) {
    const url = `https://api.congress.gov/v3/member/congress/${congress}?limit=${limit}&offset=${offset}&api_key=${API_KEY}&format=json`;
    const data = await fetchJSON(url);

    if (!data.members || data.members.length === 0) break;

    members.push(...data.members);

    if (data.members.length < limit) break;

    offset += limit;
    await new Promise(r => setTimeout(r, 300));
  }

  return members;
}

// --- Name helpers ---

function normalizeKey(name) {
  return name.toLowerCase().replace(/[.,]/g, "").replace(/\s+/g, " ").trim();
}

function stripMiddle(firstName, lastName) {
  const firstOnly = firstName.trim().split(/\s+/)[0];
  return `${firstOnly} ${lastName}`;
}

function stripSuffix(name) {
  return name.replace(/\s+(jr|sr|ii|iii|iv|v|vi|vii|viii)\.?$/i, "").trim();
}

function getChamber(member) {
  if (!member.terms || !member.terms.item || member.terms.item.length === 0) {
    return "house";
  }
  const latest = member.terms.item[member.terms.item.length - 1];
  return (latest.chamber || "").toLowerCase() === "senate" ? "senate" : "house";
}

function generateAliases(firstName, lastName, chamber, bioguide) {
  const aliases = new Set();
  const title = chamber === "senate" ? "Sen." : "Rep.";
  const titleFull = chamber === "senate" ? "Senator" : "Representative";
  const full = `${firstName} ${lastName}`;
  const shortFull = stripMiddle(firstName, lastName);
  const firstOnly = firstName.trim().split(/\s+/)[0];

  // Full name variants
  aliases.add(normalizeKey(full));
  aliases.add(normalizeKey(stripSuffix(full)));
  aliases.add(normalizeKey(shortFull));
  aliases.add(normalizeKey(stripSuffix(shortFull)));
  aliases.add(normalizeKey(lastName));

  // Title + last
  aliases.add(normalizeKey(`${title} ${lastName}`));
  aliases.add(normalizeKey(`${titleFull} ${lastName}`));

  // Title + full name
  aliases.add(normalizeKey(`${title} ${full}`));
  aliases.add(normalizeKey(`${titleFull} ${full}`));

  // Title + short name
  aliases.add(normalizeKey(`${title} ${shortFull}`));
  aliases.add(normalizeKey(`${titleFull} ${shortFull}`));

  // First + Last only
  aliases.add(normalizeKey(`${firstOnly} ${lastName}`));

  // Nickname overrides
  const overrides = NICKNAME_OVERRIDES[bioguide] || [];
  for (const nick of overrides) {
    aliases.add(normalizeKey(nick));
  }

  return [...aliases].filter(a => a.length > 1);
}

// --- Main ---

async function buildDictionary() {
  console.log("Building condensed politician dictionary...\n");

  const memberMap = new Map(); // bioguide_id → member data

  for (const congress of CONGRESSES) {
    console.log(`Congress ${congress}:`);
    const raw = await fetchMembersForCongress(congress);
    console.log(`  → ${raw.length} members\n`);

    for (const member of raw) {
      let firstName = member.firstName || "";
      let lastName = member.lastName || "";
      const bioguide = member.bioguideId || "";

      if (!bioguide) continue;

      if ((!firstName || !lastName) && member.name) {
        const parts = member.name.split(",").map(s => s.trim());
        if (parts.length >= 2) {
          lastName = parts[0];
          firstName = parts[1];
        }
      }

      if (!firstName || !lastName) {
        console.warn(`  Skipping: missing name for ${bioguide}`);
        continue;
      }

      const chamber = getChamber(member);
      const existing = memberMap.get(bioguide);

      if (!existing) {
        memberMap.set(bioguide, {
          bioguide_id: bioguide,
          full_name: `${firstName} ${lastName}`,
          first_name: firstName,
          last_name: lastName,
          state: member.state || "",
          party: member.partyName || "",
          chamber: chamber,
          depiction: member.depiction?.imageUrl || "",
          congresses: [congress],
          is_current: congress === CURRENT_CONGRESS,
        });
      } else {
        if (!existing.congresses.includes(congress)) {
          existing.congresses.push(congress);
        }
        if (congress === CURRENT_CONGRESS) {
          existing.is_current = true;
          existing.chamber = chamber;
          existing.party = member.partyName || existing.party;
          existing.state = member.state || existing.state;
          if (member.depiction?.imageUrl) existing.depiction = member.depiction.imageUrl;
        }
      }
    }

    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\nTotal unique members: ${memberMap.size}`);

  // Build condensed output
  const members = {};
  const aliases = {};
  let collisions = 0;

  for (const [bioguide, member] of memberMap) {
    members[bioguide] = {
      full_name: member.full_name,
      first_name: member.first_name,
      last_name: member.last_name,
      state: member.state,
      party: member.party,
      chamber: member.chamber,
      depiction: member.depiction,
      congresses: member.congresses.sort((a, b) => a - b),
      is_current: member.is_current,
    };

    const memberAliases = generateAliases(
      member.first_name, member.last_name, member.chamber, bioguide
    );

    for (const alias of memberAliases) {
      if (aliases[alias] && aliases[alias] !== bioguide) {
        // Collision - prefer current member, then most recent congress
        const existingMember = memberMap.get(aliases[alias]);
        if (member.is_current && !existingMember.is_current) {
          aliases[alias] = bioguide;
        } else if (!member.is_current && existingMember.is_current) {
          // keep existing
        } else {
          const maxExisting = Math.max(...existingMember.congresses);
          const maxNew = Math.max(...member.congresses);
          if (maxNew > maxExisting) aliases[alias] = bioguide;
        }
        collisions++;
      } else {
        aliases[alias] = bioguide;
      }
    }
  }

  const output = { members, aliases };
  const json = JSON.stringify(output, null, 2);

  const outDir = path.join(__dirname, "..", "src", "data");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "politicians.json");
  fs.writeFileSync(outPath, json);

  const sizeKB = Math.round(json.length / 1024);
  const currentCount = Object.values(members).filter(m => m.is_current).length;
  const formerCount = Object.values(members).filter(m => !m.is_current).length;

  console.log(`\n✅ Dictionary written to ${outPath}`);
  console.log(`   ${Object.keys(members).length} members (${currentCount} current, ${formerCount} former)`);
  console.log(`   ${Object.keys(aliases).length} unique aliases (${collisions} collisions resolved)`);
  console.log(`   File size: ${sizeKB}KB`);
}

buildDictionary().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});