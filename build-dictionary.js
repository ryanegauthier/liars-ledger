// Worth Noting - build-dictionary.js
// Run this locally with Node.js to generate the politician dictionary.
// You only need to run this once, or when Congress changes.
//
// Usage:
//   node build-dictionary.js <YOUR_CONGRESS_GOV_API_KEY>
//
// Output:
//   src/data/politicians.json
//
// Get a free API key at: https://api.congress.gov/sign-up/

const https = require("https");
const fs = require("fs");
const path = require("path");

const API_KEY = process.argv[2];

if (!API_KEY) {
  console.error("Usage: node build-dictionary.js <YOUR_CONGRESS_GOV_API_KEY>");
  process.exit(1);
}

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

async function fetchAllMembers() {
  const members = [];
  let offset = 0;
  const limit = 250; // max allowed by Congress.gov API

  console.log("Fetching members from Congress.gov...");

  while (true) {
    const url = `https://api.congress.gov/v3/member?limit=${limit}&offset=${offset}&currentMember=true&api_key=${API_KEY}&format=json`;
    const data = await fetchJSON(url);

    if (!data.members || data.members.length === 0) break;

    members.push(...data.members);
    console.log(`  → fetched ${members.length} members so far...`);

    // If we got fewer than the limit, we're done
    if (data.members.length < limit) break;

    offset += limit;

    // Small delay to be polite to the API
    await new Promise(r => setTimeout(r, 300));
  }

  return members;
}

// --- Name helpers ---

function normalizeKey(name) {
  return name.toLowerCase().trim();
}

function getChamber(member) {
  // Congress.gov returns terms array; check most recent term
  if (!member.terms || !member.terms.item || member.terms.item.length === 0) {
    return "unknown";
  }
  const latest = member.terms.item[member.terms.item.length - 1];
  return latest.chamber === "Senate" ? "senate" : "house";
}

function buildAliases(firstName, lastName, chamber) {
  const aliases = new Set();
  const title = chamber === "senate" ? "Sen." : "Rep.";
  const titleFull = chamber === "senate" ? "Senator" : "Representative";
  const full = `${firstName} ${lastName}`;

  aliases.add(normalizeKey(full));
  aliases.add(normalizeKey(lastName));
  aliases.add(normalizeKey(`${title} ${lastName}`));
  aliases.add(normalizeKey(`${title} ${full}`));
  aliases.add(normalizeKey(`${titleFull} ${lastName}`));
  aliases.add(normalizeKey(`${titleFull} ${full}`));

  return [...aliases];
}

// --- Main ---

async function buildDictionary() {
  const members = await fetchAllMembers();
  console.log(`\nTotal members fetched: ${members.length}`);

  const dictionary = {};
  let count = 0;

  for (const member of members) {
    // Congress.gov name format: "Last, First" or just use name fields
    let firstName = member.firstName || "";
    let lastName = member.lastName || "";

    // Some entries have a "name" field formatted as "Last, First"
    if ((!firstName || !lastName) && member.name) {
      const parts = member.name.split(",").map(s => s.trim());
      if (parts.length >= 2) {
        lastName = parts[0];
        firstName = parts[1];
      }
    }

    if (!firstName || !lastName) {
      console.warn("  Skipping member with missing name:", member);
      continue;
    }

    const chamber = getChamber(member);
    const title = chamber === "senate" ? "Sen." : "Rep.";
    const full = `${firstName} ${lastName}`;
    const aliases = buildAliases(firstName, lastName, chamber);
    const primaryKey = normalizeKey(full);

    const entry = {
      full_name: full,
      display: `${title} ${lastName}`,
      first_name: firstName,
      last_name: lastName,
      state: member.state || "",
      party: member.partyName || "",
      chamber: chamber,
      bioguide_id: member.bioguideId || "",   // Congress.gov primary ID
      depiction: member.depiction?.imageUrl || null,
      aliases: aliases,
    };

    dictionary[primaryKey] = entry;
    for (const alias of aliases) {
      if (!dictionary[alias]) {
        dictionary[alias] = entry;
      }
    }

    count++;
  }

  // Write output
  const outDir = path.join(__dirname, "src", "data");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "politicians.json");
  fs.writeFileSync(outPath, JSON.stringify(dictionary, null, 2));

  console.log(`\nDone. ${count} members indexed.`);
  console.log(`Dictionary written to: ${outPath}`);
  console.log(`Total lookup keys (including aliases): ${Object.keys(dictionary).length}`);
}

buildDictionary().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
