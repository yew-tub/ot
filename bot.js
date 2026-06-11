// Test utilities that don't require a full bot instance
const { getPublicKey } = require('nostr-tools');

// Mock data for testing
const mockPosts = [
  {
    id: "1",
    title: "Check out this video",
    text: "Amazing content: https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    url: null,
    createdAt: new Date().toISOString(),
    user: { name: "testuser" }
  },
  {
    id: "2",
    title: "Another post",
    text: "Short link: https://youtu.be/dQw4w9WgXcQ",
    url: null,
    createdAt: new Date().toISOString(),
    user: { name: "testuser2" }
  },
  {
    id: "3",
    title: "No YouTube link",
    text: "Just a regular post about bitcoin",
    url: null,
    createdAt: new Date().toISOString(),
    user: { name: "testuser3" }
  }
];

// Configuration (copied from bot.js)
const CONFIG = {
  INVIDIOUS_INSTANCES: ['https://yewtu.be'],
  COMMENT_TEMPLATE: '🔗 Privacy-friendly: {link}'
};

// YouTube URL patterns (copied from bot.js)
const YOUTUBE_PATTERNS = [
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/gi,
  /(?:https?:\/\/)?(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]{11})/gi,
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/gi,
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/v\/([a-zA-Z0-9_-]{11})/gi,
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/gi
];

// Test functions that don't require bot instance
function extractYouTubeId(text) {
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

function pickInvidiousInstance() {
  return CONFIG.INVIDIOUS_INSTANCES[Math.floor(Math.random() * CONFIG.INVIDIOUS_INSTANCES.length)];
}

function convertToInvidious(originalUrl, videoId) {
  const url = new URL(originalUrl);
  const searchParams = new URLSearchParams(url.search);
  const instance = pickInvidiousInstance();
  
  let invidiousUrl = `${instance}/watch?v=${videoId}`;
  if (searchParams.has('t')) {
    invidiousUrl += `&t=${searchParams.get('t')}`;
  }
  
  return invidiousUrl;
}

async function testBot() {
  console.log('Testing YouTube link detection...');
  
  // Test YouTube ID extraction
  const testCases = [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://youtube.com/embed/dQw4w9WgXcQ',
    'https://youtube.com/v/dQw4w9WgXcQ',
    'https://youtube.com/shorts/dQw4w9WgXcQ',
    'Check out this video: https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s',
    'No YouTube link here'
  ];
  
  console.log('\n=== Testing YouTube ID Extraction ===');
  testCases.forEach(url => {
    const videoId = extractYouTubeId(url);
    console.log(`Input: ${url}`);
    console.log(`Video ID: ${videoId || 'None'}`);
    console.log('---');
  });
  
  // Test URL conversion
  console.log('\n=== Testing URL Conversion ===');
  const youtubeUrls = [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s',
    'https://youtu.be/dQw4w9WgXcQ'
  ];
  
  youtubeUrls.forEach(url => {
    const videoId = extractYouTubeId(url);
    if (videoId) {
      const invidiousUrl = convertToInvidious(url, videoId);
      console.log(`Original: ${url}`);
      console.log(`Invidious: ${invidiousUrl}`);
      console.log('---');
    }
  });
  
  // Test comment template
  console.log('\n=== Testing Comment Template ===');
  const sampleUrl = 'https://yewtu.be/watch?v=dQw4w9WgXcQ';
  const commentText = CONFIG.COMMENT_TEMPLATE.replace('{link}', sampleUrl);
  console.log('Generated comment:');
  console.log(commentText);
  
  // Test with mock posts
  console.log('\n=== Testing with Mock Posts ===');
  mockPosts.forEach(post => {
    const content = `${post.title || ''} ${post.text || ''} ${post.url || ''}`;
    const videoId = extractYouTubeId(content);
    console.log(`Post ID: ${post.id}`);
    console.log(`Content: ${content.trim()}`);
    console.log(`YouTube detected: ${videoId ? 'Yes (' + videoId + ')' : 'No'}`);
    
    if (videoId) {
      // Find the original URL for conversion
      for (const pattern of YOUTUBE_PATTERNS) {
        pattern.lastIndex = 0;
        const match = pattern.exec(content);
        if (match) {
          const originalUrl = match[0];
          const invidiousUrl = convertToInvidious(originalUrl, videoId);
          console.log(`Would post: ${invidiousUrl}`);
          break;
        }
      }
    }
    console.log('---');
  });
  
  console.log('\n=== Testing Complete ===');
  console.log('✅ If you see video IDs extracted correctly and Invidious URLs generated, the bot logic is working!');
  console.log('💡 To test with real API calls, set NOSTR_PRIVATE_KEY and run: node test.js --api');
}

// Advanced testing with API calls (requires NOSTR_PRIVATE_KEY)
async function testWithAPI() {
  const secret = process.env.NOSTR_PRIVATE_KEY;
  if (!secret) {
    console.log('⚠️  NOSTR_PRIVATE_KEY not set. Skipping API tests.');
    console.log('💡 Set NOSTR_PRIVATE_KEY environment variable to test API calls.');
    console.log('   Example: export NOSTR_PRIVATE_KEY="nsec1..."');
    return;
  }
  
  console.log('\n=== Testing API Integration ===');
  
  try {
    // Import the bot class only when we need it
    const StackerNewsBot = require('./bot');
    const bot = new StackerNewsBot();
    
    // Test authentication
    console.log('Testing Nostr authentication...');
    await bot.authenticateWithNostr();
    console.log('✅ Authentication successful');
    
    // Test fetching posts (read-only)
    console.log('Testing post fetching...');
    const posts = await bot.fetchRecentPosts();
    console.log(`✅ Fetched ${posts.length} posts`);
    
    // Show first few posts (without processing)
    console.log('\nFirst 3 posts:');
    posts.slice(0, 3).forEach((post, index) => {
      console.log(`${index + 1}. ${post.title || 'No title'} (ID: ${post.id})`);
      const videoId = extractYouTubeId(`${post.title || ''} ${post.text || ''} ${post.url || ''}`);
      console.log(`   YouTube detected: ${videoId ? 'Yes (' + videoId + ')' : 'No'}`);
    });
    
    console.log('\n✅ API integration test complete!');
    
  } catch (error) {
    console.error('❌ API test failed:', error.message);
    console.log('💡 Make sure your NOSTR_PRIVATE_KEY is correct and you have internet access.');
  }
}

// Run tests if this file is executed directly
if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.includes('--api')) {
    // Run with API tests
    Promise.all([testBot(), testWithAPI()]).catch(console.error);
  } else {
    // Run basic tests only
    testBot().catch(console.error);
  }
}

module.exports = { testBot, mockPosts };
