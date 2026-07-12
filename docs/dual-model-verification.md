---
title: Dual-Model Verification
nav_order: 3
---

# Dual-Model Verification

## Why two models?

Liar's Ledger uses two independent AI models to extract claims from articles:

- **Claude Haiku** (Anthropic) - US-based AI safety company, Constitutional AI research
- **Mistral Small** (Mistral AI) - French AI company, European training data, open-weights model

Using models from different companies with different training data reduces the risk of systematic bias. If both models independently extract the same claim about a politician, that claim is more defensible than if only one model saw it.

## How it works

Both models receive the same article text (capped at 12,000 characters) via the backend proxy. They run in parallel via `Promise.allSettled`. Each independently returns:

```json
{
  "article_summary": "...",
  "main_topics": ["immigration", "federal budget"],
  "figures": [
    {
      "lookup_name": "Sen. Sanders",
      "claim": "Sanders has called for an outright moratorium on data centers.",
      "search_terms": ["data center moratorium", "data center restrictions"]
    }
  ]
}
```

Both models use `temperature: 0.0` for deterministic output.

Claims are then compared per politician using **Jaccard similarity** - the percentage of meaningful words the two claims share out of their combined unique word count. Words of two characters or fewer are excluded before scoring.

## Verification states

| State | Condition | Behavior |
|---|---|---|
| `dual_verified` | Jaccard score ≥ 0.65 | Claim shown; search terms from both models merged (union, up to 10) |
| `ambiguous` | Both ran, score < 0.65 | Claim set to `null` - nothing shown rather than showing an unverified claim |
| `single_model` | One model failed | Other model's result used; labelled with which model provided it |

When both models fail, the pipeline returns `ok: false` and the scan proceeds without claim data.

## Jaccard similarity

```
score = shared_words / total_unique_words
```

Threshold: **0.65** - claims that agree on the core assertion but differ in supporting detail typically score above this. Claims that are substantively different score well below.

## What "ambiguous" means

The `ambiguous` state is not a failure - it is honest signal. When Claude says "Schumer pledged to restore green tax credits and push for data center reforms requiring fair cost-sharing" and Mistral says "If Democrats retake the majority, he will reinstate green tax credits and impose stricter data center regulations", those are genuinely different characterizations. Rather than display one and discard the other, both are preserved in `_claude_claim` / `_mistral_claim` fields for debugging, and no claim is shown to the user.

## Pro claim-vs-record verification

This is separate from the dual-model extraction step.

For Pro users, after government records are fetched, each politician's extracted claim is sent to `POST /api/verify-claim` along with their actual legislative record (sponsored bills, roll-call votes, interest group ratings, VoteSmart key votes). Claude reads the real record and returns a structured verdict:

| Verdict | Meaning |
|---|---|
| `supported` | The record clearly backs the claim |
| `contradicted` | The record clearly opposes the claim |
| `mixed` | Some evidence supports, some contradicts |
| `insufficient` | Not enough relevant data in the record to judge |

The verification prompt instructs the model to base its verdict **only on the provided record** and not use outside knowledge. It must cite specific bill names, vote positions, or rating scores. If the claim is vague or not policy-related, it returns `insufficient`.

## Prompt consistency

The extraction prompt sent to both models is defined in a single source of truth: `server/providers/_shared.js`. Both providers import `buildPrompt` and `parseContent` from this file. The extension-side copy in `src/llm.js` is kept manually in sync (the two module systems cannot share a file directly).
