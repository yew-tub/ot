#!/usr/bin/env node

/**
 * Stacker.News YouTube Link Bot
 * Monitors for YouTube links and posts yewtu.be alternatives
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
  NOSTR_NOTE_TEMPLATE: '{title}\n\n{stackerLink}/r/YewTuBot\n\n#YewTuBot #Video #watch #grownostr #Videostr #INVIDIOUS', // Privacy-friendly YouTube: {yewtuLink}
  SCAN_LIMIT: 50, // Number of recent posts to scan
  RATE_LIMIT_DELAY: 2000, // ms between API calls
  STATE_FILE: './.bot-state.json',
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

// GraphQL queries
const QUERIES = {
  // Detailed introspection to understand parameter types
  DETAILED_INTROSPECTION: `
    query {
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
                }
              }
            }
            type {
              name
              kind
              fields {
                name
                type {
                  name
                  kind
                  ofType {
                    name
                    kind
                  }
                }
              }
            }
          }
        }
      }
    }
  `,
  
  // Test items with no arguments
  TEST_ITEMS_NO_ARGS: `
    query {
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
  
  // Test items with sort only (String type)
  TEST_ITEMS_SORT_ONLY: `
    query testItemsSort($sort: String) {
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
  
  // Test items with different limit approaches
  TEST_ITEMS_LIMIT_INT: `
    query testItemsLimitInt($limit: Int) {
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
  
  // Test items with Limit scalar type
  TEST_ITEMS_LIMIT_SCALAR: `
    query testItemsLimitScalar($limit: Limit) {
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
  
  // Test with from parameter
  TEST_ITEMS_FROM: `
    query testItemsFrom($from: String) {
      items(from: $from) {
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
    this.privateKey = this.getPrivateKey();
    this.publicKey = getPublicKey(this.privateKey);
    this.client = new GraphQLClient(CONFIG.STACKER_NEWS_API);
    this.nostrPool = new SimplePool();
    this.processedPosts = new Set();
    this.isRunning = false;
    this.workingQuery = null;
    this.schemaInfo = null;
  }

  getPrivateKey() {
    let privateKey = process.env.NOSTR_PRIVATE_KEY;
    
    if (!privateKey) {
      throw new Error('NOSTR_PRIVATE_KEY environment variable is required');
    }
    
    // Convert nsec1 to hex if needed
    if (privateKey.startsWith('nsec1')) {
      console.log('Converting nsec1 private key to hex format...');
      privateKey = nsecToHex(privateKey);
    }
    
    return privateKey;
  }

  async loadState() {
    try {
      const stateData = await fs.readFile(CONFIG.STATE_FILE, 'utf8');
      const state = JSON.parse(stateData);
      this.processedPosts = new Set(state.processedPosts || []);
      this.workingQuery = state.workingQuery || null;
      this.schemaInfo = state.schemaInfo || null;
      console.log(`Loaded ${this.processedPosts.size} processed posts from state`);
    } catch (error) {
      console.log('No previous state found, starting fresh');
    }
  }

  async saveState() {
    const state = {
      processedPosts: Array.from(this.processedPosts),
      workingQuery: this.workingQuery,
      schemaInfo: this.schemaInfo,
      lastRun: new Date().toISOString()
    };
    await fs.writeFile(CONFIG.STATE_FILE, JSON.stringify(state, null, 2));
    console.log('State saved');
  }

  async makeGraphQLRequest(query, variables = {}) {
    try {
      const response = await this.client.request(query, variables);
      return response;
    } catch (error) {
      console.log(`GraphQL request failed: ${error.message}`);
      if (error.response) {
        console.log('Response details:', JSON.stringify({
          response: {
            errors: error.response.errors,
            status: error.response.status,
            headers: error.response.headers
          },
          request: {
            query: query.slice(0, 200) + '...',
            variables
          }
        }));
      }
      throw error;
    }
  }

  async discoverParameterTypes() {
    if (this.schemaInfo) {
      return this.schemaInfo;
    }

    try {
      console.log('Discovering parameter types for items field...');
      const response = await this.makeGraphQLRequest(QUERIES.DETAILED_INTROSPECTION);
      
      // Find the items field in Query type
      const itemsField = response.__schema.queryType.fields.find(f => f.name === 'items');
      
      if (itemsField) {
        console.log('\n=== Items Field Parameters ===');
        itemsField.args.forEach(arg => {
          const typeName = arg.type.name || arg.type.ofType?.name || arg.type.kind;
          console.log(`  - ${arg.name}: ${typeName} (${arg.type.kind})`);
        });
        
        console.log('\n=== Items Return Type Structure ===');
        if (itemsField.type.fields) {
          itemsField.type.fields.forEach(field => {
            const typeName = field.type.name || field.type.ofType?.name || field.type.kind;
            console.log(`  - ${field.name}: ${typeName} (${field.type.kind})`);
          });
        }
      }
      
      this.schemaInfo = {
        itemsField: itemsField,
        discoveredAt: new Date().toISOString()
      };
      
      return this.schemaInfo;
    } catch (error) {
      console.log('Parameter type discovery failed:', error.message);
      return null;
    }
  }

  async findWorkingQuery() {
    if (this.workingQuery) {
      return this.workingQuery;
    }

    console.log('\nTesting different query approaches...');
    
    // Discover parameter types first
    await this.discoverParameterTypes();
    
    // Test queries in order of complexity
    const queryTests = [
      {
        name: 'NO_ARGS',
        query: QUERIES.TEST_ITEMS_NO_ARGS,
        variables: {}
      },
      {
        name: 'SORT_ONLY',
        query: QUERIES.TEST_ITEMS_SORT_ONLY,
        variables: { sort: 'recent' }
      },
      {
        name: 'FROM_ONLY',
        query: QUERIES.TEST_ITEMS_FROM,
        variables: { from: '' }
      },
      {
        name: 'LIMIT_INT',
        query: QUERIES.TEST_ITEMS_LIMIT_INT,
        variables: { limit: 10 }
      },
      {
        name: 'LIMIT_SCALAR',
        query: QUERIES.TEST_ITEMS_LIMIT_SCALAR,
        variables: { limit: 10 }
      }
    ];

    for (const test of queryTests) {
      try {
        console.log(`Testing ${test.name}...`);
        const response = await this.makeGraphQLRequest(test.query, test.variables);
        
        // Check if we got items back
        if (response && response.items && response.items.items && Array.isArray(response.items.items)) {
          console.log(`✓ ${test.name} succeeded! Got ${response.items.items.length} items`);
          
          // Show sample item structure
          if (response.items.items.length > 0) {
            console.log('Sample item:', JSON.stringify(response.items.items[0], null, 2));
          }
          
          this.workingQuery = {
            name: test.name,
            query: test.query,
            variables: test.variables
          };
          
          return this.workingQuery;
        } else {
          console.log(`✗ ${test.name} returned unexpected structure:`, JSON.stringify(response, null, 2));
        }
      } catch (error) {
        console.log(`✗ ${test.name} failed: ${error.message}`);
      }
    }

    throw new Error('No working query found');
  }

  extractYouTubeId(text) {
    if (!text) return null;
    
    for (const pattern of YOUTUBE_PATTERNS) {
      pattern.lastIndex = 0; // Reset regex state
      const match = pattern.exec(text);
      if (match) {
        return match[1];
      }
    }
    return null;
  }

  convertToYewTube(originalUrl, videoId) {
    // Preserve query parameters if present
    try {
      const url = new URL(originalUrl);
      const searchParams = new URLSearchParams(url.search);
      
      // Build yewtu.be URL
      let yewtubeUrl = `${CONFIG.YEWTU_BE_BASE}/watch?v=${videoId}`;
      
      // Add timestamp if present
      if (searchParams.has('t')) {
        yewtubeUrl += `&t=${searchParams.get('t')}`;
      }
      
      return yewtubeUrl;
    } catch (error) {
      // Fallback for malformed URLs
      return `${CONFIG.YEWTU_BE_BASE}/watch?v=${videoId}`;
    }
  }

  async authenticateWithNostr() {
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
    
    return signedEvent;
  }

  async fetchRecentPosts() {
    try {
      // Find a working query if we don't have one
      if (!this.workingQuery) {
        await this.findWorkingQuery();
      }

      // Build query with appropriate limit for production use
      let variables = { ...this.workingQuery.variables };
      
      // If this is the working query and it supports parameters, set appropriate values
      if (this.workingQuery.name === 'SORT_ONLY') {
        variables = { sort: 'recent' };
      } else if (this.workingQuery.name === 'LIMIT_INT') {
        variables = { limit: CONFIG.SCAN_LIMIT };
      } else if (this.workingQuery.name === 'LIMIT_SCALAR') {
        variables = { limit: CONFIG.SCAN_LIMIT };
      }

      console.log(`Using query: ${this.workingQuery.name} with variables:`, variables);
      const response = await this.makeGraphQLRequest(this.workingQuery.query, variables);
      
      // Extract items
      let items = [];
      if (response && response.items && response.items.items && Array.isArray(response.items.items)) {
        items = response.items.items;
      }

      console.log(`Successfully fetched ${items.length} items`);
      return items.filter(item => item && item.id); // Filter out null/undefined items
    } catch (error) {
      console.error('Error fetching posts:', error);
      
      // If our working query suddenly fails, reset it
      if (this.workingQuery) {
        console.log('Working query failed, will try to discover new one next time');
        this.workingQuery = null;
      }
      
      return [];
    }
  }

  async publishNostrNote(title, postId, yewtubeUrl) {
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
      
      console.log(`Publishing Nostr note for post ${postId}...`);
      console.log(`Note content: ${noteContent}`);
      
      // Publish to relays
      const publishPromises = CONFIG.NOSTR_RELAYS.map(relay => 
        this.publishToRelay(relay, signedEvent)
      );
      
      const results = await Promise.allSettled(publishPromises);
      
      // Count successful publications
      const successful = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;
      
      console.log(`Nostr note published to ${successful}/${CONFIG.NOSTR_RELAYS.length} relays (${failed} failed)`);
      
      if (failed > 0) {
        const failedRelays = results
          .map((r, i) => r.status === 'rejected' ? CONFIG.NOSTR_RELAYS[i] : null)
          .filter(Boolean);
        console.log('Failed relays:', failedRelays);
      }
      
      return { successful, failed, total: CONFIG.NOSTR_RELAYS.length };
    } catch (error) {
      console.error('Error publishing Nostr note:', error);
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
          console.log(`Connected to ${relayUrl}`);
        });
        
        relay.on('error', (error) => {
          clearTimeout(timeoutId);
          reject(new Error(`Relay error for ${relayUrl}: ${error.message}`));
        });
        
        // Publish the event
        const pub = relay.publish(event);
        
        pub.on('ok', () => {
          clearTimeout(timeoutId);
          console.log(`✓ Successfully published to ${relayUrl}`);
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
      console.log('Starting Stacker.News YouTube Bot...');
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
