const StackerNewsBot = require('./bot');

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

async function testBot() {
  console.log('Testing YouTube link detection...');
  
  const bot = new StackerNewsBot();
  
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
    const videoId = bot.extractYouTubeId(url);
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
    const videoId = bot.extractYouTubeId(url);
    if (videoId) {
      const yewtubeUrl = bot.convertToYewTube(url, videoId);
      console.log(`Original: ${url}`);
      console.log(`Yewtu.be: ${yewtubeUrl}`);
      console.log('---');
    }
  });
  
  // Test comment template
  console.log('\n=== Testing Comment Template ===');
  const sampleYewtubeUrl = 'https://yewtu.be/watch?v=dQw4w9WgXcQ';
  const commentText = bot.CONFIG?.COMMENT_TEMPLATE?.replace('{link}', sampleYewtubeUrl) || 
                      `🔗 Alternative link: ${sampleYewtubeUrl}\n\n*Privacy-friendly YouTube alternative via Yewtu.be*`;
  console.log('Generated comment:');
  console.log(commentText);
  
  console.log('\n=== Testing Complete ===');
  console.log('If you see video IDs extracted correctly and yewtu.be URLs generated, the bot logic is working!');
  console.log('To test with real API calls, make sure you have NOSTR_PRIVATE_KEY set and run: npm start');
}

// Advanced testing with API calls (requires NOSTR_PRIVATE_KEY)
async function testWithAPI() {
  if (!process.env.NOSTR_PRIVATE_KEY) {
    console.log('⚠️  NOSTR_PRIVATE_KEY not set. Skipping API tests.');
    console.log('Set NOSTR_PRIVATE_KEY environment variable to test API calls.');
    return;
  }
  
  console.log('\n=== Testing API Integration ===');
  const bot = new StackerNewsBot();
  
  try {
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
      const videoId = bot.extractYouTubeId(`${post.title || ''} ${post.text || ''} ${post.url || ''}`);
      console.log(`   YouTube detected: ${videoId ? 'Yes (' + videoId + ')' : 'No'}`);
    });
    
  } catch (error) {
    console.error('❌ API test failed:', error.message);
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
