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

// Enhanced GraphQL queries with comprehensive testing
const QUERIES = {
  // Deep introspection to understand the complete schema
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

  // Test query variations based on common GraphQL patterns
  // Pattern 1: Using 'sort' parameter with different values
  ITEMS_WITH_SORT: `
    query itemsWithSort($sort: String) {
      items(sort: $sort) {
        items {
          id
          title
          text
          url
          createdAt
          user {
            name
          }
        }
        cursor
      }
    }
  `,

  // Pattern 2: Using 'when' parameter (time-based filtering)
  ITEMS_WITH_WHEN: `
    query itemsWithWhen($when: String) {
      items(when: $when) {
        items {
          id
          title
          text
          url
          createdAt
          user {
            name
          }
        }
        cursor
      }
    }
  `,

  // Pattern 3: Using both sort and when
  ITEMS_WITH_SORT_AND_WHEN: `
    query itemsWithSortAndWhen($sort: String, $when: String) {
      items(sort: $sort, when: $when) {
        items {
          id
          title
          text
          url
          createdAt
          user {
            name
          }
        }
        cursor
      }
    }
  `,

  // Pattern 4: Using limit parameter
  ITEMS_WITH_LIMIT: `
    query itemsWithLimit($limit: Int) {
      items(limit: $limit) {
        items {
          id
          title
          text
          url
          createdAt
          user {
            name
          }
        }
        cursor
      }
    }
  `,

  // Pattern 5: All possible parameters
  ITEMS_FULL_PARAMS: `
    query itemsFullParams($sort: String, $when: String, $limit: Int) {
      items(sort: $sort, when: $when, limit: $limit) {
        items {
          id
          title
          text
          url
          createdAt
          user {
            name
          }
        }
        cursor
      }
    }
  `,

  // Fallback - no parameters
  ITEMS_NO_PARAMS: `
    query itemsNoParams {
      items {
        items {
          id
          title
          text
          url
          createdAt
          user {
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
    
    // Define test queries based on common patterns and schema discovery
    const queryTests = [
      // Test common sort values for recent items
      {
        name: 'SORT_NEW',
        query: QUERIES.ITEMS_WITH_SORT,
        variables: { sort: 'new' },
        description: 'Sort by newest items'
      },
      {
        name: 'SORT_RECENT',
        query: QUERIES.ITEMS_WITH_SORT,
        variables: { sort: 'recent' },
        description: 'Sort by recent items'
      },
      {
        name: 'SORT_LATEST',
        query: QUERIES.ITEMS_WITH_SORT,
        variables: { sort: 'latest' },
        description: 'Sort by latest items'
      },
      {
        name: 'SORT_TIME',
        query: QUERIES.ITEMS_WITH_SORT,
        variables: { sort: 'time' },
        description: 'Sort by time'
      },
      {
        name: 'SORT_CREATED',
        query: QUERIES.ITEMS_WITH_SORT,
        variables: { sort: 'created' },
        description: 'Sort by creation time'
      },
      
      // Test when parameter (time-based filtering)
      {
        name: 'WHEN_DAY',
        query: QUERIES.ITEMS_WITH_WHEN,
        variables: { when: 'day' },
        description: 'Items from today'
      },
      {
        name: 'WHEN_ALL',
        query: QUERIES.ITEMS_WITH_WHEN,
        variables: { when: 'all' },
        description: 'All items (no time filter)'
      },
      
      // Test combinations
      {
        name: 'SORT_NEW_WHEN_DAY',
        query: QUERIES.ITEMS_WITH_SORT_AND_WHEN,
        variables: { sort: 'new', when: 'day' },
        description: 'New items from today'
      },
      {
        name: 'SORT_NEW_WITH_LIMIT',
        query: QUERIES.ITEMS_FULL_PARAMS,
        variables: { sort: 'new', limit: CONFIG.SCAN_LIMIT },
        description: 'New items with limit'
      },
      
      // Fallback options
      {
        name: 'LIMIT_ONLY',
        query: QUERIES.ITEMS_WITH_LIMIT,
        variables: { limit: CONFIG.SCAN_LIMIT },
        description: 'Items with limit only'
      },
      {
        name: 'NO_PARAMS',
        query: QUERIES.ITEMS_NO_PARAMS,
        variables: {},
        description: 'Items with no parameters (fallback)'
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
              const timestamps = items.slice(0, 5).map(item => ({
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
              
              // Calculate time span
              const newestTime = Math.max(...timestamps.map(t => t.timestamp));
              const oldestTime = Math.min(...timestamps.map(t => t.timestamp));
              const timeSpanMinutes = Math.round((newestTime - oldestTime) / (1000 * 60));
              
              Logger.info(`Time span of fetched items: ${timeSpanMinutes} minutes`);
              
              // Priority scoring: prefer queries that return items sorted by recency
              const score = isRecentFirst ? 100 : 50;
              Logger.info(`Query score: ${score}/100 (higher is better for recent items)`);
              
              // If this looks like a good recent items query, use it
              if (isRecentFirst || test.name.includes('NEW') || test.name.includes('RECENT')) {
                Logger.info(`✓ Selected ${test.name} as working query`);
                
                this.workingQuery = {
                  name: test.name,
                  query: test.query,
                  variables: test.variables,
                  description: test.description,
                  isRecentFirst: isRecentFirst,
                  score: score
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

    throw new Error('No working query found for fetching items');
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
      }

      Logger.info(`Successfully fetched ${items.length} items`);
      
      // Detailed analysis for debugging
      if (items.length > 0) {
        const newestItem = items[0];
        const oldestItem = items[items.length - 1];
        const newestTime = new Date(newestItem.createdAt);
        const oldestTime = new Date(oldestItem.createdAt);
        const timeDiff = newestTime - oldestTime;
        
        Logger.info('Fetched items analysis', {
          newestItem: {
            id: newestItem.id,
            title: newestItem.title?.slice(0, 50) + (newestItem.title?.length > 50 ? '...' : ''),
            createdAt: newestItem.createdAt,
            user: newestItem.user?.name
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
            isRecentFirst: newestTime >= oldestTime
          }
        });
        
        // Show more recent items for context
        if (items.length >= 5) {
          Logger.debug('Recent items sample', items.slice(0, 5).map(item => ({
            id: item.id,
            title: item.title?.slice(0, 30) + '...',
            createdAt: item.createdAt,
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
    try {
      // Try the standard mutation first
      let response;
      try {
        response = await this.client.request(QUERIES.POST_COMMENT, {
          parentId: postId,
          text: text
        });
      } catch (error) {
        // Try alternative parameter name
        response = await this.client.request(QUERIES.POST_COMMENT.replace('parentId', 'id'), {
          id: postId,
          text: text
        });
      }
      
      return response.createComment;
    } catch (error) {
      console.error('Error posting comment:', error);
      throw error;
    }
  }

  async processPost(post) {
    if (this.processedPosts.has(post.id)) {
      return false;
    }

    const content = `${post.title || ''} ${post.text || ''} ${post.url || ''}`;
    const videoId = this.extractYouTubeId(content);
    
    if (!videoId) {
      this.processedPosts.add(post.id);
      return false;
    }

    // Find the original YouTube URL to convert
    let originalYouTubeUrl = null;
    for (const pattern of YOUTUBE_PATTERNS) {
      pattern.lastIndex = 0;
      const match = pattern.exec(content);
      if (match) {
        originalYouTubeUrl = match[0];
        // Ensure URL has protocol
        if (!originalYouTubeUrl.startsWith('http')) {
          originalYouTubeUrl = 'https://' + originalYouTubeUrl;
        }
        break;
      }
    }

    if (!originalYouTubeUrl) {
      this.processedPosts.add(post.id);
      return false;
    }

    try {
      const yewtubeUrl = this.convertToYewTube(originalYouTubeUrl, videoId);
      const commentText = CONFIG.COMMENT_TEMPLATE.replace('{link}', yewtubeUrl);
      
      console.log(`Found YouTube link in post ${post.id}: ${originalYouTubeUrl}`);
      console.log(`Created: ${post.createdAt}, User: ${post.user?.name || 'Unknown'}`);
      console.log(`Posting comment with yewtu.be alternative: ${yewtubeUrl}`);
      
      // Post comment on Stacker.News
      await this.postComment(post.id, commentText);
      console.log(`Successfully posted comment on post ${post.id}`);
      
      // Publish Nostr note
      await this.publishNostrNote(post.title, post.id, yewtubeUrl);
      
      this.processedPosts.add(post.id);
      
      console.log(`Successfully processed post ${post.id} (comment + Nostr note)`);
      return true;
    } catch (error) {
      console.error(`Failed to post comment on post ${post.id}:`, error);
      // Mark as processed to avoid retry loops
      this.processedPosts.add(post.id);
      return false;
    }
  }

  async run() {
    if (this.isRunning) {
      console.log('Bot is already running');
      return;
    }

    this.isRunning = true;
    
    try {
      console.log('Starting Stacker.News YouTube Bot (Recent Items Focus)...');
      console.log(`Bot public key: ${this.publicKey}`);
      
      // Load previous state
      await this.loadState();
      
      // Authenticate with Nostr
      console.log('Authenticating with Nostr...');
      await this.authenticateWithNostr();
      
      // Fetch recent posts
      console.log('Fetching recent posts...');
      const posts = await this.fetchRecentPosts();
      console.log(`Found ${posts.length} recent posts`);
      
      let processedCount = 0;
      let commentedCount = 0;
      let nostrNotesCount = 0;
      
      // Process each post
      for (const post of posts) {
        const result = await this.processPost(post);
        if (result) {
          commentedCount++;
          nostrNotesCount++;
        }
        processedCount++;
        
        // Rate limiting
        if (processedCount < posts.length) {
          await this.sleep(CONFIG.RATE_LIMIT_DELAY);
        }
      }
      
      // Save state
      await this.saveState();
      
      console.log(`Run completed: ${processedCount} posts processed, ${commentedCount} comments posted, ${nostrNotesCount} Nostr notes published`);
      
    } catch (error) {
      console.error('Bot run failed:', error);
      process.exit(1);
    } finally {
      this.isRunning = false;
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async cleanup() {
    console.log('Cleaning up...');
    
    // Close Nostr pool connections
    if (this.nostrPool) {
      try {
        this.nostrPool.close(CONFIG.NOSTR_RELAYS);
        console.log('Closed Nostr relay connections');
      } catch (error) {
        console.log('Error closing Nostr connections:', error.message);
      }
    }
    
    await this.saveState();
  }
}

// Main execution
async function main() {
  const bot = new StackerNewsBot();
  
  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nReceived SIGINT, shutting down gracefully...');
    await bot.cleanup();
    process.exit(0);
  });
  
  process.on('SIGTERM', async () => {
    console.log('\nReceived SIGTERM, shutting down gracefully...');
    await bot.cleanup();
    process.exit(0);
  });
  
  try {
    await bot.run();
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = StackerNewsBot;
