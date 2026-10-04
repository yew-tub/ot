#!/usr/bin/env node

/**
 * Stacker.News YouTube Link Bot
 * Monitors for YouTube links and posts yewtu.be alternatives
 * Enhanced with detailed debugging and proper recent items fetching
 */

const { getPublicKey, finalizeEvent, nip19, SimplePool } = require('nostr-tools');
const { GraphQLClient } = require('graphql-request');
const { createHash } = require('crypto');
const fs = require('fs').promises;
const WebSocket = require('ws');
global.WebSocket = WebSocket;

// Configuration
const CONFIG = {
  STACKER_NEWS_API: 'https://stacker.news/api/graphql',
  STACKER_NEWS_BASE: 'https://stacker.news',
  COMMENT_TEMPLATE: '🔗 Privacy-friendly: {link}',
  COMMENT_TEMPLATE_MULTI: '🔗 Privacy-friendly video links:\n{videoLinks}',
  NOSTR_NOTE_TEMPLATE: '{nprofileLink} posted "{title}"\n\n{thumbnail}\n\nWatch the {videoLabel} {stackerLink}\n\n#stackernews #watch #privacy #video',
  SCAN_LIMIT: 50,
  COMMENT_LIMIT: 3,
  COMMENT_DELAY: 21000,
  MAX_CONSECUTIVE_MISSES: 500,
  MIN_STACKED_VALUE: 123,
  // Profit gates. Measured over 689 organic comments (self-zaps excluded):
  // zap rate is flat (~10-14%) across every commentCost band, so an expensive
  // post is not more likely to be zapped — it just costs more. Net result by
  // band was +701 (cost 1-2), +700 (3-5), -623 (6-10), -652 (11+).
  MAX_COMMENT_COST: parseInt(process.env.MAX_COMMENT_COST || '5', 10),
  // Zaps land while a post is in its engagement window; older posts keep their
  // stacked value but stop attracting attention. 0 or null disables a bound.
  MIN_POST_AGE_MIN: parseInt(process.env.MIN_POST_AGE_MIN || '30', 10),
  MAX_POST_AGE_MIN: parseInt(process.env.MAX_POST_AGE_MIN || '360', 10),
  // Causal per-author / per-sub track records.
  //
  // Records are never final: confidence decays with a half-life, so a target that
  // stops being commented on gradually loses its verdict and automatically returns
  // to probation, where it is re-tested with real money at risk. That is what stops
  // a dead-list from permanently blacklisting an author who simply had a bad month.
  TARGET_STATS_ENABLED: process.env.TARGET_STATS_ENABLED !== 'false',
  TARGET_MIN_COMMENTS: parseInt(process.env.TARGET_MIN_COMMENTS || '8', 10),
  TARGET_MIN_NET_PER: parseInt(process.env.TARGET_MIN_NET_PER || '0', 10),
  TARGET_STATS_HALF_LIFE_DAYS: parseInt(process.env.TARGET_STATS_HALF_LIFE_DAYS || '30', 10),
  TARGET_STATS_MAX_AGE_DAYS: parseInt(process.env.TARGET_STATS_MAX_AGE_DAYS || '180', 10),
  // A comment's zap outcome is not knowable when it is posted, so outcomes are
  // settled later by re-reading the comment's credits.
  TARGET_SETTLE_HOURS: parseInt(process.env.TARGET_SETTLE_HOURS || '48', 10),
  TARGET_SETTLE_BATCH: 20,
  TARGET_SETTLE_MAX_PER_RUN: 60,
  RATE_LIMIT_DELAY: 2000,
  STATE_FILE: './.bot-state.json',
  DEBUG: process.env.DEBUG === 'true' || process.env.NODE_ENV !== 'production',
  BACKFILL_ENABLED: process.env.BACKFILL !== 'false',
  BACKFILL_DEPTH: parseInt(process.env.BACKFILL_DEPTH || '21', 10),
  LIVE_DEPTH: parseInt(process.env.LIVE_DEPTH || '2', 10),
  INVIDIOUS_INSTANCES: (process.env.INVIDIOUS_INSTANCES || [
    'https://yewtu.be',
    'https://inv.nadeko.net',
    'https://invidious.projectsegfau.lt',
    'https://invidious.nerdvpn.de',
    'https://invidious.f5.si',
    'https://inv.thepixora.com'
  ].join(',')).split(',').map(s => s.trim()).filter(Boolean),
  NOSTR_RELAYS: [
    'wss://relay.stacker.news',
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.nostr.band',
    'wss://nostr.wine'
  ],
  // Thumbnail in the Nostr note. Makes the note visually inviting, which is the
  // whole point — a wall of text gets no zaps. Falls back to the plain
  // Invidious/YouTube thumbnail URL if every Blossom upload attempt fails, so the
  // image is never simply missing.
  NOSTR_INCLUDE_THUMBNAIL: process.env.NOSTR_INCLUDE_THUMBNAIL !== 'false',
  THUMBNAIL_QUALITY: process.env.THUMBNAIL_QUALITY || 'hqdefault',
  THUMBNAIL_MAX_BYTES: parseInt(process.env.THUMBNAIL_MAX_BYTES || '2097152', 10),
  THUMBNAIL_TIMEOUT_MS: parseInt(process.env.THUMBNAIL_TIMEOUT_MS || '10000', 10),
  // BUD-02 content-addressed upload. Public servers are increasingly auth-walled,
  // so a failure here is expected and non-fatal.
  BLOSSOM_ENABLED: process.env.BLOSSOM_ENABLED !== 'false',
  BLOSSOM_SERVERS: (process.env.BLOSSOM_SERVERS || 'https://cdn.hzrd149.com')
    .split(',').map(s => s.trim()).filter(Boolean),
  BLOSSOM_TIMEOUT_MS: parseInt(process.env.BLOSSOM_TIMEOUT_MS || '15000', 10),
  // Human-readable off-repo archive + backup of the track records.
  GIST_ENABLED: process.env.GIST_ENABLED === 'true',
  GIST_FILENAME: process.env.GIST_FILENAME || 'yewtubot-target-records.json',
  GIST_HISTORY_LIMIT: parseInt(process.env.GIST_HISTORY_LIMIT || '500', 10),
  // Good-over-unknown prioritisation. Candidates are scored and the best are
  // commented on first, instead of taking whichever eligible post the feed
  // happens to return first. Sub ROI varies ~40x, so spending on a proven
  // winner beats spending on an unknown even when both pass every gate.
  //
  // Tier dominates the score, so a `good` target always outranks an `unknown`
  // one, and an `unknown` always outranks a `stale` re-test. Unknown targets
  // are still used when no proven winner is available, so discovery continues.
  PRIORITIZE_TARGETS: process.env.PRIORITIZE_TARGETS !== 'false',
  PRIORITY_TIER_WEIGHT: 1000000,
  PRIORITY_WEIGHT_CREDITS: 1,
  PRIORITY_WEIGHT_COST: 2,
  PRIORITY_WEIGHT_AGE: 0.5,
  // Rolling-ROI circuit breaker. Zap income is a lottery (the top 10 of 694
  // comments produced 47% of gross sats), so a losing streak is expected and
  // must not be allowed to drain the wallet. When the settled ROI over a
  // trailing window is worse than CIRCUIT_MIN_ROI, the run stops commenting.
  CIRCUIT_BREAKER_ENABLED: process.env.CIRCUIT_BREAKER_ENABLED !== 'false',
  CIRCUIT_ROI_WINDOW_DAYS: parseInt(process.env.CIRCUIT_ROI_WINDOW_DAYS || '30', 10),
  CIRCUIT_MIN_SAMPLES: parseInt(process.env.CIRCUIT_MIN_SAMPLES || '40', 10),
  CIRCUIT_MIN_ROI: parseFloat(process.env.CIRCUIT_MIN_ROI || '-0.25')
};

