// Local-only CLI for the bot's pending-review queue. Not an HTTP endpoint -
// see queue.js's header comment for why. Run from server/ (needs .env):
//
//   node bot/review.js list
//   node bot/review.js approve <id>
//   node bot/review.js reject <id>
import "dotenv/config";
import { listPendingDrafts, approveDraft, rejectDraft } from "./queue.js";

async function main() {
  const [command, id] = process.argv.slice(2);

  if (command === "list") {
    const drafts = await listPendingDrafts();
    if (!drafts.length) {
      console.log("No pending drafts.");
      return;
    }
    for (const d of drafts) {
      console.log(`\n[${d.id}] ${d.createdAt}`);
      console.log(`  Mention from @${d.mentionAuthor || "unknown"} (tweet ${d.mentionTweetId})`);
      console.log(`  Article: ${d.articleUrl}`);
      console.log(`  ${d.memberName} - ${d.verdict}`);
      console.log(`  Reply text: "${d.replyText}"`);
    }
    return;
  }

  if (command === "approve") {
    if (!id) throw new Error("usage: node bot/review.js approve <id>");
    const draft = await approveDraft(id);
    console.log(`Posted reply to tweet ${draft.mentionTweetId}: "${draft.replyText}"`);
    return;
  }

  if (command === "reject") {
    if (!id) throw new Error("usage: node bot/review.js reject <id>");
    await rejectDraft(id);
    console.log(`Rejected draft ${id} - not posted.`);
    return;
  }

  console.log("usage: node bot/review.js <list|approve|reject> [id]");
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
