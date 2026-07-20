import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadScript } from "./helpers/load-script.js";

const g = loadScript("src/topic-match.js");

describe("billMatchesTopic", () => {
  it("matches health care keywords in bill title", () => {
    const bill = { title: "Medicare Drug Price Negotiation Act of 2025" };
    assert.equal(g.billMatchesTopic(bill, "health care"), true);
  });

  it("returns false when bill has no title", () => {
    assert.equal(g.billMatchesTopic({}, "health care"), false);
  });

  it("matches custom topic substring", () => {
    const bill = { title: "Rural Broadband Expansion Act" };
    assert.equal(g.billMatchesTopic(bill, "broadband"), true);
  });

  it("matches an LLM search term via its distinctive word, ignoring filler words", () => {
    const bill = { title: "Medicare Drug Price Negotiation Act of 2025" };
    assert.equal(g.billMatchesTopic(bill, "Medicare for All"), true);
  });

  it("matches an LLM search term when only the non-filler word is present", () => {
    const bill = { title: "Rural Hospital Support Act" };
    assert.equal(g.billMatchesTopic(bill, "hospital funding"), true);
  });

  it("does not match when the distinctive word is absent", () => {
    const bill = { title: "Rural Broadband Expansion Act" };
    assert.equal(g.billMatchesTopic(bill, "Medicare for All"), false);
  });

  it("does not match \"social security\" on a bare mention of retirement", () => {
    // Confirmed live: "Protecting Public Safety Employees' Timely
    // Retirement Act" matched the "social security" category via a bare
    // "retirement" keyword despite having nothing to do with Social
    // Security policy - "retirement" was removed as too broad.
    const bill = { title: "Protecting Public Safety Employees' Timely Retirement Act of 2022" };
    assert.equal(g.billMatchesTopic(bill, "social security"), false);
  });

  it("still matches \"social security\" on the actual phrase or other real keywords", () => {
    assert.equal(g.billMatchesTopic({ title: "Social Security Fairness Act" }, "social security"), true);
    assert.equal(g.billMatchesTopic({ title: "Medicaid Expansion Act" }, "social security"), true);
  });

  it("does not match on \"insurance\" alone - only meaningful paired with its subject", () => {
    // Confirmed live: the LLM search term "health insurance reform" left
    // "insurance" as the sole surviving distinctive word (once "reform"
    // was filtered as filler), which alone matched "Smoke Exposure Crop
    // Insurance Act" - a farm bill unrelated to the health care article
    // being scanned.
    const bill = { title: "Smoke Exposure Crop Insurance Act of 2023" };
    assert.equal(g.billMatchesTopic(bill, "health insurance reform"), false);
  });

  it("still matches on the real subject word once insurance/reform are filtered", () => {
    const bill = { title: "Affordable Health Care Act" };
    assert.equal(g.billMatchesTopic(bill, "health insurance reform"), true);
  });

  it("does not match on \"public\" alone - confirmed live false positive", () => {
    // "public option healthcare" left "public" as a surviving distinctive
    // word, which alone matched "Protecting Public Safety Employees'
    // Timely Retirement Act" - unrelated to the health care "public
    // option" concept the term was describing.
    const bill = { title: "Protecting Public Safety Employees' Timely Retirement Act of 2022" };
    assert.equal(g.billMatchesTopic(bill, "public option healthcare"), false);
  });

  it("still matches \"public option healthcare\" on the real subject word", () => {
    const bill = { title: "Rural Healthcare Access Act" };
    assert.equal(g.billMatchesTopic(bill, "public option healthcare"), true);
  });

  it("does not match on \"cost\" alone - confirmed live false positive", () => {
    // "healthcare cost crisis" left "cost" as a surviving distinctive
    // word, which alone matched "Increase Federal Disaster Cost Share
    // Act" - unrelated to healthcare costs.
    const bill = { title: "Increase Federal Disaster Cost Share Act of 2021" };
    assert.equal(g.billMatchesTopic(bill, "healthcare cost crisis"), false);
  });

  it("still matches \"healthcare cost crisis\" on the real subject word", () => {
    const bill = { title: "Rural Healthcare Access Act" };
    assert.equal(g.billMatchesTopic(bill, "healthcare cost crisis"), true);
  });

  it("does not match \"public option\" (all-filler term) against \"Republic of Cuba\" - confirmed live false positive", () => {
    // Both "public" and "option" are filler words, so the term has no
    // distinctive word at all. The old fallback treated the raw words as
    // an OR-match via plain substring, and "public" matched inside
    // "Republic" of a Cuba war-powers resolution with no connection to
    // the health care article being scanned.
    const bill = {
      title: "A joint resolution to direct the removal of United States Armed Forces from hostilities within or against the Republic of Cuba that have not been authorized by Congress.",
    };
    assert.equal(g.billMatchesTopic(bill, "public option"), false);
  });

  it("still matches \"public option\" when both words are literally present", () => {
    const bill = { title: "Public Option Health Insurance Act" };
    assert.equal(g.billMatchesTopic(bill, "public option"), true);
  });

  it("does not match a short distinctive word as a substring inside an unrelated word", () => {
    // "art" would previously substring-match "heart" via a bare
    // text.includes() check.
    const bill = { title: "Rural Heart Disease Prevention Act" };
    assert.equal(g.billMatchesTopic(bill, "art funding"), false);
  });
});

describe("rollCallMatchesTopics", () => {
  it("matches via mapped keyword in vote question", () => {
    const vote = {
      voteQuestion: "On Passage of the Border Security and Immigration Reform Act",
    };
    assert.equal(g.rollCallMatchesTopics(vote, ["immigration"]), true);
  });

  it("matches direct topic substring", () => {
    const vote = { question: "Motion on climate change emissions standards" };
    assert.equal(g.rollCallMatchesTopics(vote, ["climate change"]), true);
  });

  it("returns false for empty vote text", () => {
    assert.equal(g.rollCallMatchesTopics({}, ["defense"]), false);
  });
});

describe("extractRollCallList", () => {
  it("reads houseRollCallVotes array", () => {
    const data = { houseRollCallVotes: [{ rollCall: 1 }, { rollCall: 2 }] };
    assert.equal(g.extractRollCallList("house", data).length, 2);
  });

  it("reads senateRollCallVotes array", () => {
    const data = { senateRollCallVotes: [{ number: 10 }] };
    assert.equal(g.extractRollCallList("senate", data).length, 1);
  });
});

describe("extractRollNumber", () => {
  it("reads rollCall or number", () => {
    assert.equal(g.extractRollNumber({ rollCall: "42" }), 42);
    assert.equal(g.extractRollNumber({ number: 7 }), 7);
  });
});

describe("chamberKey", () => {
  it("normalizes chamber strings", () => {
    assert.equal(g.chamberKey("Senate"), "senate");
    assert.equal(g.chamberKey("house"), "house");
    assert.equal(g.chamberKey("other"), "");
  });
});

describe("memberVotePosition", () => {
  it("reads voteCast first", () => {
    assert.equal(g.memberVotePosition({ voteCast: "Aye", vote: "Nay" }), "Aye");
  });
});
