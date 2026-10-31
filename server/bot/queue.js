// Pending-review queue for bot-drafted replies, backed by the same Upstash
// Redis instance server/providers/store.js already uses. Deliberately NOT
// exposed over HTTP - CHANGELOG.md records that admin endpoints were
// removed from this server before as a security cleanup, so approval here
// is a local-only CLI (review.js), not a new route on the public API.
import { Redis } from "@upstash/redis";
import { randomUUID } from "node:crypto";
import { postReply } from "./twitterClient.js";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const QUEUE_SET_KEY = "bot:queue:ids";
const draftKey = (id) => `bot:queue:draft:${id}`;
const LAST_MENTION_KEY = "bot:lastMentionId";

/**
 * @param {{ mentionTweetId: string, mentionAuthor: string|null, articleUrl: string,
 *   memberName: string, verdict: string, explanation: string, replyText: string }} draft
 * @returns {Promise<string>} the queue entry's id
 */
export async function enqueueDraft(draft) {
  const id = randomUUID();
  await redis.set(draftKey(id), { ...draft, id, createdAt: new Date().toISOString() });
  await redis.sadd(QUEUE_SET_KEY, id);
  return id;
}

export async function listPendingDrafts() {
  const ids = await redis.smembers(QUEUE_SET_KEY);
  if (!ids.length) return [];
  const drafts = await Promise.all(ids.map((id) => redis.get(draftKey(id))));
  return drafts
    .filter(Boolean)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function rejectDraft(id) {
  await redis.del(draftKey(id));
  await redis.srem(QUEUE_SET_KEY, id);
}

/** Posts the approved draft's reply, then removes it from the queue. */
export async function approveDraft(id) {
  const draft = await redis.get(draftKey(id));
  if (!draft) throw new Error(`no pending draft with id ${id}`);
  await postReply(draft.replyText, draft.mentionTweetId);
  await redis.del(draftKey(id));
  await redis.srem(QUEUE_SET_KEY, id);
  return draft;
}

export async function getLastMentionId() {
  return redis.get(LAST_MENTION_KEY);
}

export async function setLastMentionId(id) {
  await redis.set(LAST_MENTION_KEY, id);
}
