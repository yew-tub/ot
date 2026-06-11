#!/usr/bin/env node

/**
 * Stacker.News YouTube Link Bot
 * Monitors for YouTube links and posts yewtu.be alternatives
 * Enhanced with detailed debugging and proper recent items fetching
 */

const { getPublicKey, finalizeEvent, verifyEvent, nip19, SimplePool } = require('nostr-tools');
const { GraphQLClient } = require('graphql-request');
const fs = require('fs').promises;
const path = require('path');
const WebSocket = require('ws');
global.WebSocket = WebSocket;

// Configuration
const CONFIG = {
  STACKER_NEWS_API: 'https://stacker.news/api/graphql',
  STACKER_NEWS_BASE: 'https://stacker.news',
  COMMENT_TEMPLATE: '🔗 Privacy-friendly: {link}',
  COMMENT_TEMPLATE_MULTI: '🔗 Privacy-friendly video links:\n{videoLinks}',
  NOSTR_NOTE_TEMPLATE: '{nprofileLink} posted "{title}"\n\nWatch the {videoLabel} {stackerLink}\n\n#stackernews #watch #privacy #video',
  SCAN_LIMIT: 50,
  COMMENT_LIMIT: 3,
  COMMENT_DELAY: 21000,
  MAX_CONSECUTIVE_MISSES: 500,
  MIN_STACKED_VALUE: 123,
  RATE_LIMIT_DELAY: 2000,
  MIN_POST_VALUE: 123,
  STATE_FILE: './.bot-state.json',
  DEBUG: process.env.DEBUG === 'true' || process.env.NODE_ENV !== 'production',
  BACKFILL_ENABLED: process.env.BACKFILL !== 'false',
  BACKFILL_DEPTH: parseInt(process.env.BACKFILL_DEPTH || '21', 10),
  INVIDIOUS_INSTANCES: (process.env.INVIDIOUS_INSTANCES || [
    'https://yewtu.be',
    'https://inv.nadeko.net',
    'https://vid.puffyan.us',
    'https://invidious.weblibre.org',
    'https://invidious.projectsegfau.lt',
    'https://invidious.privacydev.net',
    'https://invidious.slipfox.xyz',
    'https://y.zuut.xyz'
  ].join(',')).split(',').map(s => s.trim()).filter(Boolean),
  NOSTR_RELAYS: [
    'wss://relay.stacker.news',
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.nostr.band',
    'wss://nostr.wine'
  ]
};

// YouTube URL patterns
const YOUTUBE_PATTERNS = [
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/gi,
  /(?:https?:\/\/)?(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]{11})/gi,
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/gi,
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/v\/([a-zA-Z0-9_-]{11})/gi,
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/gi
];

// GraphQL queries — SN uses custom types like Limit! (not Int) for limit args
const BOT_USERNAME = 'YewTuBot';
const QUERIES = {
  // Primary items query — returns recent items
  RECENT_ITEMS: `
    query recentItems($limit: Limit!, $cursor: String) {
      items(limit: $limit, cursor: $cursor, sort: "new") {
        items {
          id
          title
          text
          url
          createdAt
          updatedAt
          sats
          credits
          boost
          ncomments
          commentCost
          user { name id optional { nostrAuthPubkey } }
          sub { name }
          comments {
            comments {
              id
              user { name }
            }
          }
        }
        cursor
      }
    }
  `,

  // Wallet balance query
  ME_WALLET: `
    {
      me {
        id
        name
        privates {
          credits
          sats
        }
      }
    }
  `,

  // Comment mutation — uses parentId to create a new comment on a post
  POST_COMMENT: `
    mutation upsertComment($parentId: ID!, $text: String!) {
      upsertComment(parentId: $parentId, text: $text) {
        id
      }
    }
  `
};

// Debug logging utility
class Logger {
  static log(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
    
    console.log(`${prefix} ${message}`);
    if (data && CONFIG.DEBUG) {
      console.log(`${prefix} Data:`, JSON.stringify(data, null, 2));
    }
  }

  static debug(message, data = null) {
    if (CONFIG.DEBUG) {
      this.log('DEBUG', message, data);
    }
  }

  static info(message, data = null) {
    this.log('INFO', message, data);
  }

  static warn(message, data = null) {
    this.log('WARN', message, data);
  }

  static error(message, data = null) {
    this.log('ERROR', message, data);
  }

  static step(stepNumber, totalSteps, description) {
    this.info(`[STEP ${stepNumber}/${totalSteps}] ${description}`);
  }
}

// Helper function to convert nsec1 to hex
function nsecToHex(nsecKey) {
  try {
    const decoded = nip19.decode(nsecKey);
    if (decoded.type === 'nsec') {
      return decoded.data;
    } else {
      throw new Error('Invalid nsec key type');
    }
  } catch (error) {
    throw new Error(`Failed to decode nsec key: ${error.message}`);
  }
}

// Extract name=value pairs from Set-Cookie headers
function extractSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  }
  const val = headers.get('set-cookie');
  return val ? val.split(',').map(c => c.split(';')[0]).join('; ') : '';
}

