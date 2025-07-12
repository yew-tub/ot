#!/usr/bin/env node

/**
 * Stacker.News YouTube Link Bot
 * Monitors for YouTube links and posts yewtu.be alternatives
 */

const { getPublicKey, finalizeEvent, verifyEvent } = require('nostr-tools');
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

// GraphQL queries
const QUERIES = {
  RECENT_POSTS: `
    query recentPosts($limit: Int!) {
      items(sort: "recent", limit: $limit) {
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
  
  POST_COMMENT: `
    mutation createComment($id: ID!, $text: String!) {
      createComment(id: $id, text: $text) {
        id
      }
    }
  `
};

class StackerNewsBot {
  constructor() {
    this.privateKey = this.getPrivateKey();
    this.publicKey = getPublicKey(this.privateKey);
    this.client = new GraphQLClient(CONFIG.STACKER_NEWS_API);
    this.processedPosts = new Set();
    this.isRunning = false;
  }

  getPrivateKey() {
    const privateKey = process.env.NOSTR_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error('NOSTR_PRIVATE_KEY environment variable is required');
    }
    return privateKey;
  }

  async loadState() {
    try {
      const stateData = await fs.readFile(CONFIG.STATE_FILE, 'utf8');
      const state = JSON.parse(stateData);
      this.processedPosts = new Set(state.processedPosts || []);
      console.log(`Loaded ${this.processedPosts.size} processed posts from state`);
    } catch (error) {
      console.log('No previous state found, starting fresh');
    }
  }

  async saveState() {
    const state = {
      processedPosts: Array.from(this.processedPosts),
      lastRun: new Date().toISOString()
    };
    await fs.writeFile(CONFIG.STATE_FILE, JSON.stringify(state, null, 2));
    console.log('State saved');
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
      const response = await this.client.request(QUERIES.RECENT_POSTS, {
        limit: CONFIG.SCAN_LIMIT
      });
      return response.items || [];
    } catch (error) {
      console.error('Error fetching posts:', error);
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
