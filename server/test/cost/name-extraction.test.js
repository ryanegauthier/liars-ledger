// server/test/cost/name-extraction.test.js
// Real model calls (small cost, about $0.001 per run). Run with: npm run test:cost
// Checks the v0.17.18 prompt: full personal names, no titles or party words,
// and people who are not in Congress still extracted (the dictionary, not
// the model, decides membership). Only meaningful against a server running
// the v0.17.18 prompt.
import { describe, it, expect } from "vitest";
import { api, authHeaders, getScanToken } from "../helpers.js";

const ARTICLE =
  "The unassuming state lawmaker had beaten U.S. Rep. Jasmine Crockett in a Democratic Senate primary, " +
  "and now faces state Attorney General Ken Paxton, the GOP nominee. State Rep. James Talarico spent the " +
  "week in Houston. Republican Gov. Joe Lombardo of Nevada endorsed Paxton, and Sen. Elizabeth Warren " +
  "criticized the endorsement. Rep. Beth Doglio of Washington also weighed in.";

const TITLE_WORDS = /\b(Rep|Sen|Gov|Dr|U\.S|Republican|Democratic|Attorney|General|State)\b\.?/;

for (const provider of ["claude", "mistral"]) {
  describe(`${provider} name extraction (real API call)`, () => {
    it("returns full names with no titles, including people not in Congress", async () => {
      const scanToken = await getScanToken();
      const { status, body } = await api(`/api/${provider}/extract`, {
        method: "POST",
        headers: authHeaders(),
        body: { articleText: ARTICLE, scanToken },
      });
      expect(status).toBe(200);
      const names = body.figures.map((f) => f.lookup_name);
      for (const n of names) expect(n).not.toMatch(TITLE_WORDS);
      for (const expected of ["Jasmine Crockett", "Ken Paxton", "James Talarico", "Joe Lombardo", "Elizabeth Warren"]) {
        expect(names).toContain(expected);
      }
    }, 40000);
  });
}
