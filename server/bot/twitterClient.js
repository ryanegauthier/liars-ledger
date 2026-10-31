// Thin wrapper around twitter-api-v2 - only the two operations the bot
// needs: read new mentions, post a reply. Uses OAuth 1.0a (four static keys)
// rather than OAuth 2.0 user-context, since OAuth 2.0 write access needs an
// interactive consent flow to mint/refresh tokens, which doesn't fit a
// long-running unattended bot.
import { TwitterApi } from "twitter-api-v2";

let _client = null;
let _botUserId = null;

function getClient() {
  if (_client) return _client;

  const { X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET } = process.env;
  if (!X_API_KEY || !X_API_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_SECRET) {
    throw new Error(
      "Missing X API credentials - set X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET in server/.env"
    );
  }

  _client = new TwitterApi({
    appKey: X_API_KEY,
    appSecret: X_API_SECRET,
    accessToken: X_ACCESS_TOKEN,
    accessSecret: X_ACCESS_SECRET,
  }).readWrite;

  return _client;
}

async function getBotUserId() {
  if (_botUserId) return _botUserId;
  const me = await getClient().v2.me();
  _botUserId = me.data.id;
  return _botUserId;
}

/**
 * Returns new mentions of the bot since sinceId (oldest first), each with
 * any expanded article URLs already resolved by the API - no manual t.co
 * redirect-following needed.
 *
 * @param {string|null} sinceId - last-processed tweet ID, or null for the
 *   first run (returns X's default recent-mentions window, not full history)
 * @returns {Promise<Array<{ id: string, text: string, authorUsername: string, urls: string[] }>>}
 */
export async function getNewMentions(sinceId) {
  const client = getClient();
  const botUserId = await getBotUserId();

  const params = {
    expansions: ["author_id"],
    "tweet.fields": ["entities", "created_at"],
    max_results: 25,
  };
  if (sinceId) params.since_id = sinceId;

  const timeline = await client.v2.userMentionTimeline(botUserId, params);

  const mentions = [];
  for (const tweet of timeline.tweets) {
    const urls = (tweet.entities?.urls || [])
      .map((u) => u.expanded_url || u.url)
      .filter(Boolean);
    const author = timeline.includes.author(tweet);
    mentions.push({
      id: tweet.id,
      text: tweet.text,
      authorUsername: author?.username || null,
      urls,
    });
  }

  // X returns newest-first; process oldest-first so sinceId tracking and
  // reply ordering both make sense.
  return mentions.reverse();
}

export async function postReply(text, inReplyToTweetId) {
  const client = getClient();
  return client.v2.reply(text, inReplyToTweetId);
}
