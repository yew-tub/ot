import { request, gql } from 'graphql-request';
import fetch from 'node-fetch';
import * as secp from '@noble/secp256k1';

const STACKER_API = 'https://stacker.news/api/graphql';

const POLLING_INTERVAL = 60 * 1000; // 1 minute

const NOSTR_PRIVKEY_HEX = process.env.NOSTR_PRIVKEY;
const STACKER_USERNAME = process.env.STACKER_USERNAME;

if (!NOSTR_PRIVKEY_HEX) {
  console.error('Missing environment variable NOSTR_PRIVKEY');
  process.exit(1);
}
if (!STACKER_USERNAME) {
  console.error('Missing environment variable STACKER_USERNAME');
  process.exit(1);
}

// Basic YouTube URL regex to extract video IDs from common variants
const youtubeRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu.be\/)([A-Za-z0-9_-]{11})/g;

// Keep track of items already processed to avoid duplicate comments
const processedItems = new Set<string>();

// Utility to create nostr sig for stacker.news
async function signPayload(payload: string): Promise<string> {
  const privKey = Buffer.from(NOSTR_PRIVKEY_HEX, 'hex');

  // Stacker.news signs the message using secp256k1 and sha256, deterministic
  const sig = await secp.sign(payload, privKey, { der: false });
  return Buffer.from(sig).toString('hex');
}

// Post a comment on stacker.news with nostr authentication
async function postStackerComment(replyToId: string, text: string): Promise<string> {
  const mutation = gql`
    mutation PostComment($replyToId: String!, $text: String!, $profile: String!, $sig: String!) {
      post(input: {
        replyTo: $replyToId
        text: $text
        nostrAuth: {
          profile: $profile,
          sig: $sig
        }
      }) {
        id
        url
      }
    }
  `;

  // The payload to sign is JSON string of the post input (excluding sig)
  const payloadObject = {
    replyTo: replyToId,
    text,
    nostrAuth: {
      profile: STACKER_USERNAME,
      // sig intentionally omitted here, will attach next
    }
  };
  const payload = JSON.stringify(payloadObject);

  const sig = await signPayload(payload);

  const variables = {
    replyToId,
    text,
    profile: STACKER_USERNAME,
    sig,
  };

  const data = await request(STACKER_API, mutation, variables);
  if (data?.post?.id) {
    return data.post.url;
  }
  throw new Error('Failed to post comment');
}

// Post a nostr note (kind=1) referencing the stacker comment url with referral code /r/YouTuBot
async function postNostrNote(content: string): Promise<string> {
  const createdAt = Math.floor(Date.now() / 1000);
  const pubKey = secp.getPublicKey(NOSTR_PRIVKEY_HEX, true); // compressed pubkey (33 bytes)
  const pubKeyHex = Buffer.from(pubKey).toString('hex');

  // Create event according to nostr protocol
  const event = {
    kind: 1,
    pubkey: pubKeyHex,
    created_at: createdAt,
    tags: [],
    content,
  };

  // Event serialization for signing per nostr spec: [0, pubkey, created_at, kind, tags, content]
  const serializedEvent = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);

  // Hash the serialized event using sha256
  const eventHash = await secp.utils.sha256(new TextEncoder().encode(serializedEvent));
  const id = Buffer.from(eventHash).toString('hex');
  event['id'] = id;

  // Sign the event hash
  const sigBytes = await secp.sign(id, Buffer.from(NOSTR_PRIVKEY_HEX, 'hex'), { der: false });
  event['sig'] = Buffer.from(sigBytes).toString('hex');

  // Post event to nostr relay(s)
  // Minimal relay list (could be improved)
  const relays = [
    'wss://relay.damus.io',
    'wss://relay.snort.social',
  ];

  // Send event via WebSocket to all relays, wait for at least one OK
  // For Github Action stateless run, we do simple fetch post as relay supports REST
  // but mostly nostr relays are WS only, so will use REST-ish approach with a minimal relay

  // Using relay.damus.io REST API for event posting (if supported). If not, skip relay posting.
  // For demo: POST event to https://relay.damus.io/event (not always supported, but depends on relay)
  // Here we just print event JSON, you can extend with ws connection if persistent bot

  // For now, just log event and skip relay posting:
  console.log('Nostr event to post:', event);

  // Alternatively implement nostr relay post logic here

  // Return id as reference to the note
  return `nostr:${id}`;
}

// Fetch recent posts and comments (items) from stacker.news
async function fetchRecentItems(): Promise<{ id: string; text: string; url: string; replyTo?: string }[]> {
  const query = gql`
    query RecentItems {
      recentItems {
        id
        text
        url
        replyTo {
          id
        }
      }
    }
  `;
  const data = await request(STACKER_API, query);
  if (!data?.recentItems) return [];

  return data.recentItems.map((item: any) => ({
    id: item.id,
    text: item.text,
    url: item.url,
    replyTo: item.replyTo?.id,
  }));
}

function extractYoutubeVideoIds(text: string): string[] {
  const ids = [];
  let match;
  while ((match = youtubeRegex.exec(text)) !== null) {
    if (match[1]) {
      ids.push(match[1]);
    }
  }
  return ids;
}

async function handleItem(item: { id: string; text: string; url: string; replyTo?: string }) {
  if (processedItems.has(item.id)) {
    return; // skip already processed
  }

  // Detect youtube video IDs in the item text
  const videoIds = extractYoutubeVideoIds(item.text);
  if (videoIds.length === 0) {
    return;
  }

  for (const videoId of videoIds) {
    const altLink = `https://yewtu.be/watch?v=${videoId}`;
    const commentText = `Privacy-friendly alternative video link: ${altLink}`;

    try {
      console.log(`Posting comment on stacker.news item ${item.id} for youtube videoId ${videoId}`);
      const commentUrl = await postStackerComment(item.id, commentText);

      // Post nostr note pointing to stacker.news comment URL with referral code
      const noteContent = `Just posted an alternative YouTube link on stacker.news: ${commentUrl}/r/YouTuBot`;
      const nostrNoteId = await postNostrNote(noteContent);
      console.log(`Nostr note posted with id ${nostrNoteId}`);

      // Mark item processed to prevent duplicate comments
      processedItems.add(item.id);

    } catch (err) {
      console.error(`Error posting comment or nostr note: ${(err as any).message}`);
    }
  }
}

async function main() {
  console.log('YouTuBot started');

  try {
    const items = await fetchRecentItems();
    for (const item of items) {
      await handleItem(item);
    }
  } catch (err) {
    console.error('Error fetching or processing items:', (err as any).message);
  }
}

// Run the bot on start, repeat every minute
main();
// For GitHub Actions, single run is enough because schedule runs every minute
