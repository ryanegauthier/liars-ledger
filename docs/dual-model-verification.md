---
title: Dual-Model Verification
nav_order: 3
---

# Dual-Model Verification

## Why two models?

Liar's Ledger uses two independent AI models to extract claims from articles:

- **Claude** (Anthropic) — US-based AI safety company, Constitutional AI research
- **Mistral** (Mistral AI) — French AI company, European training data, open-weights model

Using models from different companies with different training data reduces the risk of systematic bias. If both models independently extract the same claim about a politician, that claim is more defensible than if only one model saw it.

## How it works

Both models receive the same article text via the backend proxy. They each independently return:

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

Claims are then compared per politician using **Jaccard similarity** — the percentage of meaningful words the two claims share out of their combined unique word count.

## Verification states

| State | Condition | Display |
|---|---|---|
| ✓ Verified Statement | Jaccard score ≥ 0.55 | Green border, verified label |
| ⚠ Models Disagreed | Both ran, score < 0.55 | Amber border, both claims shown |
| Single model | One model failed | Plain italic claim |

## Jaccard similarity

```
score = shared_words / total_unique_words
```

Threshold: **0.55** — claims that agree on the core assertion but differ in supporting detail typically score above this. Claims that are substantively different score well below.

**Pronoun normalization** is applied before comparison — "He has called for a moratorium" and "Sanders has called for a moratorium" are treated as equivalent for scoring purposes.

## Prompt consistency

The prompt sent to both models is defined in a single source of truth: `server/providers/_shared.js`. The extension-side copy in `src/llm.js` is kept manually in sync. Both use `temperature: 0.0` for deterministic output.

## When ambiguous is correct

The `⚠ Models Disagreed` state is not a failure — it's honest signal. When Claude says "Schumer pledged to restore green tax credits and push for data center reforms requiring fair cost-sharing" and Mistral says "If Democrats retake the majority, he will reinstate green tax credits and impose stricter data center regulations", those are genuinely different characterizations worth surfacing to the reader.
