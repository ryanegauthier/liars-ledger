// Mention-triggered bot runner (v1 scope - see conversation this was built
// in: start with mentions, iterate to autonomous monitoring later). Single
// pass by default (suits an external scheduler - cron, Render Cron Job);
// pass --watch to loop locally during development.
//
// For each new mention with a linked article URL: runs the real analysis
// pipeline against the deployed backend, then enqueues a drafted reply for
// manual approval (server/bot/review.js) rather than posting automatically -
// deliberate, given this repo's own documented history of wrong-person
// resolution bugs and at least one confirmed-wrong VoteSmart data point
// (CLAUDE.md "Known sharp edges"). Revisit once the bot has a track record.
import "dotenv/config";
import { getNewMentions } from "./twitterClient.js";
import { runAnalysis, AnalysisSkipped } from "./runAnalysis.js";
import { enqueueDraft, getLastMentionId, setLastMentionId } from "./queue.js";

const POLL_INTERVAL_MS = 5 * 60 * 1000;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} - see server/.env.example`);
  return value;
}

async function pollOnce() {
  const apiBase = process.env.LL_API_BASE || "https://api.liarsledger.com";
  const botToken = requireEnv("LL_BOT_TOKEN");

  const sinceId = await getLastMentionId();
  const mentions = await getNewMentions(sinceId);

  if (!mentions.length) {
    console.log("No new mentions.");
    return;
  }
  console.log(`${mentions.length} new mention(s).`);

  for (const mention of mentions) {
    const articleUrl = mention.urls[0];
    if (!articleUrl) {
      console.log(`[${mention.id}] no linked URL in mention text - skipping.`);
      continue;
    }

    try {
      const result = await runAnalysis({ articleUrl, apiBase, botToken });
      const id = await enqueueDraft({
        mentionTweetId: mention.id,
        mentionAuthor: mention.authorUsername,
        articleUrl,
        memberName: result.memberName,
        verdict: result.verdict,
        explanation: result.explanation,
        replyText: result.replyText,
      });
      console.log(`[${mention.id}] queued draft ${id} - ${result.memberName}: ${result.verdict}`);
    } catch (e) {
      if (e instanceof AnalysisSkipped) {
        console.log(`[${mention.id}] skipped - ${e.message}`);
      } else {
        // Don't let one bad article/mention take down the whole poll.
        console.error(`[${mention.id}] analysis failed - ${e.message}`);
      }
    }
  }

  await setLastMentionId(mentions[mentions.length - 1].id);
}

async function main() {
  const watch = process.argv.includes("--watch");

  if (!watch) {
    await pollOnce();
    return;
  }

  console.log(`Watching for mentions every ${POLL_INTERVAL_MS / 1000}s. Ctrl+C to stop.`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await pollOnce().catch((e) => console.error("Poll failed:", e.message));
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
