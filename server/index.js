// Liar's Ledger - server/index.js
// Backend proxy server.
//
// Routes:
//   POST /api/claude/extract   — Claude extraction
//   POST /api/mistral/extract  — Mistral extraction
//   GET  /api/congress/*       — Congress.gov proxy
//   GET  /api/votesmart/*      — VoteSmart proxy (JWT auth + refresh)
//   GET  /api/govtrack/*       — GovTrack proxy (no key)
//   GET  /api/legislators      — congress-legislators dataset (cached)
//   GET  /health               — health check

import "dotenv/config";
import express from "express";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import { claude }    from "./providers/claude.js";
import { mistral }   from "./providers/mistral.js";
import { congress }  from "./providers/congress.js";
import { votesmart } from "./providers/votesmart.js";
import { govtrack }  from "./providers/govtrack.js";
import { verifyClaim } from "./providers/verify.js";

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Async wrapper — catches rejected promises from async route handlers ────────
// Express 4.x does not catch async errors automatically.
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ── CORS ──────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(o => o.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.json({ limit: "64kb" }));

// ── Rate limiting ─────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down." },
});
app.use("/api", limiter);

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", version: process.env.npm_package_version || "0.12.1", ts: new Date().toISOString() });
});

// ── LLM routes ────────────────────────────────────────────────────────────────

// POST /api/claude/extract
app.post("/api/claude/extract", wrap(async (req, res) => {
  const { articleText } = req.body;
  if (!articleText) return res.status(400).json({ error: "articleText required" });
  const result = await claude.extract(articleText);
  res.status(result.ok ? 200 : 502).json(result);
}));

// POST /api/mistral/extract
app.post("/api/mistral/extract", wrap(async (req, res) => {
  const { articleText } = req.body;
  if (!articleText) return res.status(400).json({ error: "articleText required" });
  const result = await mistral.extract(articleText);
  res.status(result.ok ? 200 : 502).json(result);
}));

app.post("/api/verify-claim", wrap(async (req, res) => {  const { claim, member, record } = req.body;

  if (!claim) return res.status(400).json({ error: "claim required" });
  if (!member) return res.status(400).json({ error: "member required" });
  if (!record) return res.status(400).json({ error: "record required" });

  const result = await verifyClaim(claim, member, record);
  res.status(result.ok ? 200 : 502).json(result);
}));

// ── Congress.gov proxy ────────────────────────────────────────────────────────
app.get("/api/congress/*", wrap(async (req, res) => {
  const path  = req.params[0];
  const query = new URLSearchParams(req.query);
  query.set("api_key", process.env.CONGRESS_API_KEY);
  query.set("format", "json");

  try {
    const result = await congress.fetch(`/${path}?${query.toString()}`);
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}));

// ── VoteSmart proxy ───────────────────────────────────────────────────────────
app.get("/api/votesmart/*", wrap(async (req, res) => {
  const path  = req.params[0];
  const query = new URLSearchParams(req.query);

  try {
    const result = await votesmart.fetch(`/${path}?${query.toString()}`);
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}));

// ── GovTrack proxy ────────────────────────────────────────────────────────────
// GET /api/govtrack/* → https://www.govtrack.us/api/v2/* (no key required)
app.get("/api/govtrack/*", wrap(async (req, res) => {
  const path  = req.params[0];
  const query = new URLSearchParams(req.query);

  try {
    const result = await govtrack.fetch(`/${path}?${query.toString()}`);
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}));

// ── Congress legislators dataset (static, cached) ─────────────────────────────
// GET /api/legislators → unitedstates.github.io congress-legislators-current.json
app.get("/api/legislators", wrap(async (req, res) => {
  try {
    res.json(await govtrack.legislators());
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}));

// ── Global error middleware ───────────────────────────────────────────────────
// Catches any unhandled errors from async route handlers (via wrap())
// and ensures the client always gets a JSON response instead of hanging.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("[Liar's Ledger API] unhandled error:", err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, error: "Internal server error" });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Liar's Ledger API] listening on port ${PORT}`);
  console.log(`[Liar's Ledger API] Claude:    ${process.env.CLAUDE_API_KEY   ? "✓" : "✗ missing"}`);
  console.log(`[Liar's Ledger API] Mistral:   ${process.env.MISTRAL_API_KEY  ? "✓" : "✗ missing"}`);
  console.log(`[Liar's Ledger API] Congress:  ${process.env.CONGRESS_API_KEY ? "✓" : "✗ missing"}`);
  console.log(`[Liar's Ledger API] VoteSmart: ${process.env.VOTESMART_EMAIL  ? "✓" : "✗ missing"}`);
});