// Create NIP-98 Authorization header value
function createNip98AuthHeader(signedEvent) {
  return `Nostr ${Buffer.from(JSON.stringify(signedEvent)).toString('base64')}`;
}

// Sign a NIP-98 event for a given URL + method
function signNip98Event(url, method, sk, pk) {
  const event = {
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['u', url], ['method', method]],
    content: '',
    pubkey: pk
  };
  return finalizeEvent(event, sk);
}

// Filter out cookies that would interfere with auth (e.g. signin)
function sanitizeCookies(cookieStr) {
  if (!cookieStr) return '';
  return cookieStr.split('; ').filter(c => {
    const name = c.split('=')[0];
    return !['signin'].includes(name);
  }).join('; ');
}

class StackerNewsBot {
  constructor() {
    Logger.info('Initializing StackerNewsBot...');
    Logger.debug('Configuration', CONFIG);
    
    this.privateKey = this.getPrivateKey();
    this.publicKey = getPublicKey(this.privateKey);
    this.client = new GraphQLClient(CONFIG.STACKER_NEWS_API);
    this.nostrPool = new SimplePool();
    this.processedPosts = new Set();
    this.commentedPosts = new Set();
    this.isRunning = false;
    this.workingQuery = null;
    this.sessionCookies = null;
    this.creditBalance = 0;
    
    Logger.info('Bot initialized successfully', {
      publicKey: this.publicKey,
      apiEndpoint: CONFIG.STACKER_NEWS_API
    });
  }

  getPrivateKey() {
    Logger.debug('Getting private key from environment...');
    let privateKey = process.env.NOSTR_PRIVATE_KEY;
    
    if (!privateKey) {
      throw new Error('NOSTR_PRIVATE_KEY environment variable is required');
    }
    
    // Convert nsec1 to hex if needed
    if (privateKey.startsWith('nsec1')) {
      Logger.info('Converting nsec1 private key to hex format...');
      privateKey = nsecToHex(privateKey);
      Logger.debug('Private key converted successfully');
    }
    
    return privateKey;
  }

  async loadState() {
    Logger.step(1, 7, 'Loading bot state');
    try {
      const stateData = await fs.readFile(CONFIG.STATE_FILE, 'utf8');
      const state = JSON.parse(stateData);
      this.processedPosts = new Set(state.processedPosts || []);
      this.commentedPosts = new Set(state.commentedPosts || []);
      this.workingQuery = state.workingQuery || null;

      if (process.env.RESCAN === 'true') {
        const wasProcessed = this.processedPosts.size;
        const wasCommented = this.commentedPosts.size;
        this.processedPosts.clear();
        this.commentedPosts.clear();
        Logger.info(`🧹 RESCAN=true — cleared state (was ${wasProcessed} processed, ${wasCommented} commented)`);
      }
      
      Logger.info(`State loaded successfully`, {
        processedPostsCount: this.processedPosts.size,
        commentedPostsCount: this.commentedPosts.size,
        hasWorkingQuery: !!this.workingQuery,
        workingQuery: this.workingQuery?.name || 'none'
      });
    } catch (error) {
      Logger.info('No previous state found, starting fresh');
    }
  }

  async saveState() {
    Logger.debug('Saving bot state...');
    const state = {
      processedPosts: Array.from(this.processedPosts),
      commentedPosts: Array.from(this.commentedPosts),
      workingQuery: this.workingQuery,
      lastRun: new Date().toISOString()
    };
    
    await fs.writeFile(CONFIG.STATE_FILE, JSON.stringify(state, null, 2));
    Logger.info('State saved successfully', {
      processedPostsCount: this.processedPosts.size,
      commentedPostsCount: this.commentedPosts.size,
      lastRun: state.lastRun
    });
  }

  async makeGraphQLRequest(query, variables = {}) {
    Logger.debug('Making GraphQL request', {
      queryPreview: query.slice(0, 100) + '...',
      variables
    });
    
    try {
      const response = await this.client.request(query, variables);
      Logger.debug('GraphQL request successful', {
        responseKeys: Object.keys(response || {}),
        responseSize: JSON.stringify(response || {}).length
      });
      return response;
    } catch (error) {
      Logger.error(`GraphQL request failed: ${error.message}`, {
        error: {
          message: error.message,
          response: error.response?.errors,
          status: error.response?.status
        },
        request: {
          queryPreview: query.slice(0, 200) + '...',
          variables
        }
      });
      throw error;
    }
  }

  async findWorkingQuery() {
    Logger.step(2, 7, 'Finding working query for recent items');

    if (this.workingQuery) {
      Logger.info(`Using cached working query: ${this.workingQuery.name}`);
      return this.workingQuery;
    }

    // SN uses Limit! custom type, not Int — try one direct query
    Logger.info('Testing RECENT_ITEMS query...');
    try {
      const response = await this.makeGraphQLRequest(QUERIES.RECENT_ITEMS, {
        limit: CONFIG.SCAN_LIMIT
      });

      if (response?.items?.items?.length) {
        const items = response.items.items;
        Logger.info(`✓ RECENT_ITEMS works — got ${items.length} items`);

        this.workingQuery = {
          name: 'RECENT_ITEMS',
          query: QUERIES.RECENT_ITEMS,
          variables: { limit: CONFIG.SCAN_LIMIT },
          description: 'Default items query with Limit! type'
        };

        return this.workingQuery;
      }
    } catch (error) {
      Logger.error(`RECENT_ITEMS query failed`, { error: error.message });
    }

    throw new Error('No working query found for fetching recent items');
  }