// YouTube URL patterns
const YOUTUBE_PATTERNS = [
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/gi,
  /(?:https?:\/\/)?(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]{11})/gi,
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/gi,
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/v\/([a-zA-Z0-9_-]{11})/gi,
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/gi,
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/live\/([a-zA-Z0-9_-]{11})/gi
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
    this.authorStats = {};
    this.subStats = {};
    this.pendingSettles = {};
    this.reprobations = 0;
    this.thumbCache = {};
    this.blossomDisabledThisRun = false;
    this.verdictHistory = [];
    this.lastVerdicts = {};
    this.settledLedger = [];
    this.circuitTripReason = null;
    this.gistId = null;
    
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
      this.authorStats = state.authorStats || {};
      this.subStats = state.subStats || {};
      this.pendingSettles = state.pendingSettles || {};
      this.verdictHistory = state.verdictHistory || [];
      this.settledLedger = state.settledLedger || [];
      this.gistId = state.gistId || null;
      this.lastVerdicts = {};
      for (const h of this.verdictHistory) this.lastVerdicts[`${h.kind}:${h.name}`] = h.to;

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
        workingQuery: this.workingQuery?.name || 'none',
        authorsTracked: Object.keys(this.authorStats).length,
        subsTracked: Object.keys(this.subStats).length,
        pendingSettles: Object.keys(this.pendingSettles).length
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
      authorStats: this.authorStats,
      subStats: this.subStats,
      pendingSettles: this.pendingSettles,
      verdictHistory: this.verdictHistory,
      settledLedger: this.settledLedger,
      gistId: this.gistId,
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

  async refreshWorkingInstances() {
    Logger.step(3, 7, 'Discovering working Invidious instances');

    // Try to fetch the official instance list first
    let candidates = CONFIG.INVIDIOUS_INSTANCES;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch('https://api.invidious.io/instances.json?sort_by=type,health', { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        const instances = await res.json();
        const healthy = instances
          .filter(([, data]) =>
            data.type === 'https' &&
            data.monitor &&
            !data.monitor.down &&
            (data.monitor.uptime || 0) >= 90
          )
          .map(([host]) => `https://${host}`);
        if (healthy.length > 0) {
          candidates = healthy;
          Logger.info(`📡 Discovered ${candidates.length} healthy public Invidious instances`);
        }
      }
    } catch {
      Logger.warn('⚠️  Could not fetch official instance list — using hardcoded fallback');
    }

    // Verify candidates respond
    const working = [];
    for (const url of candidates) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 5000);
        const res = await fetch(`${url}/api/v1/stats`, { signal: ctrl.signal });
        clearTimeout(t);
        if (res.ok) {
          working.push(url);
        }
      } catch {
        // unreachable
      }
    }

    this.workingInvidiousInstances = working.length > 0 ? working : candidates;
    Logger.info(`📡 Invidious: ${this.workingInvidiousInstances.length}/${candidates.length} responsive`);
    if (working.length === 0) {
      Logger.warn('⚠️  No Invidious instances responded — will try hardcoded list anyway');
      this.workingInvidiousInstances = CONFIG.INVIDIOUS_INSTANCES;
    }
  }

  pickInvidiousInstance() {
    const list = this.workingInvidiousInstances || CONFIG.INVIDIOUS_INSTANCES;
    if (list.length === 0) return CONFIG.INVIDIOUS_INSTANCES[0];
    return list[Math.floor(Math.random() * list.length)];
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
        try {
          this.client.setHeader('Cookie', process.env.SESSION_COOKIES);
          const meResult = await this.client.request(`{ me { id name } }`);
          if (meResult?.me?.id) {
            this.sessionCookies = process.env.SESSION_COOKIES;
            Logger.info(`✅ Reused session as @${meResult.me.name} (id=${meResult.me.id})`);
            return;
          }
        } catch (err) {
          Logger.warn('SESSION_COOKIES rejected by server, re-authenticating via Nostr…', { error: err.message });
          if (this.client.requestConfig.headers) {
            delete this.client.requestConfig.headers['Cookie'];
          }
        }
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

  // ----- Video thumbnail (Blossom, with graceful fallback) -----

  // Grab the thumbnail bytes. Invidious first to stay consistent with the bot's
  // privacy posture, then ytimg as a fallback (yewtu.be itself 403s hotlinking).
  async fetchThumbnailBytes(videoId) {
    const q = CONFIG.THUMBNAIL_QUALITY;
    const sources = [
      ...(this.workingInvidiousInstances || []).map(i => `${i.replace(/\/$/, '')}/vi/${videoId}/${q}.jpg`),
      `https://i.ytimg.com/vi/${videoId}/${q}.jpg`
    ];
    for (const url of sources) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), CONFIG.THUMBNAIL_TIMEOUT_MS);
        const res = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        // Reject HTML error pages served with a 200.
        if (buf.length < 512 || buf.length > CONFIG.THUMBNAIL_MAX_BYTES) continue;
        if (buf[0] !== 0xff || buf[1] !== 0xd8) continue;
        return buf;
      } catch (e) { /* try next source */ }
    }
    return null;
  }

  // BUD-02 / BUD-05 signed auth header. The required shape is a kind 24242
  // event carrying `u` (the endpoint), `t` (the token type, which must match the
  // endpoint: "upload" for /upload, "media" for /media) and `expiration`.
  // Servers reject the event outright when `t` is absent, and reject it with
  // "token type does not match" when `t` holds something else such as the
  // content MIME type. `x` and the X-SHA-256 header are accepted but optional.
  blossomAuthHeaders(url, sha, bytes, tokenType = 'upload') {
    const now = Math.floor(Date.now() / 1000);
    const event = finalizeEvent({
      kind: 24242,
      created_at: now,
      tags: [
        ['u', url],
        ['t', tokenType],
        ['x', sha],
        ['expiration', String(now + 3600)]
      ],
      content: 'Upload thumbnail'
    }, this.privateKey);
    return { Authorization: 'Nostr ' + Buffer.from(JSON.stringify(event)).toString('base64') };
  }

  async uploadToBlossom(bytes, ext = 'jpg') {
    // Every public server rejected us once this run; don't pay the timeout again.
    if (this.blossomDisabledThisRun) return null;
    const sha = createHash('sha256').update(bytes).digest('hex');
    for (const server of CONFIG.BLOSSOM_SERVERS) {
      const base = server.replace(/\/$/, '');
      const attempts = [
        { url: `${base}/upload`, auth: this.blossomAuthHeaders(`${base}/upload`, sha, bytes, 'upload') },
        { url: `${base}/media`, auth: this.blossomAuthHeaders(`${base}/media`, sha, bytes, 'media') },
        { url: `${base}/${sha}.${ext}`, auth: null }
      ];
      for (const a of attempts) {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), CONFIG.BLOSSOM_TIMEOUT_MS);
          const res = await fetch(a.url, {
            method: 'PUT',
            headers: { 'Content-Type': `image/${ext}`, ...(a.auth || {}) },
            body: bytes,
            signal: ctrl.signal
          });
          clearTimeout(timer);
          if (!res.ok) continue;
          // BUD-02 returns a descriptor; anonymous hash-path uploads return none.
          let url = `${base}/${sha}.${ext}`;
          try {
            const body = await res.json();
            if (body && body.url) url = body.url;
            else if (body && body.sha256) url = `${base}/${body.sha256}.${ext}`;
          } catch (e) { /* keep constructed URL */ }
          return url;
        } catch (e) { /* next attempt */ }
      }
      Logger.debug(`Blossom upload failed on ${base}`);
    }
    this.blossomDisabledThisRun = true;
    return null;
  }

  // Returns a URL to use as the note's image, or null if we have nothing.
  async resolveThumbnailUrl(videoId) {
    if (!CONFIG.NOSTR_INCLUDE_THUMBNAIL || !videoId) return null;
    if (this.thumbCache && this.thumbCache[videoId] !== undefined) return this.thumbCache[videoId];

    const bytes = await this.fetchThumbnailBytes(videoId);
    let url = null;
    if (bytes) {
      if (CONFIG.BLOSSOM_ENABLED) {
        url = await this.uploadToBlossom(bytes);
        if (url) Logger.debug(`Thumbnail ${videoId} uploaded to Blossom`);
      }
      // Fall back to the direct CDN URL so the note still shows an image.
      if (!url) url = `https://i.ytimg.com/vi/${videoId}/${CONFIG.THUMBNAIL_QUALITY}.jpg`;
    }
    if (this.thumbCache) this.thumbCache[videoId] = url;
    return url;
  }

  async publishNostrNote(title, postId, invidiousUrl, username, userHexPubkey, videoCount = 1, commentId, videoId) {
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
      
      // Resolve the thumbnail before composing the note. Never fatal: if this
      // fails the note simply goes out without an image.
      let thumbnailUrl = null;
      try {
        thumbnailUrl = await this.resolveThumbnailUrl(videoId);
      } catch (e) {
        Logger.debug(`Thumbnail resolution failed for ${videoId}: ${e.message}`);
      }
      const thumbnailMd = thumbnailUrl ? `![${(title || 'video').replace(/[[\]]/g, '')}](${thumbnailUrl})` : '';

      // Create note content
      const noteContent = CONFIG.NOSTR_NOTE_TEMPLATE
        .replace('{title}', title || 'Untitled Post')
        .replace('{stackerLink}', stackerLink)
        .replace('{nprofileLink}', nprofileLink)
        .replace('{thumbnail}', thumbnailMd.trim())
        // Collapse the blank line left behind when there is no thumbnail.
        .replace(/\n{3,}/g, '\n\n')
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
          ['r', invidiousUrl],
          ...(thumbnailUrl ? [['imeta', `url ${thumbnailUrl}`, 'm image/jpeg']] : [])
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

  // ----- Fee gate -----
  // Pre-flight guard against SN's 10x/100x/1000x fee escalation: blocks if
  // itemRepetition would force a multiplier above the cap. This bot runs on a
  // tight cadence, so the default mode is 'skip' (fail fast) rather than
  // sleeping ~10 min inside a scheduled run.

  feeMaxMultiplier() {
    const n = Number(process.env.SN_MAX_FEE_MULTIPLIER);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }

  feeMaxRetries() {
    const n = Number(process.env.SN_FEE_MAX_RETRIES);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  feeRetryMin() {
    const n = Number(process.env.SN_FEE_RETRY_MIN);
    return Number.isFinite(n) && n > 0 ? n : 10;
  }

  feeMode() {
    return process.env.SN_FEE_RETRY_MODE || 'skip';
  }

  async feeRepetition(parentId = null) {
    const data = await this.makeGraphQLRequest(
      'query FeeRepetition($parentId: ID) { itemRepetition(parentId: $parentId) }',
      { parentId: parentId ? String(parentId) : null }
    );
    return Number(data?.itemRepetition || 0);
  }

  async feeSafe(parentId, action) {
    const maxMultiplier = this.feeMaxMultiplier();
    const maxRetries = this.feeMaxRetries();
    const mode = this.feeMode();
    const retryMin = this.feeRetryMin();
    let attempt = 0;
    for (;;) {
      const rep = await this.feeRepetition(parentId);
      if (10 ** rep <= maxMultiplier) return action();
      if (mode === 'skip' || attempt >= maxRetries) {
        const msg = `[fee-gate] blocked: itemRepetition=${rep}; multiplier would be ${10 ** rep}x; gave up after ${attempt}/${maxRetries} retries`;
        Logger.error(msg, { parentId });
        throw new Error(msg);
      }
      attempt += 1;
      const waitMs = retryMin * 60_000 + Math.round(Math.random() * 60_000);
      Logger.warn(`[fee-gate] repetition=${rep} (would pay ${10 ** rep}x, cap ${maxMultiplier}x) — sleeping ${Math.round(waitMs / 60_000)} min, retry ${attempt}/${maxRetries}`);
      await this.sleep(waitMs);
    }
  }

  async postComment(postId, text) {
    Logger.debug('Posting comment', { postId, textLength: text.length });

    try {
      const response = await this.feeSafe(postId, () => this.client.request(QUERIES.POST_COMMENT, {
        parentId: postId,
        text: text
      }));
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

  // ----- Causal target track records -----
  //
  // Each observation is one comment the bot actually posted: `cost` is what it
  // paid and `earned` is the comment's credits once settled. Nothing here is ever
  // derived from the future, so a verdict only reflects the bot's own past.
  //
  // Records decay exponentially toward zero with TARGET_STATS_HALF_LIFE_DAYS.
  // Decaying `n` and `earned` by the same factor leaves the per-comment average
  // intact but shrinks the sample, so confidence erodes until `n` falls below
  // TARGET_MIN_COMMENTS — at which point the verdict becomes 'unknown' and the
  // target is re-tested. That is the forgiveness path: dead targets are always
  // temporary, and a recovered author re-enters rotation on its own.

  applyStatsDecay(now = Date.now()) {
    if (!CONFIG.TARGET_STATS_ENABLED) return;
    const halfLife = CONFIG.TARGET_STATS_HALF_LIFE_DAYS * 86400000;
    if (!(halfLife > 0)) return;
    for (const store of [this.authorStats, this.subStats]) {
      for (const s of Object.values(store)) {
        const elapsed = now - (s.decayedAt || s.last || now);
        if (elapsed <= 0) continue;
        const w = Math.pow(0.5, elapsed / halfLife);
        s.n *= w;
        s.earned *= w;
        s.spent *= w;
        s.gross *= w;
        s.decayedAt = now;
      }
    }
  }

  pruneStats(now = Date.now()) {
    if (!CONFIG.TARGET_STATS_ENABLED) return;
    const cutoff = now - CONFIG.TARGET_STATS_MAX_AGE_DAYS * 86400000;
    for (const store of [this.authorStats, this.subStats]) {
      for (const [name, s] of Object.entries(store)) {
        if ((s.last || 0) < cutoff || s.n < 0.01) delete store[name];
      }
    }
  }

  // 'good' | 'dead' | 'unknown' | 'stale'
  //   good    — enough samples, net per comment at or above target
  //   dead    — enough samples, net per comment below target
  //   unknown — never seen
  //   stale   — was tracked, but the record decayed below the sample floor and
  //             is being re-tested from scratch (probation)
  targetVerdict(kind, name) {
    if (!CONFIG.TARGET_STATS_ENABLED || !name) return 'unknown';
    const store = kind === 'author' ? this.authorStats : this.subStats;
    const s = store[name];
    if (!s) return 'unknown';
    if (s.n < CONFIG.TARGET_MIN_COMMENTS) return 'stale';
    const netPer = (s.earned - s.spent) / s.n;
    return netPer >= CONFIG.TARGET_MIN_NET_PER ? 'good' : 'dead';
  }

  describeTarget(kind, name) {
    const store = kind === 'author' ? this.authorStats : this.subStats;
    const s = store[name] || {};
    const n = s.n || 0;
    const net = (s.earned || 0) - (s.spent || 0);
    const netPer = n > 0 ? net / n : 0;
    return `${kind} @${name} n=${n.toFixed(1)} net=${net.toFixed(0)} net/cmt=${netPer.toFixed(2)}`;
  }

  // Called after a comment is successfully posted. The zap outcome is unknown at
  // this point, so the observation is queued and settled on a later run.
  queueSettle(commentId, post, cost) {
    if (!CONFIG.TARGET_STATS_ENABLED || !commentId) return;
    this.pendingSettles[commentId] = {
      author: post.user?.name || null,
      sub: post.sub?.name || null,
      cost: cost || 0,
      ts: Date.now()
    };
  }

  applyObservation(store, name, earned, spent, gross) {
    if (!name) return;
    const s = store[name] || { n: 0, earned: 0, spent: 0, gross: 0 };
    s.n += 1;
    s.earned += earned;
    s.spent += spent;
    s.gross += gross || 0;
    s.last = Date.now();
    s.decayedAt = Date.now();
    store[name] = s;
  }

  // Re-read settled comments and fold their real outcome into the records.
  async settlePendingComments() {
    if (!CONFIG.TARGET_STATS_ENABLED) return;

    const now = Date.now();
    const due = Object.entries(this.pendingSettles)
      .filter(([, p]) => now - p.ts >= CONFIG.TARGET_SETTLE_HOURS * 3600000)
      .sort((a, b) => a[1].ts - b[1].ts)
      .slice(0, CONFIG.TARGET_SETTLE_MAX_PER_RUN);

    if (due.length === 0) return;

    Logger.info(`📐 Settling ${due.length} past comment(s) older than ${CONFIG.TARGET_SETTLE_HOURS}h`);

    let settled = 0;
    for (let i = 0; i < due.length; i += CONFIG.TARGET_SETTLE_BATCH) {
      const batch = due.slice(i, i + CONFIG.TARGET_SETTLE_BATCH);
      let data;
      try {
        // One aliased query per batch keeps this to a single round trip.
        const parts = batch.map(([cid], k) =>
          `s${k}: item(id: "${cid}") { id sats credits }`
        ).join(' ');
        data = await this.makeGraphQLRequest(`query { ${parts} }`);
      } catch (error) {
        Logger.warn('Settle batch failed — leaving entries pending for next run', { error: error.message });
        continue;
      }

      batch.forEach(([cid], k) => {
        const item = data?.[`s${k}`];
        const p = this.pendingSettles[cid];
        if (!p) return;
        if (!item) {
          // Comment not retrievable (deleted?). Treat as a write-off so the
          // record reflects reality instead of being silently dropped.
          this.applyObservation(this.authorStats, p.author, 0, p.cost, 0);
          this.applyObservation(this.subStats, p.sub, 0, p.cost, 0);
          this.recordSettlement(0, p.cost);
          delete this.pendingSettles[cid];
          settled++;
          return;
        }
        const earned = item.credits || 0;
        const gross = item.sats || 0;
        this.applyObservation(this.authorStats, p.author, earned, p.cost, gross);
        this.applyObservation(this.subStats, p.sub, earned, p.cost, gross);
        this.recordSettlement(earned, p.cost);
        delete this.pendingSettles[cid];
        settled++;
      });

      await this.sleep(this.RATE_LIMIT_DELAY || 500);
    }

    Logger.info(`📐 Settled ${settled} comment(s) into track records`, {
      authorsTracked: Object.keys(this.authorStats).length,
      subsTracked: Object.keys(this.subStats).length,
      stillPending: Object.keys(this.pendingSettles).length
    });
  }

  // ----- Prioritisation -----
  //
  // Tier is the dominant term. `dead` is filtered out earlier and never scores.
  // Within a tier the tie-breakers are all things the data supports: posts that
  // already hold credits are in a zapping mood (cost and credits are both
  // mcredits, so they compare directly), cheaper posts are less risky, and
  // fresher posts sit in the engagement window where zaps actually land.

  candidateTier(post) {
    const authorName = post.user?.name;
    const subName = post.sub?.name;
    let tier = 2; // unknown
    for (const [kind, name] of [['author', authorName], ['sub', subName]]) {
      const v = this.targetVerdict(kind, name);
      if (v === 'good') tier = Math.max(tier, 3);
      else if (v === 'stale') tier = Math.min(tier, 1);
    }
    return tier;
  }

  scoreCandidate(post, ageMin) {
    const tier = this.candidateTier(post);
    const value =
      (post.credits || 0) * CONFIG.PRIORITY_WEIGHT_CREDITS -
      (post.commentCost || 0) * CONFIG.PRIORITY_WEIGHT_COST -
      ageMin * CONFIG.PRIORITY_WEIGHT_AGE;
    return tier * CONFIG.PRIORITY_TIER_WEIGHT + value;
  }

  // ----- Rolling-ROI circuit breaker -----
  //
  // `settledLedger` is the bot's own realised P&L, one entry per comment whose
  // outcome has actually been read. This is what the breaker judges — not the
  // gated candidates, and not the still-pending comments.

  recordSettlement(earned, spent) {
    this.settledLedger.push({ ts: Date.now(), earned: earned || 0, spent: spent || 0 });
  }

  pruneLedger(now = Date.now()) {
    const cutoff = now - CONFIG.CIRCUIT_ROI_WINDOW_DAYS * 86400000;
    while (this.settledLedger.length && this.settledLedger[0].ts < cutoff) this.settledLedger.shift();
    // Hard cap in case the window is set absurdly large.
    const cap = Math.max(CONFIG.CIRCUIT_MIN_SAMPLES * 20, 2000);
    if (this.settledLedger.length > cap) this.settledLedger.splice(0, this.settledLedger.length - cap);
  }

  rollingRoi() {
    let earned = 0, spent = 0;
    for (const e of this.settledLedger) { earned += e.earned; spent += e.spent; }
    return { samples: this.settledLedger.length, earned, spent, net: earned - spent, roi: spent > 0 ? (earned - spent) / spent : 0 };
  }

  // Returns null when trading, or a human-readable reason to stand down.
  circuitBreakerTrip() {
    if (!CONFIG.CIRCUIT_BREAKER_ENABLED) return null;
    const r = this.rollingRoi();
    // Never trip on thin evidence.
    if (r.samples < CONFIG.CIRCUIT_MIN_SAMPLES) return null;
    if (r.roi >= CONFIG.CIRCUIT_MIN_ROI) return null;
    return `rolling ROI ${(r.roi * 100).toFixed(0)}% over last ${r.samples} settled comments ` +
           `(spent ${Math.round(r.spent)}, earned ${Math.round(r.earned)}) is worse than the ${(CONFIG.CIRCUIT_MIN_ROI * 100).toFixed(0)}% floor`;
  }

  // ----- Private gist archive -----
  //
  // The Actions cache is the live working copy, but it is not something you can
  // read, and it can be evicted wholesale. The gist is both an off-repo backup
  // and a human-readable archive: every verdict transition is appended so you can
  // see which authors/subs went dead, when, and whether they ever recovered.
  //
  // Every call is best-effort. Gist failures must never stop the bot.

  gistConfig() {
    const token = process.env.GIST_TOKEN;
    if (!CONFIG.GIST_ENABLED || !token) return null;
    return {
      token,
      id: process.env.GIST_ID || null,
      filename: CONFIG.GIST_FILENAME
    };
  }

  async gistRequest(method, url, body) {
    const cfg = this.gistConfig();
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) throw new Error(`gist ${method} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.status === 204 ? null : res.json();
  }

  gistUrl(id) {
    return id ? `https://gist.github.com/${id}` : null;
  }

  // Order of preference: the id learned on a previous run (kept in the state
  // file), then an explicitly configured GIST_ID, then a lookup by filename.
  // A configured id is verified before it is trusted: a stale or mistyped
  // GIST_ID would otherwise 404 on every request and silently kill the
  // archive for good, so an unusable one is ignored and discovery continues.
  async resolveGistId() {
    const cfg = this.gistConfig();
    if (this.gistId) return this.gistId;
    if (cfg.id) {
      try {
        await this.gistRequest('GET', `https://api.github.com/gists/${cfg.id}`);
        this.gistId = cfg.id;
        return this.gistId;
      } catch (error) {
        Logger.warn(`📝 Configured GIST_ID is unusable, falling back to auto-discovery`, {
          id: cfg.id,
          error: error.message
        });
      }
    }
    const list = await this.gistRequest('GET', 'https://api.github.com/gists?per_page=100');
    const found = (list || []).find(g => g.files && g.files[cfg.filename]);
    if (found) {
      this.gistId = found.id;
      Logger.info(`📝 Found existing gist archive ${this.gistUrl(found.id)}`);
    }
    return found ? found.id : null;
  }

  // Append a verdict transition. Repeats are suppressed so the archive records
  // changes, not one line per skipped post.
  noteVerdict(kind, name, verdict) {
    if (!CONFIG.TARGET_STATS_ENABLED || !name) return;
    const key = `${kind}:${name}`;
    const prev = this.lastVerdicts[key];
    if (prev === verdict) return;
    this.lastVerdicts[key] = verdict;
    const s = (kind === 'author' ? this.authorStats : this.subStats)[name] || {};
    const n = s.n || 0;
    this.verdictHistory.push({
      ts: new Date().toISOString(),
      kind,
      name,
      from: prev || null,
      to: verdict,
      n: Number(n.toFixed(2)),
      netPer: n > 0 ? Number(((s.earned - s.spent) / n).toFixed(2)) : null,
      spent: Math.round(s.spent || 0),
      earned: Math.round(s.earned || 0)
    });
    if (this.verdictHistory.length > CONFIG.GIST_HISTORY_LIMIT) {
      this.verdictHistory.splice(0, this.verdictHistory.length - CONFIG.GIST_HISTORY_LIMIT);
    }
  }

  gistDocument() {
    const deadList = (store, kind) => Object.entries(store)
      .filter(([, s]) => s.n >= CONFIG.TARGET_MIN_COMMENTS && (s.earned - s.spent) / s.n < CONFIG.TARGET_MIN_NET_PER)
      .map(([name, s]) => ({
        name,
        n: Number(s.n.toFixed(2)),
        net: Math.round(s.earned - s.spent),
        netPer: Number(((s.earned - s.spent) / s.n).toFixed(2)),
        lastSeen: s.last ? new Date(s.last).toISOString() : null
      }))
      .sort((a, b) => a.netPer - b.netPer)
      .map(x => ({ kind, ...x }));

    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      gistUrl: this.gistUrl(this.gistId),
      config: {
        minComments: CONFIG.TARGET_MIN_COMMENTS,
        minNetPer: CONFIG.TARGET_MIN_NET_PER,
        halfLifeDays: CONFIG.TARGET_STATS_HALF_LIFE_DAYS,
        settleHours: CONFIG.TARGET_SETTLE_HOURS
      },
      currentlyDead: {
        authors: deadList(this.authorStats, 'author'),
        subs: deadList(this.subStats, 'sub')
      },
      records: { authors: this.authorStats, subs: this.subStats },
      history: this.verdictHistory
    };
  }

  // Restore when local state is missing/empty (e.g. the cache was evicted).
  async restoreRecordsFromGist() {
    const cfg = this.gistConfig();
    if (!cfg) return;
    try {
      const id = await this.resolveGistId();
      if (!id) { Logger.info('📝 No gist archive found yet — will create on save'); return; }
      const gist = await this.gistRequest('GET', `https://api.github.com/gists/${id}`);
      const file = gist.files && gist.files[cfg.filename];
      if (!file || !file.content) { Logger.warn(`📝 Gist archive ${id} has no ${cfg.filename}`); return; }
      const doc = JSON.parse(file.content);
      const localAuthors = Object.keys(this.authorStats).length;
      const localSubs = Object.keys(this.subStats).length;
      if (localAuthors === 0 && doc.records?.authors && Object.keys(doc.records.authors).length) {
        this.authorStats = doc.records.authors;
        Logger.info(`📝 Restored ${Object.keys(doc.records.authors).length} author records from gist`);
      }
      if (localSubs === 0 && doc.records?.subs && Object.keys(doc.records.subs).length) {
        this.subStats = doc.records.subs;
        Logger.info(`📝 Restored ${Object.keys(doc.records.subs).length} sub records from gist`);
      }
      if (Array.isArray(doc.history) && doc.history.length > (this.verdictHistory?.length || 0)) {
        this.verdictHistory = doc.history;
        this.lastVerdicts = {};
        for (const h of doc.history) this.lastVerdicts[`${h.kind}:${h.name}`] = h.to;
        Logger.info(`📝 Restored ${doc.history.length} verdict history entries from gist`);
      }
    } catch (error) {
      Logger.warn(`📝 Gist restore failed (continuing): ${error.message}`);
    }
  }

  async createGist(body) {
    const created = await this.gistRequest('POST', 'https://api.github.com/gists', { ...body, public: false });
    this.gistId = created.id;
    Logger.info('📝 Created private gist archive — no setup needed from now on.');
    Logger.info(`📝 GIST_ID: ${created.id}`);
    return created.id;
  }

  async pushRecordsToGist() {
    const cfg = this.gistConfig();
    if (!cfg) return;
    try {
      const doc = this.gistDocument();
      const id = await this.resolveGistId();
      const body = { description: 'YewTuBot author/sub track records (auto-updated)', files: { [cfg.filename]: { content: JSON.stringify(doc, null, 2) } } };
      if (!id) {
        await this.createGist(body);
      } else {
        try {
          await this.gistRequest('PATCH', `https://api.github.com/gists/${id}`, body);
          this.gistId = id;
        } catch (error) {
          if (!error.message.includes('404')) throw error;
          Logger.warn(`📝 Gist ${id} vanished mid-run, creating a replacement`);
          await this.createGist(body);
        }
      }
      const dead = doc.currentlyDead;
      Logger.info('📝 Gist archive updated', {
        url: this.gistUrl(this.gistId),
        deadAuthors: dead.authors.length,
        deadSubs: dead.subs.length,
        historyEntries: doc.history.length
      });
    } catch (error) {
      Logger.warn(`📝 Gist save failed (non-fatal): ${error.message}`);
    }
  }

  // screenOnly: run every gate and extract links, but do nothing network-bound.
  // Lets the scan rank candidates cheaply. The chosen posts are then run through
  // the full path, so scoring can never bypass a gate.
  async processPost(post, { screenOnly = false } = {}) {
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

    // ---- Profit gates (all free — evaluated before any network work) ----

    // 0. Proven-dead target? Skipped, but only while the verdict is fresh —
    //    a decayed record returns the target to probation automatically.
    if (CONFIG.TARGET_STATS_ENABLED) {
      const authorName = post.user?.name;
      const subName = post.sub?.name;
      for (const [kind, name] of [['author', authorName], ['sub', subName]]) {
        const verdict = this.targetVerdict(kind, name);
        if (verdict === 'dead') {
          this.noteVerdict(kind, name, verdict);
          Logger.info(`⏭️  Skipping post ${post.id}: dead ${kind} (${this.describeTarget(kind, name)})`);
          return false;
        }
        if (verdict === 'stale') {
          // Previously judged, record has since decayed — this is a re-test.
          this.reprobations++;
          this.noteVerdict(kind, name, 'stale');
          Logger.info(`🔁 Re-testing ${kind} @${name}: record decayed below ${CONFIG.TARGET_MIN_COMMENTS} samples (${this.describeTarget(kind, name)})`);
        }
      }
    }

    // 1. Engagement window: only comment while the post can still attract zaps.
    const ageMin = Math.round((Date.now() - new Date(post.createdAt).getTime()) / 60000);
    if (CONFIG.MIN_POST_AGE_MIN > 0 && ageMin < CONFIG.MIN_POST_AGE_MIN) {
      Logger.info(`⏭️  Skipping post ${post.id}: only ${ageMin}m old (min ${CONFIG.MIN_POST_AGE_MIN}m)`);
      return false;
    }
    if (CONFIG.MAX_POST_AGE_MIN > 0 && ageMin > CONFIG.MAX_POST_AGE_MIN) {
      Logger.info(`⏭️  Skipping post ${post.id}: ${ageMin}m old (max ${CONFIG.MAX_POST_AGE_MIN}m)`);
      return false;
    }

    // 2. Cost cap: high commentCost is the single biggest value leak.
    const cost = post.commentCost || 0;
    if (cost > CONFIG.MAX_COMMENT_COST) {
      Logger.info(`⏭️  Skipping post ${post.id}: comment costs ${cost} mcredits, above MAX_COMMENT_COST ${CONFIG.MAX_COMMENT_COST}`);
      return false;
    }

    // 3. Affordability
    if (cost > this.creditBalance) {
      Logger.info(`⏭️  Skipping post ${post.id}: comment costs ${cost} mcredits but balance is ${this.creditBalance}`);
      return false;
    }
    if (cost > 0) {
      Logger.info(`💸 Comment will cost ${cost} mcredit(s) (balance: ${this.creditBalance})`);
    }

    // 4. Stacked value: sats + credits - boost - commentCost >= MIN_STACKED_VALUE
    const stackedValue = (post.sats || 0) + (post.credits || 0) - (post.boost || 0) - cost;
    if (stackedValue < CONFIG.MIN_STACKED_VALUE) {
      Logger.info(`⏭️  Skipping post ${post.id}: stacked value ${stackedValue} is below minimum ${CONFIG.MIN_STACKED_VALUE} (sats=${post.sats || 0}, credits=${post.credits || 0}, boost=${post.boost || 0}, cost=${cost})`);
      return false;
    }
    Logger.info(`📊 Stacked value ${stackedValue} meets minimum threshold of ${CONFIG.MIN_STACKED_VALUE}`);

    if (screenOnly) {
      return {
        screenOnly: true,
        score: this.scoreCandidate(post, ageMin),
        tier: this.candidateTier(post),
        videos: allVideos.length
      };
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
          age: ageMin + ' minutes ago'
        }
      });

      // Post comment on Stacker.News
      Logger.info(`💬 Posting comment on post ${post.id}...`);
      const comment = await this.postComment(post.id, commentText);
      const commentId = comment?.id;
      Logger.info(`✅ Comment posted successfully on post ${post.id}`, { commentId });

      // Deduct the cost from our cached balance
      this.creditBalance -= cost;

      // Queue this comment's outcome to be settled into the target track
      // records on a later run (zaps have not arrived yet).
      this.queueSettle(commentId, post, cost);

      // Publish Nostr note (pass first invidious URL for tagging, video count for label)
      Logger.info(`📡 Publishing Nostr note for post ${post.id}...`);
      const nostrResult = await this.publishNostrNote(
        post.title, post.id, invidiousLinks[0].invidiousUrl,
        post.user?.name, post.user?.optional?.nostrAuthPubkey, invidiousLinks.length,
        commentId, allVideos[0]?.id
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
        maxCommentCost: CONFIG.MAX_COMMENT_COST,
        postAgeWindowMin: [CONFIG.MIN_POST_AGE_MIN, CONFIG.MAX_POST_AGE_MIN],
        targetStats: CONFIG.TARGET_STATS_ENABLED
          ? { minComments: CONFIG.TARGET_MIN_COMMENTS, minNetPer: CONFIG.TARGET_MIN_NET_PER, halfLifeDays: CONFIG.TARGET_STATS_HALF_LIFE_DAYS }
          : 'disabled',
        rateLimit: CONFIG.RATE_LIMIT_DELAY + 'ms',
        debugMode: CONFIG.DEBUG,
        backfillMode: CONFIG.BACKFILL_ENABLED,
        backfillDepth: CONFIG.BACKFILL_DEPTH,
        invidiousInstances: CONFIG.INVIDIOUS_INSTANCES.length,
        nostrRelaysCount: CONFIG.NOSTR_RELAYS.length
      });
      
      // Load previous state
      await this.loadState();
      
      // Recover records from the gist archive if the local cache came up empty
      if (CONFIG.GIST_ENABLED) await this.restoreRecordsFromGist();

      // Authenticate with Nostr
      await this.authenticateWithNostr();

      // Age the target track records and fold in newly settled outcomes
      if (CONFIG.TARGET_STATS_ENABLED) {
        this.applyStatsDecay();
        await this.settlePendingComments();
        this.pruneStats();
      }

      // Capital preservation: stand down if realised returns are too poor.
      this.pruneLedger();
      this.circuitTripReason = this.circuitBreakerTrip();
      if (this.circuitTripReason) {
        Logger.warn(`🛑 Circuit breaker OPEN — ${this.circuitTripReason}`);
        Logger.warn('🛑 Skipping all commenting this run. Settling and saving state only.');
      } else {
        const r = this.rollingRoi();
        Logger.info('📈 Rolling ROI (realised)', {
          samples: r.samples,
          spent: Math.round(r.spent),
          earned: Math.round(r.earned),
          roi: `${(r.roi * 100).toFixed(0)}%`,
          breakerArmed: r.samples >= CONFIG.CIRCUIT_MIN_SAMPLES
        });
      }
      
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
      
      if (this.circuitTripReason) {
        Logger.step(4, 7, 'Skipped — circuit breaker open');
        Logger.step(5, 7, 'Archiving records and saving state');
        if (CONFIG.GIST_ENABLED) await this.pushRecordsToGist();
        await this.saveState();
        Logger.info('Run completed — no comments posted (circuit breaker open)');
        this.isRunning = false;
        return;
      }

      // Check which Invidious instances are responsive
      await this.refreshWorkingInstances();

      Logger.step(4, 7, 'Scanning posts newest-first for YouTube links with ≥ 123 stacked value');
      
      // BACKFILL=false stops the scan after LIVE_DEPTH pages so a scheduled run
      // never walks back into old, expensive, low-yield posts.
      const maxPages = CONFIG.BACKFILL_ENABLED ? CONFIG.BACKFILL_DEPTH : CONFIG.LIVE_DEPTH;
      Logger.info(`Page budget: ${maxPages} page(s) of ${CONFIG.SCAN_LIMIT} (${CONFIG.BACKFILL_ENABLED ? 'backfill' : 'live-only'} mode)`);
      
      let cursor = null;
      let consecutiveMisses = 0;
      let totalFetched = 0;
      let processedCount = 0;
      let commentedCount = 0;
      let nostrNotesCount = 0;
      let youtubeLinksFound = 0;
      let pagesFetched = 0;
      
      const query = this.workingQuery.query;
      
      while (commentedCount < CONFIG.COMMENT_LIMIT) {
        if (pagesFetched >= maxPages) {
          Logger.info(`🛑 Page budget reached (${pagesFetched}/${maxPages} pages) — stopping scan`);
          break;
        }
        const vars = { limit: CONFIG.SCAN_LIMIT };
        if (cursor) vars.cursor = cursor;
        
        const response = await this.makeGraphQLRequest(query, vars);
        const posts = response?.items?.items?.filter(item => item && item.id) || [];
        
        if (posts.length === 0) {
          Logger.info('No more posts available, stopping');
          break;
        }
        
        cursor = response.items.cursor;
        totalFetched += posts.length;
        pagesFetched++;
        
        Logger.info(`📄 Page: ${posts.length} posts (total fetched: ${totalFetched}, comments: ${commentedCount}/${CONFIG.COMMENT_LIMIT})`);
        
        // Screen the whole page first. When prioritisation is on we rank the
        // page and comment on the best candidates rather than the newest
        // eligible ones, so proven winners are funded before unknowns.
        const pageCandidates = [];
        for (const post of posts) {
          processedCount++;
          const screened = await this.processPost(post, { screenOnly: true });
          if (screened && screened.screenOnly) {
            pageCandidates.push({ post, ...screened });
            consecutiveMisses = 0;
          } else {
            consecutiveMisses++;
          }
        }

        if (CONFIG.PRIORITIZE_TARGETS && pageCandidates.length) {
          pageCandidates.sort((x, y) => y.score - x.score);
          const ranked = pageCandidates.map(c => `${c.post.sub?.name || '-'}/${c.post.user?.name || '-'}(t${c.tier},${c.score.toFixed(0)})`).join(' ');
          Logger.debug(`Ranked ${pageCandidates.length} candidate(s): ${ranked}`);
        }

        for (const cand of pageCandidates) {
          if (commentedCount >= CONFIG.COMMENT_LIMIT) break;

          const result = await this.processPost(cand.post);
          if (result) {
            commentedCount++;
            nostrNotesCount++;
            youtubeLinksFound++;
            Logger.info(`💬 Commented on ${cand.post.sub?.name || 'direct'}/${cand.post.user?.name || '?'} (tier ${cand.tier}, score ${cand.score.toFixed(0)})`);

            if (commentedCount >= CONFIG.COMMENT_LIMIT) break;
            Logger.info(`⏳ Comment ${commentedCount}/${CONFIG.COMMENT_LIMIT}: waiting ${CONFIG.COMMENT_DELAY / 1000}s...`);
            await this.sleep(CONFIG.COMMENT_DELAY);
          }
        }

        if (commentedCount >= CONFIG.COMMENT_LIMIT) break;

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
      
      Logger.step(5, 7, 'Archiving records and generating summary');
      
      // Mirror to the private gist archive (backup + human-readable history).
      // This runs before saveState so a gist created on the first run has its
      // id persisted and later runs never have to search for it again.
      if (CONFIG.GIST_ENABLED) await this.pushRecordsToGist();

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
        totalCommentedPosts: this.commentedPosts.size,
        reprobations: this.reprobations,
        authorsTracked: Object.keys(this.authorStats).length,
        subsTracked: Object.keys(this.subStats).length,
        pendingSettles: Object.keys(this.pendingSettles).length,
        rollingRoi: `${(this.rollingRoi().roi * 100).toFixed(0)}%`,
        circuitBreaker: this.circuitTripReason ? 'OPEN' : 'closed',
        gistArchive: this.gistUrl(this.gistId)
      };
      
      Logger.info('🏁 Bot run completed', summary);
      
      // Performance insights
      if (youtubeLinksFound === 0 && processedCount > 0) {
        Logger.warn('⚠️  No YouTube links found in any posts. This might indicate:');
        Logger.warn('   - YouTube content is currently rare in the /new feed');
        Logger.warn('   - The working query/API may have changed');
        Logger.warn('   - All YouTube posts found had insufficient stacked value (< 123)');
        Logger.info('💡 Consider checking if the working query is still fetching posts correctly');
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
