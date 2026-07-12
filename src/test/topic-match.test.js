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
