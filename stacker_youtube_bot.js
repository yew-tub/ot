// bot.js - Stacker.News YouTube to Yewtu.be Bot
const { GraphQLClient } = require('graphql-request');
const { getPublicKey, getEventHash, signEvent, generatePrivateKey } = require('nostr-tools');
const WebSocket = require('ws');

class StackerNewsBot {
  constructor() {
    this.graphqlClient = new GraphQLClient('https://stacker.news/api/graphql');
    this.processedItems = new Set();
    this.botPrivateKey = process.env.NOSTR_PRIVATE_KEY || generatePrivateKey();
    this.botPublicKey = getPublicKey(this.botPrivateKey);
    this.isAuthenticated = false;
    this.authToken = null;
    
    // YouTube URL regex patterns
    this.youtubeRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/g;
  }

  // Authenticate with Stacker.News using Nostr
  async authenticate() {
    try {
      console.log('Authenticating with Stacker.News...');
      
      // Create authentication event
      const authEvent = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['p', this.botPublicKey],
          ['t', 'stacker-news-auth']
        ],
        content: `Authenticating bot for YouTube -> Yewtu.be conversion`,
        pubkey: this.botPublicKey
      };

      authEvent.id = getEventHash(authEvent);
      authEvent.sig = signEvent(authEvent, this.botPrivateKey);

      const authMutation = `
        mutation AuthNostr($event: String!) {
          authNostr(event: $event) {
            token
            user {
              id
              name
            }
          }
        }
      `;

      const response = await this.graphqlClient.request(authMutation, {
        event: JSON.stringify(authEvent)
      });

      if (response.authNostr?.token) {
        this.authToken = response.authNostr.token;
        this.isAuthenticated = true;
        this.graphqlClient.setHeader('Authorization', `Bearer ${this.authToken}`);
        console.log('Successfully authenticated with Stacker.News');
        return true;
      }
    } catch (error) {
      console.error('Authentication failed:', error);
      return false;
    }
  }

  // Fetch recent posts and comments
  async fetchRecentContent() {
    const query = `
      query RecentContent($sort: String!, $when: String!) {
        items(sort: $sort, when: $when, limit: 50) {
          items {
            id
            title
            text
            url
            createdAt
            user {
              name
              id
            }
            comments {
              id
              text
              createdAt
              user {
                name
                id
              }
            }
          }
        }
      }
    `;

    try {
      const response = await this.graphqlClient.request(query, {
        sort: 'recent',
        when: 'day'
      });

      return response.items?.items || [];
    } catch (error) {
      console.error('Error fetching content:', error);
      return [];
    }
  }

  // Extract YouTube URLs and convert to Yewtu.be
  convertYouTubeUrls(text) {
    const matches = [];
    let match;
    
    while ((match = this.youtubeRegex.exec(text)) !== null) {
      const videoId = match[1];
      const originalUrl = match[0];
      const yewtubUrl = `https://yewtu.be/watch?v=${videoId}`;
      
      matches.push({
        original: originalUrl,
        converted: yewtubUrl,
        videoId: videoId
      });
    }
    
    return matches;
  }

  // Post a comment with Yewtu.be links
  async postComment(parentId, youtubeLinks) {
    if (!this.isAuthenticated) {
      console.log('Not authenticated, skipping comment');
      return false;
    }

    const linkText = youtubeLinks.map(link => 
      `🔗 Alternative link: ${link.converted}`
    ).join('\n');

    const commentText = `${linkText}\n\n*Privacy-friendly YouTube alternative via Yewtu.be*`;

    const mutation = `
      mutation CreateComment($text: String!, $parentId: ID!) {
        createComment(text: $text, parentId: $parentId) {
          id
          text
        }
      }
    `;

    try {
      const response = await this.graphqlClient.request(mutation, {
        text: commentText,
        parentId: parentId
      });

      console.log(`Posted comment for item ${parentId}:`, response.createComment?.id);
      return true;
    } catch (error) {
      console.error('Error posting comment:', error);
      return false;
    }
  }

  // Process a single item (post or comment)
  async processItem(item) {
    const itemKey = `${item.id}-${item.createdAt}`;
    
    if (this.processedItems.has(itemKey)) {
      return;
    }

    // Check post content
    const postContent = (item.title || '') + ' ' + (item.text || '') + ' ' + (item.url || '');
    const postYouTubeLinks = this.convertYouTubeUrls(postContent);
    
    if (postYouTubeLinks.length > 0) {
      console.log(`Found ${postYouTubeLinks.length} YouTube link(s) in post ${item.id}`);
      await this.postComment(item.id, postYouTubeLinks);
      this.processedItems.add(itemKey);
    }

    // Check comments
    for (const comment of item.comments || []) {
      const commentKey = `${comment.id}-${comment.createdAt}`;
      
      if (this.processedItems.has(commentKey)) {
        continue;
      }

      const commentYouTubeLinks = this.convertYouTubeUrls(comment.text || '');
      
      if (commentYouTubeLinks.length > 0) {
        console.log(`Found ${commentYouTubeLinks.length} YouTube link(s) in comment ${comment.id}`);
        await this.postComment(comment.id, commentYouTubeLinks);
        this.processedItems.add(commentKey);
      }
    }
  }

  // Main monitoring loop
  async start() {
    console.log('Starting Stacker.News YouTube Bot...');
    
    // Authenticate first
    const authSuccess = await this.authenticate();
    if (!authSuccess) {
      console.log('Authentication failed, running in read-only mode');
    }

    // Main monitoring loop
    while (true) {
      try {
        console.log('Fetching recent content...');
        const items = await this.fetchRecentContent();
        
        console.log(`Processing ${items.length} items...`);
        
        for (const item of items) {
          await this.processItem(item);
          // Add delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        // Clean up old processed items (keep last 1000)
        if (this.processedItems.size > 1000) {
          const itemsArray = Array.from(this.processedItems);
          this.processedItems = new Set(itemsArray.slice(-500));
        }
        
        console.log(`Processed ${items.length} items. Waiting 5 minutes...`);
        await new Promise(resolve => setTimeout(resolve, 5 * 60 * 1000)); // 5 minutes
        
      } catch (error) {
        console.error('Error in main loop:', error);
        await new Promise(resolve => setTimeout(resolve, 60 * 1000)); // Wait 1 minute on error
      }
    }
  }
}

// Run the bot
if (require.main === module) {
  const bot = new StackerNewsBot();
  bot.start().catch(console.error);
}

module.exports = StackerNewsBot;