  extractYouTubeId(text) {
    if (!text) return null;
    
    Logger.debug('Extracting YouTube ID from text', { textLength: text.length });
    
    for (let i = 0; i < YOUTUBE_PATTERNS.length; i++) {
      const pattern = YOUTUBE_PATTERNS[i];
      pattern.lastIndex = 0;
      const match = pattern.exec(text);
      if (match) {
        Logger.debug(`YouTube ID found with pattern ${i + 1}`, {
          videoId: match[1],
          fullMatch: match[0]
        });
        return match[1];
      }
    }
    
    Logger.debug('No YouTube ID found in text');
    return null;
  }

  extractAllYouTubeIds(text) {
    if (!text) return [];

    Logger.debug('Extracting all YouTube IDs from text', { textLength: text.length });

    const results = [];
    for (let i = 0; i < YOUTUBE_PATTERNS.length; i++) {
      const pattern = new RegExp(YOUTUBE_PATTERNS[i].source, 'gi');
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const videoId = match[1];
        let url = match[0];
        if (!url.startsWith('http')) {
          url = 'https://' + url;
        }
        if (!results.some(r => r.id === videoId)) {
          results.push({ id: videoId, url });
        }
      }
    }

    Logger.debug('YouTube links found', { count: results.length });
    return results;
  }

  async fetchVideoTitle(videoId) {
    try {
      const res = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
      const data = await res.json();
      return data?.title || null;
    } catch {
      return null;
    }
  }

  pickInvidiousInstance() {
    const instances = CONFIG.INVIDIOUS_INSTANCES;
    return instances[Math.floor(Math.random() * instances.length)];
  }

  convertToInvidious(originalUrl, videoId) {
    Logger.debug('Converting YouTube URL to Invidious instance', {
      originalUrl,
      videoId
    });

    try {
      const url = new URL(originalUrl);
      const searchParams = new URLSearchParams(url.search);
      const instance = this.pickInvidiousInstance();

      let invidiousUrl = `${instance}/watch?v=${videoId}`;
      if (searchParams.has('t')) {
        invidiousUrl += `&t=${searchParams.get('t')}`;
      }

      Logger.debug('URL conversion successful', { invidiousUrl, instance });
      return invidiousUrl;
    } catch (error) {
      Logger.warn('URL parsing failed, using fallback', { error: error.message });
      return `${CONFIG.INVIDIOUS_INSTANCES[0]}/watch?v=${videoId}`;
    }
  }

  async authenticateWithNostr() {
    Logger.step(3, 7, 'Authenticating with Stacker.News via Nostr');

    try {
      // Use pre-authenticated session cookies if provided
      if (process.env.SESSION_COOKIES) {
        Logger.info('Using SESSION_COOKIES from environment…');
        this.client.setHeader('Cookie', process.env.SESSION_COOKIES);
        const meResult = await this.client.request(`{ me { id name } }`);
        if (meResult?.me?.id) {
          this.sessionCookies = process.env.SESSION_COOKIES;
          Logger.info(`✅ Reused session as @${meResult.me.name} (id=${meResult.me.id})`);
          return;
        }
        Logger.warn('SESSION_COOKIES expired or invalid, re-authenticating…');
      }

      // Step 1: Get k1 challenge from createAuth mutation
      Logger.debug('Requesting auth challenge (k1)…');
      const authResult = await this.makeGraphQLRequest(`
        mutation createAuth {
          createAuth {
            k1
          }
        }
      `);
      const k1 = authResult?.createAuth?.k1;
      if (!k1) {
        throw new Error('No k1 challenge received from createAuth');
      }
      Logger.info('Auth challenge received', { k1: k1.substring(0, 8) + '…' });

      // Step 2: Create and sign NIP-98 event (kind 27235)
      Logger.debug('Signing NIP-98 auth event…');
      const authEvent = {
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['challenge', k1],
          ['u', 'https://stacker.news'],
          ['method', 'GET']
        ],
        content: 'Stacker News Authentication',
        pubkey: this.publicKey
      };
      const signedEvent = finalizeEvent(authEvent, this.privateKey);
      Logger.info('Auth event signed', { eventId: signedEvent.id });

      // Step 3: GET CSRF token from NextAuth endpoint
      Logger.debug('Fetching CSRF token…');
      const csrfUrl = `${CONFIG.STACKER_NEWS_BASE}/api/auth/csrf`;
      const csrfResp = await fetch(csrfUrl, {
        headers: { Accept: 'application/json' }
      });

      if (csrfResp.status === 200) {
        // Standard path: CSRF works, complete via callback
        const csrfData = await csrfResp.json();
        const csrfToken = csrfData.csrfToken;
        const mergedCookies = extractSetCookieHeaders(csrfResp.headers);
        const cleanCookies = sanitizeCookies(mergedCookies);
        Logger.debug('CSRF token obtained', {
          csrfToken: csrfToken.substring(0, 8) + '…',
          cookieCount: cleanCookies ? cleanCookies.split('; ').length : 0
        });

        // Step 4: POST to Nostr callback with CSRF token + signed event
        Logger.debug('Completing auth via Nostr callback…');
        const callbackUrl = `${CONFIG.STACKER_NEWS_BASE}/api/auth/callback/nostr`;
        let callbackResponse;
        try {
          callbackResponse = await fetch(callbackUrl, {
            method: 'POST',
            redirect: 'manual',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              ...(cleanCookies ? { Cookie: cleanCookies } : {})
            },
            body: JSON.stringify({
              csrfToken,
              event: JSON.stringify(signedEvent),
              redirect: false
            })
          });
        } catch (fetchErr) {
          throw new Error(`Callback fetch failed (network): ${fetchErr.message}`);
        }

        Logger.debug('Callback response', {
          status: callbackResponse.status,
          location: callbackResponse.headers.get('location'),
          headers: Object.fromEntries([...callbackResponse.headers])
        });

        const sessionCookies = extractSetCookieHeaders(callbackResponse.headers);
        if (sessionCookies) {
          this.sessionCookies = sessionCookies;
          this.client.setHeader('Cookie', sessionCookies);
          Logger.info('Session cookies set on GraphQL client', {
            cookies: sessionCookies.split('; ').map(c => c.split('=')[0])
          });
        } else {
          Logger.warn('No session cookies received — auth might not have succeeded');
        }
      }

      // If CSRF failed or no session cookies yet, try NIP-98 auth directly on GraphQL
      if (!this.sessionCookies) {
        Logger.info('CSRF unavailable (WAF likely blocking), trying NIP-98 auth on GraphQL…');
        const nip98Event = signNip98Event(
          CONFIG.STACKER_NEWS_API, 'POST', this.privateKey, this.publicKey
        );
        const authHeader = createNip98AuthHeader(nip98Event);
        const testClient = new GraphQLClient(CONFIG.STACKER_NEWS_API, {
          headers: { Authorization: authHeader }
        });
        const meResult = await testClient.request(`{ me { id name } }`);
        if (meResult?.me?.id) {
          this.client.setHeader('Authorization', authHeader);
          Logger.info(`✅ Authenticated via NIP-98 as @${meResult.me.name} (id=${meResult.me.id})`);
        } else {
          throw new Error('NIP-98 auth failed — me query returned null');
        }
      }

      // Verify auth by querying me
      Logger.debug('Verifying auth…');
      const meResult = await this.client.request(`{ me { id name } }`);
      if (meResult?.me?.id) {
        Logger.info(`✅ Authenticated as @${meResult.me.name} (id=${meResult.me.id})`);
      } else {
        throw new Error('me query returned null after all auth attempts');
      }

      Logger.info('✅ Nostr authentication completed');
      return signedEvent;
    } catch (error) {
      Logger.error('❌ Authentication failed', { error: error.message });
      throw error;
    }
  }

  async fetchRecentPosts() {
    Logger.step(4, 7, 'Fetching recent posts');
    
    try {
      // Find a working query if we don't have one
      if (!this.workingQuery) {
        await this.findWorkingQuery();
      }

      Logger.info(`Using query: ${this.workingQuery.name}`, {
        query: this.workingQuery.description,
        variables: this.workingQuery.variables
      });
      
      const response = await this.makeGraphQLRequest(this.workingQuery.query, this.workingQuery.variables);
      
      // Extract items
      let items = [];
      if (response && response.items && response.items.items && Array.isArray(response.items.items)) {
        items = response.items.items.filter(item => item && item.id);
        
        // CRITICAL FIX: Sort by createdAt descending to ensure newest first
        items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      }

      Logger.info(`Successfully fetched ${items.length} items`);
      
      // Detailed analysis for debugging
      if (items.length > 0) {
        const newestItem = items[0];
        const oldestItem = items[items.length - 1];
        const newestTime = new Date(newestItem.createdAt);
        const oldestTime = new Date(oldestItem.createdAt);
        const timeDiff = newestTime - oldestTime;
        const minutesAgo = Math.round((Date.now() - newestTime.getTime()) / (1000 * 60));
        
        Logger.info('Fetched items analysis', {
          newestItem: {
            id: newestItem.id,
            title: newestItem.title?.slice(0, 50) + (newestItem.title?.length > 50 ? '...' : ''),
            createdAt: newestItem.createdAt,
            user: newestItem.user?.name,
            minutesAgo: minutesAgo
          },
          oldestItem: {
            id: oldestItem.id,
            title: oldestItem.title?.slice(0, 50) + (oldestItem.title?.length > 50 ? '...' : ''),
            createdAt: oldestItem.createdAt,
            user: oldestItem.user?.name
          },
          timeSpan: {
            minutes: Math.round(timeDiff / (1000 * 60)),
            hours: Math.round(timeDiff / (1000 * 3600)),
            isNewestFirst: newestTime >= oldestTime,
            freshness: minutesAgo < 60 ? 'very fresh' : minutesAgo < 720 ? 'recent' : 'older'
          }
        });
        
        // Warning if data seems stale
        if (minutesAgo > 120) { // 2 hours
          Logger.warn(`⚠️  Newest item is ${minutesAgo} minutes old - may not be getting truly recent items`);
        }
        
        // Show recent items sample for debugging
        if (items.length >= 5) {
          Logger.debug('Recent items sample (newest first)', items.slice(0, 5).map(item => ({
            id: item.id,
            title: item.title?.slice(0, 30) + '...',
            createdAt: item.createdAt,
            minutesAgo: Math.round((Date.now() - new Date(item.createdAt).getTime()) / (1000 * 60)),
            hasUrl: !!item.url,
            hasText: !!item.text
          })));
        }
      }
      
      return items;
    } catch (error) {
      Logger.error('Error fetching posts', { error: error.message });
      
      // If our working query suddenly fails, reset it
      if (this.workingQuery) {
        Logger.warn('Working query failed, will rediscover next time');
        this.workingQuery = null;
      }
      
      return [];
    }
  }

  async fetchAllPosts(maxItems) {
    Logger.info(`Backfill: fetching up to ${maxItems} items via cursor pagination`);

    if (!this.workingQuery) {
      await this.findWorkingQuery();
    }

    const allItems = [];
    let cursor = null;
    let pages = 0;

    while (allItems.length < maxItems) {
      const remaining = maxItems - allItems.length;
      const limit = Math.min(CONFIG.SCAN_LIMIT, remaining);
      const vars = { limit, ...(cursor ? { cursor } : {}) };

      try {
        const response = await this.makeGraphQLRequest(this.workingQuery.query, vars);
        const items = response?.items?.items?.filter(item => item && item.id) || [];
        if (items.length === 0) break;

        allItems.push(...items);
        pages++;
        cursor = response.items.cursor;

        Logger.info(`Backfill page ${pages}: got ${items.length} items (total: ${allItems.length}/${maxItems})`);

        if (!cursor) {
          Logger.info('Backfill: no more cursor, reached end');
          break;
        }

        await this.sleep(CONFIG.RATE_LIMIT_DELAY);
      } catch (error) {
        Logger.error('Backfill page fetch failed', { error: error.message, page: pages });
        break;
      }
    }

    Logger.info(`Backfill complete: ${allItems.length} items across ${pages} pages`);
    return allItems;
  }

  async publishNostrNote(title, postId, invidiousUrl, username, userHexPubkey, videoCount = 1, commentId) {
    Logger.debug('Publishing Nostr note', { title, postId, invidiousUrl, username, hasPubkey: !!userHexPubkey, videoCount, commentId });
    
    try {
      // Build Stacker.News comment link, pointing to the bot's specific comment
      const stackerLink = `${CONFIG.STACKER_NEWS_BASE}/items/${postId}/r/YewTuBot${commentId ? `?commentId=${commentId}` : ''}`;
      
      // Build nostr link from user's hex pubkey → npub, fallback to @username
      let nprofileLink;
      if (userHexPubkey) {
        try {
          const npub = nip19.npubEncode(userHexPubkey);
          nprofileLink = `nostr:${npub}`;
        } catch (e) {
          nprofileLink = `@${username || 'anonymous'}`;
        }
      } else {
        nprofileLink = `@${username || 'anonymous'}`;
      }
      
      // Create note content
      const noteContent = CONFIG.NOSTR_NOTE_TEMPLATE
        .replace('{title}', title || 'Untitled Post')
        .replace('{stackerLink}', stackerLink)
        .replace('{nprofileLink}', nprofileLink)
        .replace('{videoLabel}', videoCount > 1 ? 'videos' : 'video');

      // Create Nostr event
      const noteEvent = {
        kind: 1, // Text note
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['t', 'stackernews'],
          ['t', 'youtube'],
          ['t', 'privacy'],
          ['t', 'yewtubot'],
          ['r', stackerLink],
          ['r', invidiousUrl]
        ],
        content: noteContent,
        pubkey: this.publicKey
      };

      // Sign the event
      const signedEvent = finalizeEvent(noteEvent, this.privateKey);
      
      Logger.info(`Publishing Nostr note for post ${postId}`, {
        eventId: signedEvent.id,
        contentLength: noteContent.length,
        tagCount: signedEvent.tags.length
      });
      
      // Publish to relays
      const publishPromises = this.nostrPool.publish(CONFIG.NOSTR_RELAYS, signedEvent);
      
      const results = await Promise.allSettled(publishPromises);
      
      // Count successful publications
      const successful = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;
      
      Logger.info(`Nostr note published`, {
        successful,
        failed,
        total: CONFIG.NOSTR_RELAYS.length,
        successRate: successful > 0 ? `${Math.round(successful / CONFIG.NOSTR_RELAYS.length * 100)}%` : '0%'
      });
      
      if (failed > 0) {
        const failedRelays = results
          .map((r, i) => r.status === 'rejected' ? { relay: CONFIG.NOSTR_RELAYS[i], error: r.reason?.message || r.reason } : null)
          .filter(Boolean);
        Logger.warn('Failed relay publications', failedRelays);
      }
      
      return { successful, failed, total: CONFIG.NOSTR_RELAYS.length };
    } catch (error) {
      Logger.error('Error publishing Nostr note', { error: error.message, postId });
      throw error;
    }
  }

  async postComment(postId, text) {
    Logger.debug('Posting comment', { postId, textLength: text.length });
    
    try {
      const response = await this.client.request(QUERIES.POST_COMMENT, {
        parentId: postId,
        text: text
      });
      Logger.debug('Comment posted successfully', { commentId: response.upsertComment?.id });
      return response.upsertComment;
    } catch (error) {
      Logger.error('Error posting comment', { error: error.message, postId, textPreview: text.slice(0, 50) });
      throw error;
    }
  }

  async checkWalletBalance() {
    try {
      Logger.debug('Checking wallet balance...');
      const response = await this.makeGraphQLRequest(QUERIES.ME_WALLET);
      const privates = response?.me?.privates;
      if (!privates) {
        Logger.warn('Could not fetch wallet balance, assuming 0 credits');
        this.creditBalance = 0;
        return 0;
      }
      this.creditBalance = privates.credits || 0;
      Logger.info(`💰 Wallet balance: ${this.creditBalance} mcredits${privates.sats ? `, ${privates.sats} msats` : ''}`);
      return this.creditBalance;
    } catch (error) {
      Logger.warn('Error fetching wallet balance, assuming 0 credits', { error: error.message });
      this.creditBalance = 0;
      return 0;
    }
  }

  async processPost(post) {
    Logger.debug(`Processing post ${post.id}`, {
      id: post.id,
      title: post.title?.slice(0, 50) + (post.title?.length > 50 ? '...' : ''),
      hasText: !!post.text,
      hasUrl: !!post.url,
      createdAt: post.createdAt,
      user: post.user?.name
    });

    if (this.commentedPosts.has(post.id)) {
      Logger.debug(`Post ${post.id} already commented, skipping`);
      return false;
    }

    const content = `${post.title || ''} ${post.text || ''} ${post.url || ''}`;
    Logger.debug(`Checking content for YouTube links`, {
      contentLength: content.length,
      contentPreview: content.slice(0, 100) + (content.length > 100 ? '...' : '')
    });
    
    const allVideos = this.extractAllYouTubeIds(content);
    
    if (allVideos.length === 0) {
      Logger.debug(`No YouTube links found in post ${post.id}`);
      this.processedPosts.add(post.id);
      return false;
    }

    Logger.info(`📺 ${allVideos.length} YouTube link(s) detected in post ${post.id}`, {
      videoIds: allVideos.map(v => v.id)
    });

    // Check if bot already commented via API (catches cases not in local state)
    if (post.comments?.comments?.some(c => c.user?.name === BOT_USERNAME)) {
      Logger.info(`Post ${post.id} already has a comment from @${BOT_USERNAME}, skipping`);
      this.commentedPosts.add(post.id);
      return false;
    }

    try {
      // Convert all videos to Invidious and optionally fetch titles
      const invidiousLinks = [];
      for (const video of allVideos) {
        const invidiousUrl = this.convertToInvidious(video.url, video.id);
        const title = await this.fetchVideoTitle(video.id);
        invidiousLinks.push({ ...video, invidiousUrl, title });
      }

      // Build comment text
      let commentText;
      if (invidiousLinks.length === 1) {
        commentText = CONFIG.COMMENT_TEMPLATE.replace('{link}', invidiousLinks[0].invidiousUrl);
      } else {
        const lines = invidiousLinks.map(v => {
          const label = v.title ? `"${v.title}"` : v.invidiousUrl;
          return `- ${label}: ${v.invidiousUrl}`;
        });
        commentText = CONFIG.COMMENT_TEMPLATE_MULTI.replace('{videoLinks}', lines.join('\n'));
      }

      Logger.info(`🔄 Processing ${invidiousLinks.length} YouTube link(s) in post ${post.id}`, {
        links: invidiousLinks.map(v => ({ id: v.id, title: v.title, url: v.invidiousUrl })),
        postDetails: {
          title: post.title?.slice(0, 50) + (post.title?.length > 50 ? '...' : ''),
          createdAt: post.createdAt,
          user: post.user?.name || 'Unknown',
          age: Math.round((Date.now() - new Date(post.createdAt).getTime()) / (1000 * 60)) + ' minutes ago'
        }
      });

      // Check if we can afford to comment
      const cost = post.commentCost || 0;
      if (cost > this.creditBalance) {
        Logger.info(`⏭️  Skipping post ${post.id}: comment costs ${cost} mcredits but balance is ${this.creditBalance}`);
        this.processedPosts.add(post.id);
        return false;
      }
      if (cost > 0) {
        Logger.info(`💸 Comment will cost ${cost} mcredit(s) (balance: ${this.creditBalance})`);
      }

      // Check stacked value: sats + credits - boost - commentCost must be >= MIN_STACKED_VALUE
      const stackedValue = (post.sats || 0) + (post.credits || 0) - (post.boost || 0) - cost;
      if (stackedValue < CONFIG.MIN_STACKED_VALUE) {
        Logger.info(`⏭️  Skipping post ${post.id}: stacked value ${stackedValue} is below minimum ${CONFIG.MIN_STACKED_VALUE} (sats=${post.sats || 0}, credits=${post.credits || 0}, boost=${post.boost || 0}, cost=${cost})`);
        this.processedPosts.add(post.id);
        return false;
      }
      Logger.info(`📊 Stacked value ${stackedValue} meets minimum threshold of ${CONFIG.MIN_STACKED_VALUE}`);

      // Post comment on Stacker.News
      Logger.info(`💬 Posting comment on post ${post.id}...`);
      const comment = await this.postComment(post.id, commentText);
      const commentId = comment?.id;
      Logger.info(`✅ Comment posted successfully on post ${post.id}`, { commentId });

      // Deduct the cost from our cached balance
      this.creditBalance -= cost;

      // Publish Nostr note (pass first invidious URL for tagging, video count for label)
      Logger.info(`📡 Publishing Nostr note for post ${post.id}...`);
      const nostrResult = await this.publishNostrNote(
        post.title, post.id, invidiousLinks[0].invidiousUrl,
        post.user?.name, post.user?.optional?.nostrAuthPubkey, invidiousLinks.length,
        commentId
      );
      Logger.info(`✅ Nostr note published for post ${post.id}`, nostrResult);

      this.processedPosts.add(post.id);
      this.commentedPosts.add(post.id);

      Logger.info(`🎉 Successfully processed post ${post.id}`, {
        actions: ['comment_posted', 'nostr_note_published'],
        videosCount: invidiousLinks.length,
        nostrRelaysSuccess: nostrResult.successful
      });

      return true;
    } catch (error) {
      Logger.error(`❌ Failed to process post ${post.id}`, {
        error: error.message,
        videosFound: allVideos.length,
        videoIds: allVideos.map(v => v.id)
      });

      return false;
    }
  }

  async run() {
    if (this.isRunning) {
      Logger.warn('Bot is already running');
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();
    
    try {
      Logger.info('🚀 Starting Stacker.News YouTube Bot (Enhanced Debug Mode)');
      Logger.info('Bot Configuration', {
        publicKey: this.publicKey,
        scanLimit: CONFIG.SCAN_LIMIT,
        commentLimit: CONFIG.COMMENT_LIMIT,
        commentDelay: CONFIG.COMMENT_DELAY / 1000 + 's',
        maxMisses: CONFIG.MAX_CONSECUTIVE_MISSES,
        rateLimit: CONFIG.RATE_LIMIT_DELAY + 'ms',
        debugMode: CONFIG.DEBUG,
        backfillMode: CONFIG.BACKFILL_ENABLED,
        backfillDepth: CONFIG.BACKFILL_DEPTH,
        invidiousInstances: CONFIG.INVIDIOUS_INSTANCES.length,
        nostrRelaysCount: CONFIG.NOSTR_RELAYS.length
      });
      
      // Load previous state
      await this.loadState();
      
      // Authenticate with Nostr
      await this.authenticateWithNostr();
      
      // Ensure we have a working query before fetching
      // Re-derive if cached query is outdated (missing newer fields)
      if (!this.workingQuery || (this.workingQuery.name === 'RECENT_ITEMS' && (!this.workingQuery.query.includes('nostrAuthPubkey') || !this.workingQuery.query.includes('sort: \"new\"')))) {
        this.workingQuery = null;
        await this.findWorkingQuery();
      }
      
      // Check wallet balance before scanning
      await this.checkWalletBalance();
      if (this.creditBalance < 1) {
        Logger.warn('⚠️  No mcredits available (balance: 0). Skipping run — will retry next time.');
        Logger.step(4, 7, 'Skipped — insufficient mcredits');
        await this.saveState();
        Logger.step(5, 7, 'Run skipped — no mcredits');
        this.isRunning = false;
        return;
      }
      Logger.info(`💰 Sufficient mcredits (${this.creditBalance}), proceeding with scan`);
      
      // Live mode: scan only recent posts (2 pages). Backfill mode: scan up to BACKFILL_DEPTH pages.
      const maxPages = CONFIG.BACKFILL_ENABLED ? CONFIG.BACKFILL_DEPTH : 2;
      Logger.step(4, 7, `${CONFIG.BACKFILL_ENABLED ? 'Backfill' : 'Live'} mode: scanning up to ${maxPages} pages (${maxPages * CONFIG.SCAN_LIMIT} posts max)`);
      
      let cursor = null;
      let pages = 0;
      let consecutiveMisses = 0;
      let totalFetched = 0;
      let processedCount = 0;
      let commentedCount = 0;
      let nostrNotesCount = 0;
      let youtubeLinksFound = 0;
      
      const query = this.workingQuery.query;
      
      while (commentedCount < CONFIG.COMMENT_LIMIT) {
        const vars = { limit: CONFIG.SCAN_LIMIT };
        if (cursor) vars.cursor = cursor;
        
        const response = await this.makeGraphQLRequest(query, vars);
        const posts = response?.items?.items?.filter(item => item && item.id) || [];
        
        if (posts.length === 0) {
          Logger.info('No more posts available, stopping');
          break;
        }
        
        cursor = response.items.cursor;
        pages++;
        totalFetched += posts.length;
        
        Logger.info(`📄 Page ${pages}/${maxPages}: ${posts.length} posts (total fetched: ${totalFetched}, comments: ${commentedCount}/${CONFIG.COMMENT_LIMIT})`);
        
        for (const post of posts) {
          processedCount++;
          
          const result = await this.processPost(post);
          if (result) {
            commentedCount++;
            nostrNotesCount++;
            youtubeLinksFound++;
            consecutiveMisses = 0;
            
            if (commentedCount >= CONFIG.COMMENT_LIMIT) {
              Logger.info(`✅ Reached target of ${CONFIG.COMMENT_LIMIT} comments`);
              break;
            }
            
            Logger.info(`⏳ Comment ${commentedCount}/${CONFIG.COMMENT_LIMIT}: waiting ${CONFIG.COMMENT_DELAY / 1000}s...`);
            await this.sleep(CONFIG.COMMENT_DELAY);
          } else {
            consecutiveMisses++;
          }
        }
        
        if (commentedCount >= CONFIG.COMMENT_LIMIT) break;
        
        if (pages >= maxPages) {
          Logger.info(`⏹️  Reached max scan depth (${maxPages} pages)`);
          break;
        }
        
        if (!cursor) {
          Logger.info('No more cursor pages, reached end of available posts');
          break;
        }
        
        if (consecutiveMisses >= CONFIG.MAX_CONSECUTIVE_MISSES) {
          Logger.info(`⏹️  Stopping: ${consecutiveMisses} consecutive posts without YouTube content`);
          break;
        }
        
        await this.sleep(CONFIG.RATE_LIMIT_DELAY);
      }
      
      Logger.step(5, 7, 'Saving state and generating summary');
      
      // Save state
      await this.saveState();
      
      Logger.step(6, 7, 'Run completed successfully');
      
      const runTime = Math.round((Date.now() - startTime) / 1000);
      const summary = {
        runtime: `${runTime}s`,
        mode: CONFIG.BACKFILL_ENABLED ? 'backfill' : 'live',
        postsFetched: totalFetched,
        postsProcessed: processedCount,
        youtubeLinksFound: youtubeLinksFound,
        commentsPosted: commentedCount,
        nostrNotesPublished: nostrNotesCount,
        successRate: processedCount > 0 ? `${Math.round(youtubeLinksFound / processedCount * 100)}%` : '0%',
        workingQuery: this.workingQuery?.name || 'none',
        totalProcessedPosts: this.processedPosts.size,
        totalCommentedPosts: this.commentedPosts.size
      };
      
      Logger.info('🏁 Bot run completed', summary);
      
      // Performance insights
      if (youtubeLinksFound === 0 && processedCount > 0) {
        Logger.warn('⚠️  No YouTube links found in any posts. This might indicate:');
        Logger.warn('   - Posts are too old (YouTube content might be in newer posts)');
        Logger.warn('   - Query is not fetching recent items correctly');
        Logger.warn('   - YouTube content is rare in the current time period');
        Logger.info('💡 Consider checking if the working query is fetching recent posts correctly');
      }
      
      if (commentedCount > 0) {
        Logger.info(`📊 Engagement rate: Found YouTube content in ${youtubeLinksFound}/${processedCount} posts (${Math.round(youtubeLinksFound/processedCount*100)}%)`);
      }
      
    } catch (error) {
      Logger.error('💥 Bot run failed', { error: error.message, stack: error.stack });
      process.exit(1);
    } finally {
      this.isRunning = false;
      // Close Nostr pool connections so the process can exit cleanly
      if (this.nostrPool) {
        try {
          this.nostrPool.close(CONFIG.NOSTR_RELAYS);
        } catch (_) {}
      }
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async cleanup() {
    Logger.info('🧹 Cleaning up bot resources...');
    
    // Close Nostr pool connections
    if (this.nostrPool) {
      try {
        this.nostrPool.close(CONFIG.NOSTR_RELAYS);
        Logger.info('✅ Closed Nostr relay connections');
      } catch (error) {
        Logger.warn('⚠️  Error closing Nostr connections', { error: error.message });
      }
    }
    
    await this.saveState();
    Logger.info('🏁 Cleanup completed');
  }
}

// Main execution
async function main() {
  Logger.info('🎬 Initializing Stacker.News YouTube Bot...');
  
  const bot = new StackerNewsBot();
  
  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    Logger.info('🛑 Received SIGINT, shutting down gracefully...');
    await bot.cleanup();
    process.exit(0);
  });
  
  process.on('SIGTERM', async () => {
    Logger.info('🛑 Received SIGTERM, shutting down gracefully...');
    await bot.cleanup();
    process.exit(0);
  });
  
  try {
    await bot.run();
  } catch (error) {
    Logger.error('💀 Fatal error occurred', { error: error.message, stack: error.stack });
    process.exit(1);
  }
  
  // Force exit — Nostr pool WebSocket connections keep the event loop alive otherwise
  process.exit(0);
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = StackerNewsBot;
