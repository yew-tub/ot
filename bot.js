// bot.js - Updated Stacker.News YouTube to Yewtu.be Bot
const { GraphQLClient } = require('graphql-request');
const { getPublicKey, getEventHash, signEvent, generatePrivateKey, nip19 } = require('nostr-tools');

class StackerNewsBot {
  constructor() {
    this.graphqlClient = new GraphQLClient('https://stacker.news/api/graphql');
    this.processedItems = new Set();
    
    // Handle private key - support both bech32 (nsec1...) and hex formats
    let privateKey = process.env.NOSTR_PRIVATE_KEY;
    
    if (privateKey) {
      // Handle bech32 format (nsec1...)
      if (privateKey.startsWith('nsec1')) {
        try {
          const decoded = nip19.decode(privateKey);
          privateKey = decoded.data;
          console.log('Successfully decoded bech32 private key');
        } catch (error) {
          console.error('Invalid bech32 private key format:', error.message);
          throw new Error('Invalid bech32 private key format');
        }
      }
      
      // Validate hex format
      if (typeof privateKey !== 'string' || privateKey.length !== 64) {
        console.error('Private key must be 64 characters hex string, got:', typeof privateKey, privateKey?.length);
        throw new Error('Private key must be 64 characters hex string');
      }
      
      this.botPrivateKey = privateKey;
    } else {
      // Generate new key if none provided
      this.botPrivateKey = generatePrivateKey();
      console.log('Generated new private key');
    }
    
    this.botPublicKey = getPublicKey(this.botPrivateKey);
    this.isAuthenticated = false;
    this.authToken = null;
    
    // YouTube URL regex patterns
    this.youtubeRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/g;
  }

  // Test the GraphQL endpoint with a simple query
  async testGraphQLEndpoint() {
    const testQuery = `
      query TestQuery {
        __schema {
          queryType {
            name
          }
        }
      }
    `;

    try {
      const response = await this.graphqlClient.request(testQuery);
      console.log('GraphQL endpoint is accessible');
      return true;
    } catch (error) {
      console.error('GraphQL endpoint test failed:', error.message);
      return false;
    }
  }

  // Authenticate with Stacker.News using Nostr
  async authenticate() {
    try {
      console.log('Authenticating with Stacker.News...');
      
      // Test endpoint first
      const endpointWorking = await this.testGraphQLEndpoint();
      if (!endpointWorking) {
        console.error('GraphQL endpoint is not accessible');
        return false;
      }
      
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

      // Try different authentication mutation formats
      const authMutations = [
        // Current format
        `
          mutation AuthNostr($event: String!) {
            authNostr(event: $event) {
              token
              user {
                id
                name
              }
            }
          }
        `,
        // Alternative format with eventData
        `
          mutation AuthNostr($eventData: String!) {
            authNostr(eventData: $eventData) {
              token
              user {
                id
                name
              }
            }
          }
        `,
        // Alternative format with input object
        `
          mutation AuthNostr($input: AuthNostrInput!) {
            authNostr(input: $input) {
              token
              user {
                id
                name
              }
            }
          }
        `
      ];

      for (const [index, authMutation] of authMutations.entries()) {
        try {
          console.log(`Trying authentication method ${index + 1}...`);
          
          let variables;
          if (index === 0) {
            variables = { event: JSON.stringify(authEvent) };
          } else if (index === 1) {
            variables = { eventData: JSON.stringify(authEvent) };
          } else {
            variables = { input: { event: JSON.stringify(authEvent) } };
          }

          const response = await this.graphqlClient.request(authMutation, variables);

          if (response.authNostr?.token) {
            this.authToken = response.authNostr.token;
            this.isAuthenticated = true;
            this.graphqlClient.setHeader('Authorization', `Bearer ${this.authToken}`);
            console.log('Successfully authenticated with Stacker.News');
            return true;
          }
        } catch (error) {
          console.log(`Authentication method ${index + 1} failed:`, error.message);
          if (index === authMutations.length - 1) {
            console.error('All authentication methods failed');
          }
        }
      }

      return false;
    } catch (error) {
      console.error('Authentication failed:', error);
      return false;
    }
  }

  // Fetch recent posts and comments with improved error handling
  async fetchRecentContent() {
    // Try different query formats
    const queries = [
      // Current format
      {
        query: `
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
        `,
        variables: { sort: 'recent', when: 'day' }
      },
      // Alternative format with different field names
      {
        query: `
          query RecentContent($sort: String!, $when: String!) {
            items(sort: $sort, when: $when, limit: 50) {
              cursor
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
        `,
        variables: { sort: 'recent', when: 'day' }
      },
      // Simplified query without comments
      {
        query: `
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
              }
            }
          }
        `,
        variables: { sort: 'recent', when: 'day' }
      },
      // Alternative with different parameter names
      {
        query: `
          query RecentContent($sort: ItemSort!, $when: ItemWhen!) {
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
              }
            }
          }
        `,
        variables: { sort: 'RECENT', when: 'DAY' }
      }
    ];

    for (const [index, { query, variables }] of queries.entries()) {
      try {
        console.log(`Trying query format ${index + 1}...`);
        const response = await this.graphqlClient.request(query, variables);
        
        if (response.items?.items) {
          console.log(`Successfully fetched ${response.items.items.length} items`);
          return response.items.items;
        }
      } catch (error) {
        console.log(`Query format ${index + 1} failed:`, error.message);
        if (index === queries.length - 1) {
          console.error('All query formats failed');
        }
      }
    }

    return [];
  }

