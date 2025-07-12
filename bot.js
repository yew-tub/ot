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

// GraphQL queries - Updated to match current schema
const QUERIES = {
  // Try different possible query structures
  RECENT_POSTS_V1: `
    query {
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
    }
  `,
  
  RECENT_POSTS_V2: `
    query recentPosts($first: Int!) {
      items(first: $first, orderBy: createdAt_DESC) {
        id
        title
        text
        url
        createdAt
        user {
          name
        }
      }
    }
  `,
  
  RECENT_POSTS_V3: `
    query recentPosts($first: Int!) {
      posts(first: $first, orderBy: createdAt_DESC) {
        id
        title
        text
        url
        createdAt
        user {
          name
        }
      }
    }
  `,
  
  // Alternative structure based on common GraphQL patterns
  RECENT_POSTS_V4: `
    query recentPosts {
      items {
        edges {
          node {
            id
            title
            text
            url
            createdAt
            user {
              name
            }
          }
        }
      }
    }
  `,
  
  // Simple introspection query to understand the schema
  INTROSPECTION: `
    query {
      __schema {
        queryType {
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
  `,
  
  POST_COMMENT: `
    mutation createComment($id: ID!, $text: String!) {
      createComment(id: $id, text: $text) {
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
    this.workingQuery = null; // Store the working query once found
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
      console.log(`Loaded ${this.processedPosts.size} processed posts from state`);
    } catch (error) {
      console.log('No previous state found, starting fresh');
    }
  }

  async saveState() {
    const state = {
      processedPosts: Array.from(this.processedPosts),
      workingQuery: this.workingQuery,
      lastRun: new Date().toISOString()
    };
    await fs.writeFile(CONFIG.STATE_FILE, JSON.stringify(state, null, 2));
    console.log('State saved');
  }

  async discoverSchema() {
    try {
      console.log('Discovering GraphQL schema...');
      const response = await this.client.request(QUERIES.INTROSPECTION);
      const queryFields = response.__schema.queryType.fields;
      
      console.log('Available query fields:');
      queryFields.forEach(field => {
        console.log(`  - ${field.name}: ${field.type.name || field.type.kind}`);
      });
      
      return queryFields;
    } catch (error) {
      console.log('Schema introspection failed:', error.message);
      return null;
    }
  }

  async findWorkingQuery() {
    if (this.workingQuery) {
      return this.workingQuery;
    }

    console.log('Testing different query formats...');
    
    // Test queries in order of preference
    const queryTests = [
      { name: 'RECENT_POSTS_V1', query: QUERIES.RECENT_POSTS_V1, vars: {} },
      { name: 'RECENT_POSTS_V2', query: QUERIES.RECENT_POSTS_V2, vars: { first: CONFIG.SCAN_LIMIT } },
      { name: 'RECENT_POSTS_V3', query: QUERIES.RECENT_POSTS_V3, vars: { first: CONFIG.SCAN_LIMIT } },
      { name: 'RECENT_POSTS_V4', query: QUERIES.RECENT_POSTS_V4, vars: {} }
    ];

    for (const test of queryTests) {
      try {
        console.log(`Testing ${test.name}...`);
        const response = await this.client.request(test.query, test.vars);
        console.log(`✓ ${test.name} works!`);
        this.workingQuery = test.name;
        return test.name;
      } catch (error) {
        console.log(`✗ ${test.name} failed: ${error.message}`);
      }
    }

    throw new Error('No working query found. Schema may have changed significantly.');
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
    const url = new URL(originalUrl);
    const searchParams = new URLSearchParams(url.search);
    
    // Build yewtu.be URL
    let yewtubeUrl = `${CONFIG.YEWTU_BE_BASE}/watch?v=${videoId}`;
    
    // Add timestamp if present
    if (searchParams.has('t')) {
      yewtubeUrl += `&t=${searchParams.get('t')}`;
    }
    
    return yewtubeUrl;
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

      let query, variables;
      
      switch (this.workingQuery) {
        case 'RECENT_POSTS_V1':
          query = QUERIES.RECENT_POSTS_V1;
          variables = {};
          break;
        case 'RECENT_POSTS_V2':
          query = QUERIES.RECENT_POSTS_V2;
          variables = { first: CONFIG.SCAN_LIMIT };
          break;
        case 'RECENT_POSTS_V3':
          query = QUERIES.RECENT_POSTS_V3;
          variables = { first: CONFIG.SCAN_LIMIT };
          break;
        case 'RECENT_POSTS_V4':
          query = QUERIES.RECENT_POSTS_V4;
          variables = {};
          break;
        default:
          throw new Error('No working query available');
      }

      const response = await this.client.request(query, variables);
      
      // Extract items based on response structure
      let items = [];
      if (response.items) {
        if (Array.isArray(response.items)) {
          items = response.items;
        } else if (response.items.edges) {
          items = response.items.edges.map(edge => edge.node);
        }
      } else if (response.posts) {
        items = response.posts;
      }

      return items;
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
      const response = await this.client.request(QUERIES.POST_COMMENT, {
        id: postId,
        text: text
      });
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
      
      // Discover schema if needed
      if (!this.workingQuery) {
        await this.discoverSchema();
      }
      
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
