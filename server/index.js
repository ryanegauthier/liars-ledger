// Liar's Ledger - server/index.js
// Backend proxy server.
//
// Holds all API keys. The extension calls this server, never external APIs directly.
// This eliminates key exposure and enables freemium tier management later.
//
// Routes:
//   POST /api/analyze          — dual-model LLM claim extraction (Claude + Mistral)
//   POST /api/claude/extract   — Claude only
//   POST /api/mistral/extract  — Mistral only
//   GET  /api/congress/*       — Congress.gov proxy
//   GET  /api/votesmart/*      — VoteSmart proxy (handles JWT auth + refresh)
//   GET  /health               — health check for Render

import "dotenv/config";
import express from "express";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import { claude }    from "./providers/claude.js";
import { mistral }   from "./providers/mistral.js";
import { congress }  from "./providers/congress.js";
import { votesmart } from "./providers/votesmart.js";

const app  = express();
const PORT = process.env.PORT || 3001;

// ── CORS ──────────────────────────────────────────────────────────────────────
// Only allow requests from the extension.
// Add your extension ID to ALLOWED_ORIGINS in .env / Render env vars.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (server-to-server, curl, health checks)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.json({ limit: "64kb" }));

// ── Rate limiting — generous for dev, tighten in 0.11.0 ──────────────────────
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,             // 60 requests/minute per IP — effectively unlimited for dev
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down." },
});
app.use("/api", limiter);

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status:  "ok",
    version: "1.0.0",
    ts:      new Date().toISOString(),
  });
});

// ── LLM routes ───────────────────────────────────────────────────────────────

// POST /api/analyze — dual-model, runs both in parallel, returns merged result
app.post("/api/analyze", async (req, res) => {
  const { articleText } = req.body;
  if (!articleText) return res.status(400).json({ error: "articleText required" });

  const [claudeResult, mistralResult] = await Promise.allSettled([
    claude.extract(articleText),
    mistral.extract(articleText),
  ]);

  const claudeOk  = claudeResult.status  === "fulfilled" && claudeResult.value?.ok;
  const mistralOk = mistralResult.status === "fulfilled" && mistralResult.value?.ok;

  if (!claudeOk && !mistralOk) {
    return res.status(502).json({
      ok: false,
      error: `Both models failed. Claude: ${claudeResult.value?.error || claudeResult.reason?.message}. Mistral: ${mistralResult.value?.error || mistralResult.reason?.message}`,
    });
  }

  if (!claudeOk || !mistralOk) {
    const winner = claudeOk ? claudeResult.value : mistralResult.value;
    return res.json({
      ...winner,
      _meta: {
        provider: "single_model",
        winner:   claudeOk ? "claude" : "mistral",
        loser:    claudeOk ? "mistral" : "claude",
      },
    });
  }

  // Both succeeded — return both, let llm.js client do the merge
  // (same Jaccard logic as before, just keys moved to proxy)
  res.json({
    ok:      true,
    claude:  claudeResult.value,
    mistral: mistralResult.value,
    _meta:   { provider: "dual" },
  });
});

// POST /api/claude/extract — Claude only
app.post("/api/claude/extract", async (req, res) => {
  const { articleText } = req.body;
  if (!articleText) return res.status(400).json({ error: "articleText required" });
  const result = await claude.extract(articleText);
  res.status(result.ok ? 200 : 502).json(result);
});

// POST /api/mistral/extract — Mistral only
app.post("/api/mistral/extract", async (req, res) => {
  const { articleText } = req.body;
  if (!articleText) return res.status(400).json({ error: "articleText required" });
  const result = await mistral.extract(articleText);
  res.status(result.ok ? 200 : 502).json(result);
});

// ── Congress.gov proxy ────────────────────────────────────────────────────────
// GET /api/congress/* → https://api.congress.gov/v3/*
// Strips /api/congress prefix, appends API key, forwards response
app.get("/api/congress/*", async (req, res) => {
  const path = req.params[0];
  const query = new URLSearchParams(req.query);
  query.set("api_key", process.env.CONGRESS_API_KEY);
  query.set("format", "json");

  try {
    const result = await congress.fetch(`/${path}?${query.toString()}`);
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── VoteSmart proxy ───────────────────────────────────────────────────────────
// GET /api/votesmart/* → https://app.votesmart-api.org/*
// Handles JWT auth + refresh automatically
app.get("/api/votesmart/*", async (req, res) => {
  const path = req.params[0];
  const query = new URLSearchParams(req.query);

  try {
    const result = await votesmart.fetch(`/${path}?${query.toString()}`);
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Liar's Ledger API] listening on port ${PORT}`);
  console.log(`[Liar's Ledger API] Claude:    ${process.env.CLAUDE_API_KEY   ? "✓" : "✗ missing"}`);
  console.log(`[Liar's Ledger API] Mistral:   ${process.env.MISTRAL_API_KEY  ? "✓" : "✗ missing"}`);
  console.log(`[Liar's Ledger API] Congress:  ${process.env.CONGRESS_API_KEY ? "✓" : "✗ missing"}`);
  console.log(`[Liar's Ledger API] VoteSmart: ${process.env.VOTESMART_EMAIL  ? "✓" : "✗ missing"}`);
});
