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

// Configuration
const CONFIG = {
  STACKER_NEWS_API: 'https://stacker.news/api/graphql',
  STACKER_NEWS_BASE: 'https://stacker.news',
  YEWTU_BE_BASE: 'https://yewtu.be',
  COMMENT_TEMPLATE: '🔗 Privacy-friendly: {link}',
  NOSTR_NOTE_TEMPLATE: '{title}\n\n{stackerLink}/r/YewTuBot\n\n#YewTuBot #Video #watch #grownostr #Videostr #INVIDIOUS',
  SCAN_LIMIT: 50, // Number of recent posts to scan
  RATE_LIMIT_DELAY: 2000, // ms between API calls
  STATE_FILE: './.bot-state.json',
  DEBUG: process.env.DEBUG === 'true' || process.env.NODE_ENV !== 'production',
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

// Enhanced GraphQL queries - FIXED FOR RECENT ITEMS
const QUERIES = {
  // Schema introspection to understand available parameters
  COMPREHENSIVE_INTROSPECTION: `
    query comprehensiveIntrospection {
      __schema {
        queryType {
          fields {
            name
            args {
              name
              type {
                name
                kind
                ofType {
                  name
                  kind
                  enumValues {
                    name
                    description
                  }
                }
              }
              defaultValue
            }
            type {
              name
              kind
              fields {
                name
                type {
                  name
                  kind
                }
              }
            }
          }
        }
      }
    }
  `,

  // PRIMARY QUERY - This should match stacker.news/recent behavior
  RECENT_ITEMS_PRIMARY: `
    query recentItems($limit: Int, $cursor: String) {
      items(limit: $limit, cursor: $cursor) {
        items {
          id
          title
          text
          url
          createdAt
          updatedAt
          sats
          boost
          ncomments
          user {
            name
            id
          }
          sub {
            name
          }
        }
        cursor
      }
    }
  `,

  // ALTERNATIVE 1 - Sort by creation time explicitly
  RECENT_ITEMS_BY_TIME: `
    query recentItemsByTime($limit: Int, $sort: ItemSort) {
      items(limit: $limit, sort: $sort) {
        items {
          id
          title
          text
          url
          createdAt
          updatedAt
          sats
          boost
          ncomments
          user {
            name
            id
          }
          sub {
            name
          }
        }
        cursor
      }
    }
  `,

  // ALTERNATIVE 2 - With when parameter for recent timeframe
  RECENT_ITEMS_WITH_WHEN: `
    query recentItemsWithWhen($limit: Int, $when: String, $sort: String) {
      items(limit: $limit, when: $when, sort: $sort) {
        items {
          id
          title
          text
          url
          createdAt
          updatedAt
          sats
          boost
          ncomments
          user {
            name
            id
          }
          sub {
            name
          }
        }
        cursor
      }
    }
  `,

  // ALTERNATIVE 3 - Direct recent sort attempt
  RECENT_ITEMS_SORT_RECENT: `
    query recentItemsSortRecent($limit: Int) {
      items(limit: $limit, sort: "recent") {
        items {
          id
          title
          text
          url
          createdAt
          updatedAt
          sats
          boost
          ncomments
          user {
            name
            id
          }
          sub {
            name
          }
        }
        cursor
      }
    }
  `,

  // ALTERNATIVE 4 - Try with different sort values
  ITEMS_SORT_TEST: `
    query itemsSortTest($limit: Int, $sort: String) {
      items(limit: $limit, sort: $sort) {
        items {
          id
          title
          text
          url
          createdAt
          updatedAt
          sats
          boost
          ncomments
          user {
            name
            id
          }
          sub {
            name
          }
        }
        cursor
      }
    }
  `,

  // Comment mutation
  POST_COMMENT: `
    mutation createComment($parentId: ID!, $text: String!) {
      createComment(parentId: $parentId, text: $text) {
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

class StackerNewsBot {
  constructor() {
    Logger.info('Initializing StackerNewsBot...');
    Logger.debug('Configuration', CONFIG);
    
    this.privateKey = this.getPrivateKey();
    this.publicKey = getPublicKey(this.privateKey);
    this.client = new GraphQLClient(CONFIG.STACKER_NEWS_API);
    this.nostrPool = new SimplePool();
    this.processedPosts = new Set();
    this.isRunning = false;
    this.workingQuery = null;
    this.schemaInfo = null;
    
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
    Logger.step(1, 8, 'Loading bot state');
    try {
      const stateData = await fs.readFile(CONFIG.STATE_FILE, 'utf8');
      const state = JSON.parse(stateData);
      this.processedPosts = new Set(state.processedPosts || []);
      this.workingQuery = state.workingQuery || null;
      this.schemaInfo = state.schemaInfo || null;
      
      Logger.info(`State loaded successfully`, {
        processedPostsCount: this.processedPosts.size,
        hasWorkingQuery: !!this.workingQuery,
        hasSchemaInfo: !!this.schemaInfo,
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
      workingQuery: this.workingQuery,
      schemaInfo: this.schemaInfo,
      lastRun: new Date().toISOString()
    };
    
    await fs.writeFile(CONFIG.STATE_FILE, JSON.stringify(state, null, 2));
    Logger.info('State saved successfully', {
      processedPostsCount: this.processedPosts.size,
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

  async discoverSchema() {
    Logger.step(2, 8, 'Discovering GraphQL schema');
    
    if (this.schemaInfo) {
      Logger.info('Using cached schema information');
      return this.schemaInfo;
    }

    try {
      const response = await this.makeGraphQLRequest(QUERIES.COMPREHENSIVE_INTROSPECTION);
      
      // Find the items field in Query type
      const itemsField = response.__schema.queryType.fields.find(f => f.name === 'items');
      
      if (itemsField) {
        Logger.info('Items field discovered successfully');
        Logger.info('=== Items Field Parameters ===');
        
        const parameterInfo = {};
        itemsField.args.forEach(arg => {
          const typeName = arg.type.name || arg.type.ofType?.name || arg.type.kind;
          const enumValues = arg.type.ofType?.enumValues || arg.type.enumValues || [];
          
          parameterInfo[arg.name] = {
            type: typeName,
            kind: arg.type.kind,
            enumValues: enumValues.map(ev => ev.name),
            defaultValue: arg.defaultValue
          };
          
          Logger.info(`  - ${arg.name}: ${typeName} (${arg.type.kind})`);
          if (enumValues.length > 0) {
            Logger.info(`    Enum values: ${enumValues.map(ev => ev.name).join(', ')}`);
          }
          if (arg.defaultValue) {
            Logger.info(`    Default value: ${arg.defaultValue}`);
          }
        });
        
        Logger.info('=== Items Return Type Structure ===');
        if (itemsField.type.fields) {
          itemsField.type.fields.forEach(field => {
            const typeName = field.type.name || field.type.ofType?.name || field.type.kind;
            Logger.info(`  - ${field.name}: ${typeName} (${field.type.kind})`);
          });
        }
        
        this.schemaInfo = {
          itemsField: itemsField,
          parameters: parameterInfo,
          discoveredAt: new Date().toISOString()
        };
        
        Logger.info('Schema discovery completed', { parameters: parameterInfo });
      } else {
        Logger.warn('Items field not found in schema');
      }
      
      return this.schemaInfo;
    } catch (error) {
      Logger.error('Schema discovery failed', { error: error.message });
      return null;
    }
  }

  async findWorkingQuery() {
    Logger.step(3, 8, 'Finding working query for recent items');
    
    if (this.workingQuery) {
      Logger.info(`Using cached working query: ${this.workingQuery.name}`);
      return this.workingQuery;
    }

    // First discover the schema
    await this.discoverSchema();
    
    // Define test queries in priority order - most likely to work first
    const queryTests = [
      // Priority 1: Default items query (most likely to return recent items)
      {
        name: 'DEFAULT_RECENT',
        query: QUERIES.RECENT_ITEMS_PRIMARY,
        variables: { limit: CONFIG.SCAN_LIMIT },
        description: 'Default items query (should return recent items like /recent page)'
      },
      
      // Priority 2: Try with no sort (might default to recent)
      {
        name: 'NO_SORT_LIMITED',
        query: QUERIES.RECENT_ITEMS_PRIMARY,
        variables: { limit: CONFIG.SCAN_LIMIT },
        description: 'Items with limit only, no sort parameter'
      },
      
      // Priority 3: Try different sort enum values based on schema discovery
      {
        name: 'SORT_RECENT',
        query: QUERIES.ITEMS_SORT_TEST,
        variables: { limit: CONFIG.SCAN_LIMIT, sort: 'recent' },
        description: 'Sort by recent'
      },
      {
        name: 'SORT_NEW',
        query: QUERIES.ITEMS_SORT_TEST,
        variables: { limit: CONFIG.SCAN_LIMIT, sort: 'new' },
        description: 'Sort by new'
      },
      {
        name: 'SORT_LATEST',
        query: QUERIES.ITEMS_SORT_TEST,
        variables: { limit: CONFIG.SCAN_LIMIT, sort: 'latest' },
        description: 'Sort by latest'
      },
      
      // Priority 4: Try with when parameter
      {
        name: 'WHEN_DAY',
        query: QUERIES.RECENT_ITEMS_WITH_WHEN,
        variables: { limit: CONFIG.SCAN_LIMIT, when: 'day' },
        description: 'Items from today'
      },
      {
        name: 'WHEN_ALL',
        query: QUERIES.RECENT_ITEMS_WITH_WHEN,
        variables: { limit: CONFIG.SCAN_LIMIT, when: 'all' },
        description: 'All items, no time filter'
      },
      
      // Priority 5: Combinations
      {
        name: 'SORT_NEW_WHEN_DAY',
        query: QUERIES.RECENT_ITEMS_WITH_WHEN,
        variables: { limit: CONFIG.SCAN_LIMIT, sort: 'new', when: 'day' },
        description: 'New items from today'
      },
      {
        name: 'SORT_RECENT_WHEN_ALL',
        query: QUERIES.RECENT_ITEMS_WITH_WHEN,
        variables: { limit: CONFIG.SCAN_LIMIT, sort: 'recent', when: 'all' },
        description: 'Recent items, all time'
      }
    ];

    Logger.info(`Testing ${queryTests.length} query variations...`);

    for (let i = 0; i < queryTests.length; i++) {
      const test = queryTests[i];
      Logger.info(`[${i + 1}/${queryTests.length}] Testing ${test.name}: ${test.description}`);
      
      try {
        const response = await this.makeGraphQLRequest(test.query, test.variables);
        
        // Check if we got items back
        if (response && response.items && response.items.items && Array.isArray(response.items.items)) {
          const items = response.items.items;
          Logger.info(`✓ ${test.name} succeeded! Got ${items.length} items`);
          
          if (items.length > 0) {
            const sampleItem = items[0];
            Logger.debug('Sample item structure', sampleItem);
            
            // Analyze item timestamps to determine if they're sorted by recency
            if (items.length > 1) {
              const timestamps = items.slice(0, Math.min(5, items.length)).map(item => ({
                id: item.id,
                createdAt: item.createdAt,
                timestamp: new Date(item.createdAt).getTime()
              }));
              
              Logger.debug('Item timestamps analysis', timestamps);
              
              // Check if items are sorted by creation time (newest first)
              let isRecentFirst = true;
              for (let j = 1; j < timestamps.length; j++) {
                if (timestamps[j].timestamp > timestamps[j-1].timestamp) {
                  isRecentFirst = false;
                  break;
                }
              }
              
              Logger.info(`Items sorted by recency (newest first): ${isRecentFirst}`);
              
              // Calculate time span and recency
              const newestTime = Math.max(...timestamps.map(t => t.timestamp));
              const oldestTime = Math.min(...timestamps.map(t => t.timestamp));
              const timeSpanMinutes = Math.round((newestTime - oldestTime) / (1000 * 60));
              const minutesSinceNewest = Math.round((Date.now() - newestTime) / (1000 * 60));
              
              Logger.info(`Time analysis:`, {
                timeSpanMinutes: timeSpanMinutes,
                minutesSinceNewest: minutesSinceNewest,
                isRecentData: minutesSinceNewest < 60 // Less than 1 hour old
              });
              
              // Score this query based on how good it is for recent items
              let score = 0;
              if (isRecentFirst) score += 50;
              if (minutesSinceNewest < 60) score += 30; // Very recent data
              if (minutesSinceNewest < 720) score += 20; // Within 12 hours
              if (timeSpanMinutes > 0) score += 10; // Has time diversity
              
              Logger.info(`Query score: ${score}/100 (higher is better for recent items)`);
              
              // Accept the first query that gives us properly sorted recent items
              if (score >= 60 || (isRecentFirst && minutesSinceNewest < 1440)) { // 24 hours
                Logger.info(`✓ Selected ${test.name} as working query (score: ${score})`);
                
                this.workingQuery = {
                  name: test.name,
                  query: test.query,
                  variables: test.variables,
                  description: test.description,
                  isRecentFirst: isRecentFirst,
                  score: score,
                  testResults: {
                    timeSpanMinutes,
                    minutesSinceNewest,
                    itemCount: items.length
                  }
                };
                
                return this.workingQuery;
              }
            }
          }
        } else {
          Logger.warn(`✗ ${test.name} returned unexpected structure`, {
            responseKeys: Object.keys(response || {}),
            hasItems: !!(response && response.items),
            itemsStructure: response && response.items ? Object.keys(response.items) : null
          });
        }
      } catch (error) {
        Logger.warn(`✗ ${test.name} failed: ${error.message}`);
      }
      
      // Rate limiting between tests
      if (i < queryTests.length - 1) {
        await this.sleep(500);
      }
    }

    throw new Error('No working query found for fetching recent items');
  }

  extractYouTubeId(text) {
    if (!text) return null;
    
    Logger.debug('Extracting YouTube ID from text', { textLength: text.length });
    
    for (let i = 0; i < YOUTUBE_PATTERNS.length; i++) {
      const pattern = YOUTUBE_PATTERNS[i];
      pattern.lastIndex = 0; // Reset regex state
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

  convertToYewTube(originalUrl, videoId) {
    Logger.debug('Converting YouTube URL to yewtu.be', {
      originalUrl,
      videoId
    });
    
    try {
      const url = new URL(originalUrl);
      const searchParams = new URLSearchParams(url.search);
      
      // Build yewtu.be URL
      let yewtubeUrl = `${CONFIG.YEWTU_BE_BASE}/watch?v=${videoId}`;
      
      // Add timestamp if present
      if (searchParams.has('t')) {
        yewtubeUrl += `&t=${searchParams.get('t')}`;
        Logger.debug('Added timestamp parameter', { timestamp: searchParams.get('t') });
      }
      
      Logger.debug('URL conversion successful', { yewtubeUrl });
      return yewtubeUrl;
    } catch (error) {
      Logger.warn('URL parsing failed, using fallback', { error: error.message });
      // Fallback for malformed URLs
      return `${CONFIG.YEWTU_BE_BASE}/watch?v=${videoId}`;
    }
  }

  async authenticateWithNostr() {
    Logger.step(4, 8, 'Authenticating with Nostr');
    
    const authEvent = {
      kind: 22242,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['relay', 'wss://relay.stacker.news'],
        ['challenge', 'stacker.news']
      ],
      content: '',
      pubkey: this.publicKey
    };

    const signedEvent = finalizeEvent(authEvent, this.privateKey);
    
    // Set authorization header
    this.client.setHeader('Authorization', `Nostr ${Buffer.from(JSON.stringify(signedEvent)).toString('base64')}`);
    
    Logger.info('Nostr authentication completed', {
      eventId: signedEvent.id,
      eventKind: signedEvent.kind
    });
    
    return signedEvent;
  }

  async fetchRecentPosts() {
    Logger.step(5, 8, 'Fetching recent posts');
    
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

  async publishNostrNote(title, postId, yewtubeUrl) {
    Logger.debug('Publishing Nostr note', { title, postId, yewtubeUrl });
    
    try {
      // Build Stacker.News link
      const stackerLink = `${CONFIG.STACKER_NEWS_BASE}/items/${postId}`;
      
      // Create note content
      const noteContent = CONFIG.NOSTR_NOTE_TEMPLATE
        .replace('{title}', title || 'Untitled Post')
        .replace('{stackerLink}', stackerLink)
        .replace('{yewtuLink}', yewtubeUrl);

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
          ['r', yewtubeUrl]
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
      const publishPromises = CONFIG.NOSTR_RELAYS.map(relay => 
        this.publishToRelay(relay, signedEvent)
      );
      
      const results = await Promise.allSettled(publishPromises);
      
      // Count successful publications
      const successful = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;
      
      Logger.info(`Nostr note published`, {
        successful,
        failed,
        total: CONFIG.NOSTR_RELAYS.length,
        successRate: `${Math.round(successful / CONFIG.NOSTR_RELAYS.length * 100)}%`
      });
      
      if (failed > 0) {
        const failedRelays = results
          .map((r, i) => r.status === 'rejected' ? { relay: CONFIG.NOSTR_RELAYS[i], error: r.reason?.message } : null)
          .filter(Boolean);
        Logger.warn('Failed relay publications', failedRelays);
      }
      
      return { successful, failed, total: CONFIG.NOSTR_RELAYS.length };
    } catch (error) {
      Logger.error('Error publishing Nostr note', { error: error.message, postId });
      throw error;
    }
  }

  async publishToRelay(relayUrl, event) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Timeout publishing to ${relayUrl}`));
      }, 10000); // 10 second timeout

      try {
        const relay = this.nostrPool.ensureRelay(relayUrl);
        
        relay.on('connect', () => {
          Logger.debug(`Connected to ${relayUrl}`);
        });
        
        relay.on('error', (error) => {
          clearTimeout(timeoutId);
          reject(new Error(`Relay error for ${relayUrl}: ${error.message}`));
        });
        
        // Publish the event
        const pub = relay.publish(event);
        
        pub.on('ok', () => {
          clearTimeout(timeoutId);
          Logger.debug(`✓ Successfully published to ${relayUrl}`);
          resolve(relayUrl);
        });
        
        pub.on('failed', (reason) => {
          clearTimeout(timeoutId);
          reject(new Error(`Failed to publish to ${relayUrl}: ${reason}`));
        });
        
      } catch (error) {
        clearTimeout(timeoutId);
        reject(new Error(`Error with ${relayUrl}: ${error.message}`));
      }
    });
  }

  async postComment(postId, text) {
    Logger.debug('Posting comment', { postId, textLength: text.length });
    
    try {
      // Try the standard mutation first
      let response;
      try {
        response = await this.client.request(QUERIES.POST_COMMENT, {
          parentId: postId,
          text: text
        });
        Logger.debug('Comment posted successfully', { commentId: response.createComment?.id });
      } catch (error) {
        Logger.debug('Standard mutation failed, trying alternative parameter name', { error: error.message });
        // Try alternative parameter name
        response = await this.client.request(QUERIES.POST_COMMENT.replace('parentId', 'id'), {
          id: postId,
          text: text
        });
        Logger.debug('Comment posted with alternative parameters', { commentId: response.createComment?.id });
      }
      
      return response.createComment;
    } catch (error) {
      Logger.error('Error posting comment', { error: error.message, postId, textPreview: text.slice(0, 50) });
      throw error;
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

    if (this.processedPosts.has(post.id)) {
      Logger.debug(`Post ${post.id} already processed, skipping`);
      return false;
    }

    const content = `${post.title || ''} ${post.text || ''} ${post.url || ''}`;
    Logger.debug(`Checking content for YouTube links`, {
      contentLength: content.length,
      contentPreview: content.slice(0, 100) + (content.length > 100 ? '...' : '')
    });
    
    const videoId = this.extractYouTubeId(content);
    
    if (!videoId) {
      Logger.debug(`No YouTube ID found in post ${post.id}`);
      this.processedPosts.add(post.id);
      return false;
    }

    Logger.info(`📺 YouTube content detected in post ${post.id}`, { videoId });

    // Find the original YouTube URL to convert
    let originalYouTubeUrl = null;
    for (let i = 0; i < YOUTUBE_PATTERNS.length; i++) {
      const pattern = YOUTUBE_PATTERNS[i];
      pattern.lastIndex = 0;
      const match = pattern.exec(content);
      if (match) {
        originalYouTubeUrl = match[0];
        // Ensure URL has protocol
        if (!originalYouTubeUrl.startsWith('http')) {
          originalYouTubeUrl = 'https://' + originalYouTubeUrl;
        }
        Logger.debug(`Found YouTube URL with pattern ${i + 1}`, { originalYouTubeUrl });
        break;
      }
    }

    if (!originalYouTubeUrl) {
      Logger.warn(`Video ID found but no URL extracted for post ${post.id}`);
      this.processedPosts.add(post.id);
      return false;
    }

    try {
      const yewtubeUrl = this.convertToYewTube(originalYouTubeUrl, videoId);
      const commentText = CONFIG.COMMENT_TEMPLATE.replace('{link}', yewtubeUrl);
      
      Logger.info(`🔄 Processing YouTube link in post ${post.id}`, {
        originalUrl: originalYouTubeUrl,
        yewtubeUrl: yewtubeUrl,
        postDetails: {
          title: post.title?.slice(0, 50) + (post.title?.length > 50 ? '...' : ''),
          createdAt: post.createdAt,
          user: post.user?.name || 'Unknown',
          age: Math.round((Date.now() - new Date(post.createdAt).getTime()) / (1000 * 60)) + ' minutes ago'
        }
      });
      
      // Post comment on Stacker.News
      Logger.info(`💬 Posting comment on post ${post.id}...`);
      await this.postComment(post.id, commentText);
      Logger.info(`✅ Comment posted successfully on post ${post.id}`);
      
      // Publish Nostr note
      Logger.info(`📡 Publishing Nostr note for post ${post.id}...`);
      const nostrResult = await this.publishNostrNote(post.title, post.id, yewtubeUrl);
      Logger.info(`✅ Nostr note published for post ${post.id}`, nostrResult);
      
      this.processedPosts.add(post.id);
      
      Logger.info(`🎉 Successfully processed post ${post.id}`, {
        actions: ['comment_posted', 'nostr_note_published'],
        yewtubeUrl,
        nostrRelaysSuccess: nostrResult.successful
      });
      
      return true;
    } catch (error) {
      Logger.error(`❌ Failed to process post ${post.id}`, {
        error: error.message,
        originalUrl: originalYouTubeUrl,
        videoId
      });
      
      // Mark as processed to avoid retry loops
      this.processedPosts.add(post.id);
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
        rateLimit: CONFIG.RATE_LIMIT_DELAY + 'ms',
        debugMode: CONFIG.DEBUG,
        nostrRelaysCount: CONFIG.NOSTR_RELAYS.length
      });
      
      // Load previous state
      await this.loadState();
      
      // Authenticate with Nostr
      await this.authenticateWithNostr();
      
      // Fetch recent posts
      const posts = await this.fetchRecentPosts();
      Logger.step(6, 8, `Processing ${posts.length} posts`);
      
      let processedCount = 0;
      let commentedCount = 0;
      let nostrNotesCount = 0;
      let youtubeLinksFound = 0;
      
      // Process each post
      for (let i = 0; i < posts.length; i++) {
        const post = posts[i];
        Logger.info(`[${i + 1}/${posts.length}] Processing post ${post.id}...`);
        
        const result = await this.processPost(post);
        if (result) {
          commentedCount++;
          nostrNotesCount++;
          youtubeLinksFound++;
        }
        processedCount++;
        
        // Rate limiting between posts
        if (i < posts.length - 1) {
          Logger.debug(`Rate limiting: waiting ${CONFIG.RATE_LIMIT_DELAY}ms before next post...`);
          await this.sleep(CONFIG.RATE_LIMIT_DELAY);
        }
      }
      
      Logger.step(7, 8, 'Saving state and generating summary');
      
      // Save state
      await this.saveState();
      
      Logger.step(8, 8, 'Run completed successfully');
      
      const runTime = Math.round((Date.now() - startTime) / 1000);
      const summary = {
        runtime: `${runTime}s`,
        postsProcessed: processedCount,
        youtubeLinksFound: youtubeLinksFound,
        commentsPosted: commentedCount,
        nostrNotesPublished: nostrNotesCount,
        successRate: processedCount > 0 ? `${Math.round(youtubeLinksFound / processedCount * 100)}%` : '0%',
        workingQuery: this.workingQuery?.name || 'none',
        totalProcessedPosts: this.processedPosts.size
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
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = StackerNewsBot;