  // Fetch comments for a specific item
  async fetchItemComments(itemId) {
    const query = `
      query ItemComments($id: ID!) {
        item(id: $id) {
          id
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
    `;

    try {
      const response = await this.graphqlClient.request(query, { id: itemId });
      return response.item?.comments || [];
    } catch (error) {
      console.error(`Error fetching comments for item ${itemId}:`, error.message);
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

    // Try different mutation formats
    const mutations = [
      // Current format
      `
        mutation CreateComment($text: String!, $parentId: ID!) {
          createComment(text: $text, parentId: $parentId) {
            id
            text
          }
        }
      `,
      // Alternative format with input object
      `
        mutation CreateComment($input: CreateCommentInput!) {
          createComment(input: $input) {
            id
            text
          }
        }
      `,
      // Alternative format with different field names
      `
        mutation CreateComment($content: String!, $parentId: ID!) {
          createComment(content: $content, parentId: $parentId) {
            id
            text
          }
        }
      `
    ];

    for (const [index, mutation] of mutations.entries()) {
      try {
        console.log(`Trying comment creation method ${index + 1}...`);
        
        let variables;
        if (index === 0) {
          variables = { text: commentText, parentId: parentId };
        } else if (index === 1) {
          variables = { input: { text: commentText, parentId: parentId } };
        } else {
          variables = { content: commentText, parentId: parentId };
        }

        const response = await this.graphqlClient.request(mutation, variables);
        
        if (response.createComment?.id) {
          console.log(`Posted comment for item ${parentId}:`, response.createComment.id);
          return true;
        }
      } catch (error) {
        console.log(`Comment creation method ${index + 1} failed:`, error.message);
        if (index === mutations.length - 1) {
          console.error('All comment creation methods failed');
        }
      }
    }

    return false;
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
      const success = await this.postComment(item.id, postYouTubeLinks);
      if (success) {
        this.processedItems.add(itemKey);
      }
    }

    // Check comments - either from the initial fetch or fetch separately
    let comments = item.comments || [];
    if (comments.length === 0) {
      comments = await this.fetchItemComments(item.id);
    }

    for (const comment of comments) {
      const commentKey = `${comment.id}-${comment.createdAt}`;
      
      if (this.processedItems.has(commentKey)) {
        continue;
      }

      const commentYouTubeLinks = this.convertYouTubeUrls(comment.text || '');
      
      if (commentYouTubeLinks.length > 0) {
        console.log(`Found ${commentYouTubeLinks.length} YouTube link(s) in comment ${comment.id}`);
        const success = await this.postComment(comment.id, commentYouTubeLinks);
        if (success) {
          this.processedItems.add(commentKey);
        }
      }
    }
  }

  // Test individual GraphQL operations
  async testOperations() {
    console.log('Testing GraphQL operations...');
    
    // Test items query
    try {
      const items = await this.fetchRecentContent();
      console.log(`✓ Items query working - fetched ${items.length} items`);
    } catch (error) {
      console.log('✗ Items query failed:', error.message);
    }
    
    // Test authentication
    try {
      const authSuccess = await this.authenticate();
      console.log(`${authSuccess ? '✓' : '✗'} Authentication ${authSuccess ? 'successful' : 'failed'}`);
    } catch (error) {
      console.log('✗ Authentication failed:', error.message);
    }
  }

  // Main monitoring loop
  async start() {
    console.log('Starting Stacker.News YouTube Bot...');
    
    // Test operations first
    await this.testOperations();
    
    // Try to authenticate
    const authSuccess = await this.authenticate();
    if (!authSuccess) {
      console.log('Authentication failed, running in read-only mode');
    }

    // Main monitoring loop
    while (true) {
      try {
        console.log('Fetching recent content...');
        const items = await this.fetchRecentContent();
        
        if (items.length === 0) {
          console.log('No items fetched, waiting before retrying...');
          await new Promise(resolve => setTimeout(resolve, 2 * 60 * 1000)); // 2 minutes
          continue;
        }
        
        console.log(`Processing ${items.length} items...`);
        
        for (const item of items) {
          await this.processItem(item);
          // Add delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 2000)); // 2 seconds
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
        await new Promise(resolve => setTimeout(resolve, 2 * 60 * 1000)); // Wait 2 minutes on error
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
