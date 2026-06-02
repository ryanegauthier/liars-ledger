// ---------------------------------------------------------------
// Add to server/index.js
// ---------------------------------------------------------------
// At the top, with other requires:
const { verifyClaim } = require("./providers/verify");

// Add this route alongside your existing /api/claude/extract and /api/mistral/extract:

app.post("/api/verify-claim", async (req, res) => {
  const { claim, member, record } = req.body;

  if (!claim) return res.status(400).json({ error: "claim required" });
  if (!member) return res.status(400).json({ error: "member required" });
  if (!record) return res.status(400).json({ error: "record required" });

  const result = await verifyClaim(claim, member, record);
  res.status(result.ok ? 200 : 502).json(result);
});
