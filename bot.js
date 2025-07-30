#!/usr/bin/env node

/**
 * Stacker.News YouTube Link Bot
 * Monitors for YouTube links and posts yewtu.be alternatives
 */

const { getPublicKey, finalizeEvent, verifyEvent, nip19 } = require('nostr-tools');
const { GraphQLClient } = require('graphql-request');
const fs = require('fs').promises;
const path = require('path');

// Configuration
const CONFIG = {
  STACKER_NEWS_API: 'https://stacker.news/api/graphql',
  YEWTU_BE_BASE: 'https://yewtu.be',
  COMMENT_TEMPLATE: '🔗 Privacy-friendly: {link}',
  SCAN_LIMIT: 50, // Number of recent posts to scan
  RATE_LIMIT_DELAY: 2000, // ms between API calls
  STATE_FILE: './.bot-state.json'
};

// YouTube URL patterns
const YOUTUBE_PATTERNS = [
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/gi,
  /(?:https?:\/\/)?(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]{11})/gi,
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/gi,
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/v\/([a-zA-Z0-9_-]{11})/gi,
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/gi
];

// GraphQL queries - Need to discover the actual structure
const QUERIES = {
  // Deep introspection to understand Items and Item types
  DEEP_INTROSPECTION: `
    query {
      __schema {
        types {
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
  `,
  
  // Test what arguments items field accepts
  ITEMS_INTROSPECTION: `
    query {
      __type(name: "Query") {
        fields {
          name
          args {
            name
            type {
              name
              kind
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
              }
            }
          }
        }
      }
    }
  `,
  
  // Basic query to test items field structure
  TEST_ITEMS_BASIC: `
    query {
      items {
        __typename
      }
    }
  `,
  
  // Test with suggested arguments
  TEST_ITEMS_WITH_ARGS: `
    query testItems($sort: String, $limit: Int, $from: String) {
      items(sort: $sort, limit: $limit, from: $from) {
        __typename
      }
    }
  `,
  
  // Comment mutation - might need adjustment
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

  async discoverDetailedSchema() {
    if (this.schemaInfo) {
      return this.schemaInfo;
    }

    try {
      console.log('Performing deep schema introspection...');
      const response = await this.makeGraphQLRequest(QUERIES.DEEP_INTROSPECTION);
      
      // Find Items and Item types
      const itemsType = response.__schema.types.find(t => t.name === 'Items');
      const itemType = response.__schema.types.find(t => t.name === 'Item');
      
      console.log('\n=== Items Type Structure ===');
      if (itemsType && itemsType.fields) {
        itemsType.fields.forEach(field => {
          console.log(`  - ${field.name}: ${field.type.name || field.type.kind}`);
        });
      } else {
        console.log('  Items type not found or has no fields');
      }
      
      console.log('\n=== Item Type Structure ===');
      if (itemType && itemType.fields) {
        itemType.fields.forEach(field => {
          console.log(`  - ${field.name}: ${field.type.name || field.type.kind}`);
        });
      } else {
        console.log('  Item type not found or has no fields');
      }
      
      // Store schema info
      this.schemaInfo = {
        itemsType: itemsType,
        itemType: itemType,
        discoveredAt: new Date().toISOString()
      };
      
      return this.schemaInfo;
    } catch (error) {
      console.log('Deep schema introspection failed:', error.message);
      return null;
    }
  }

  async buildWorkingQuery() {
    console.log('\nBuilding working query based on schema...');
    
    // Get schema info
    const schema = await this.discoverDetailedSchema();
    if (!schema) {
      throw new Error('Could not discover schema structure');
    }
    
    // Test basic items query first
    try {
      console.log('Testing basic items query...');
      const response = await this.makeGraphQLRequest(QUERIES.TEST_ITEMS_BASIC);
      console.log('Basic items response:', JSON.stringify(response, null, 2));
      
      // Now test with arguments
      console.log('Testing items query with arguments...');
      const argsResponse = await this.makeGraphQLRequest(QUERIES.TEST_ITEMS_WITH_ARGS, {
        sort: 'recent',
        limit: 10
      });
      console.log('Items with args response:', JSON.stringify(argsResponse, null, 2));
      
      // Build query based on discovered structure
      let queryFields = [];
      
      // Check what fields are available on Items type
      if (schema.itemsType && schema.itemsType.fields) {
        for (const field of schema.itemsType.fields) {
          if (field.name !== '__typename') {
            queryFields.push(field.name);
          }
        }
      }
      
      // If Items has an items field that returns Item array, use that
      const itemsField = schema.itemsType?.fields?.find(f => f.name === 'items');
      if (itemsField) {
        console.log('Found items field on Items type');
        
        // Build nested query for Item fields
        let itemFields = [];
        if (schema.itemType && schema.itemType.fields) {
          for (const field of schema.itemType.fields) {
            if (['id', 'title', 'text', 'url', 'createdAt'].includes(field.name)) {
              itemFields.push(field.name);
            }
            if (field.name === 'user') {
              itemFields.push('user { name }');
            }
          }
        }
        
        const workingQuery = `
          query getRecentItems($sort: String, $limit: Int, $from: String) {
            items(sort: $sort, limit: $limit, from: $from) {
              items {
                ${itemFields.join('\n                ')}
              }
              ${queryFields.filter(f => f !== 'items').join('\n              ')}
            }
          }
        `;
        
        console.log('Built working query:', workingQuery);
        
        // Test the query
        const testResponse = await this.makeGraphQLRequest(workingQuery, {
          sort: 'recent',
          limit: 5
        });
        
        console.log('✓ Working query successful!');
        this.workingQuery = {
          name: 'DYNAMIC_ITEMS_QUERY',
          query: workingQuery,
          variables: { sort: 'recent', limit: CONFIG.SCAN_LIMIT }
        };
        
        return this.workingQuery;
      }
      
    } catch (error) {
      console.log('Query building failed:', error.message);
      throw error;
    }
  }

  async findWorkingQuery() {
    if (this.workingQuery) {
      return this.workingQuery;
    }

    try {
      return await this.buildWorkingQuery();
    } catch (error) {
      console.log('Dynamic query building failed, trying manual discovery...');
      
      // Fallback: try to use schema discovery output to build simple queries
      const simpleTests = [
        {
          name: 'ITEMS_ONLY',
          query: 'query { items { __typename } }',
          variables: {}
        },
        {
          name: 'ITEMS_WITH_CURSOR',
          query: 'query { items { cursor } }',
          variables: {}
        }
      ];
      
      for (const test of simpleTests) {
        try {
          console.log(`Testing ${test.name}...`);
          const response = await this.makeGraphQLRequest(test.query, test.variables);
          console.log(`✓ ${test.name} works:`, JSON.stringify(response, null, 2));
          
          // This gives us basic structure, but we need to figure out how to get actual items
          console.log('Basic query works, but need to find actual item data...');
          
        } catch (error) {
          console.log(`✗ ${test.name} failed:`, error.message);
        }
      }
      
      throw new Error('Could not find any working query structure');
    }
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

      const response = await this.makeGraphQLRequest(
        this.workingQuery.query, 
        this.workingQuery.variables
      );
      
      console.log('Raw API response:', JSON.stringify(response, null, 2));
      
      // Extract items based on response structure
      let items = [];
      
      if (response.items) {
        // Handle nested items structure
        if (response.items.items && Array.isArray(response.items.items)) {
          items = response.items.items;
        }
        // Handle direct array
        else if (Array.isArray(response.items)) {
          items = response.items;
        }
        // Handle edges structure (GraphQL Relay pattern)
        else if (response.items.edges) {
          items = response.items.edges.map(edge => edge.node);
        }
      }

      console.log(`Extracted ${items.length} items from response`);
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
      
      await this.postComment(post.id, commentText);
      this.processedPosts.add(post.id);
      
      console.log(`Successfully posted comment on post ${post.id}`);
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
      
      // Discover schema and build working query
      console.log('Discovering GraphQL schema...');
      await this.discoverDetailedSchema();
      
      // Authenticate with Nostr
      console.log('Authenticating with Nostr...');
      await this.authenticateWithNostr();
      
      // Fetch recent posts
      console.log('Fetching recent posts...');
      const posts = await this.fetchRecentPosts();
      console.log(`Found ${posts.length} recent posts`);
      
      let processedCount = 0;
      let commentedCount = 0;
      
      // Process each post
      for (const post of posts) {
        const result = await this.processPost(post);
        if (result) {
          commentedCount++;
        }
        processedCount++;
        
        // Rate limiting
        if (processedCount < posts.length) {
          await this.sleep(CONFIG.RATE_LIMIT_DELAY);
        }
      }
      
      // Save state
      await this.saveState();
      
      console.log(`Run completed: ${processedCount} posts processed, ${commentedCount} comments posted`);
      
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
