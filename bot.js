const { getPublicKey, finishEvent, relayInit, nip19 } = require('nostr-tools');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// Configuration
const RELAY_URL = 'wss://relay.primal.net';
const STACKER_NEWS_URL = 'https://stacker.news/api/graphql';
const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
const CHECK_INTERVAL = 60000; // 1 minute
const STACKER_NEWS_PROFILE = 'https://stacker.news/yew_tub';
const PROCESSED_ITEMS_FILE = path.join(__dirname, 'processed_items.json');
const MAX_RETRIES = 3;
const RETRY_DELAY = 5000; // 5 seconds

// Load processed items from file
function loadProcessedItems() {
    try {
        if (fs.existsSync(PROCESSED_ITEMS_FILE)) {
            const data = fs.readFileSync(PROCESSED_ITEMS_FILE, 'utf8');
            return new Set(JSON.parse(data));
        }
    } catch (error) {
        console.error('Error loading processed items:', error);
    }
    return new Set();
}

// Save processed items to file
function saveProcessedItems(processedItems) {
    try {
        fs.writeFileSync(PROCESSED_ITEMS_FILE, JSON.stringify([...processedItems]));
    } catch (error) {
        console.error('Error saving processed items:', error);
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
        // Handle both nsec1 and hex format private keys
        let privateKey = process.env.NOSTR_PRIVATE_KEY;
        
        if (!privateKey) {
            throw new Error('NOSTR_PRIVATE_KEY environment variable is required');
        }
        
        // Convert nsec1 to hex if needed
        if (privateKey.startsWith('nsec1')) {
            console.log('Converting nsec1 private key to hex format...');
            privateKey = nsecToHex(privateKey);
        }
        
        this.privateKey = privateKey;
        this.publicKey = getPublicKey(privateKey);
        this.relay = null;
        this.processedItems = loadProcessedItems();
        
        console.log('Bot initialized with public key:', this.publicKey);
    }

    async connectToRelay() {
        try {
            this.relay = relayInit(RELAY_URL);
            
            await new Promise((resolve, reject) => {
                this.relay.on('connect', () => {
                    console.log('Connected to relay:', RELAY_URL);
                    resolve();
                });
                
                this.relay.on('error', (err) => {
                    console.error('Relay connection error:', err);
                    reject(err);
                });
                
                this.relay.connect();
            });
            
        } catch (error) {
            console.error('Failed to connect to relay:', error);
            throw error;
        }
    }

    async fetchStackerNewsItems() {
        const query = `
            query {
                items(sort: "recent", limit: 10) {
                    id
                    title
                    url
                    createdAt
                    user {
                        name
                    }
                }
            }
        `;

        try {
            const response = await fetch(STACKER_NEWS_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ query })
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            return data.data.items || [];
        } catch (error) {
            console.error('Error fetching Stacker News items:', error);
            return [];
        }
    }

    isYouTubeURL(url) {
        if (!url) return false;
        return url.includes('youtube.com') || url.includes('youtu.be');
    }

    async getYouTubeVideoId(url) {
        try {
            const urlObj = new URL(url);
            
            if (urlObj.hostname === 'youtu.be') {
                return urlObj.pathname.slice(1);
            } else if (urlObj.hostname === 'www.youtube.com' || urlObj.hostname === 'youtube.com') {
                return urlObj.searchParams.get('v');
            }
        } catch (error) {
            console.error('Error parsing YouTube URL:', error);
        }
        return null;
    }

    async getYouTubeVideoInfo(videoId) {
        const API_KEY = process.env.YOUTUBE_API_KEY;
        if (!API_KEY) {
            console.warn('YouTube API key not found. Using basic info.');
            return null;
        }

        try {
            const response = await fetch(
                `${YOUTUBE_API_BASE}/videos?id=${videoId}&key=${API_KEY}&part=snippet,statistics`
            );

            if (!response.ok) {
                throw new Error(`YouTube API error: ${response.status}`);
            }

            const data = await response.json();
            if (data.items && data.items.length > 0) {
                const video = data.items[0];
                return {
                    title: video.snippet.title,
                    channelTitle: video.snippet.channelTitle,
                    description: video.snippet.description,
                    viewCount: video.statistics.viewCount,
                    likeCount: video.statistics.likeCount,
                    duration: video.contentDetails?.duration
                };
            }
        } catch (error) {
            console.error('Error fetching YouTube video info:', error);
        }
        return null;
    }

    async publishToNostr(item, youtubeInfo) {
        try {
            let content = `📺 YouTube Video Shared on Stacker News\n\n`;
            content += `"${item.title}"\n`;
            content += `by ${item.user.name}\n\n`;
            
            if (youtubeInfo) {
                content += `🎬 ${youtubeInfo.title}\n`;
                content += `📺 ${youtubeInfo.channelTitle}\n`;
                if (youtubeInfo.viewCount) {
                    content += `👀 ${parseInt(youtubeInfo.viewCount).toLocaleString()} views\n`;
                }
                content += `\n`;
            }
            
            content += `🔗 ${item.url}\n`;
            content += `💬 Discuss on Stacker News: https://stacker.news/items/${item.id}\n\n`;
            content += `#YouTube #StackerNews #Bitcoin\n\n`;
            content += `🤖 This post was automatically shared from ${STACKER_NEWS_PROFILE}`;

            const event = {
                kind: 1,
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                    ['t', 'youtube'],
                    ['t', 'stackernews'],
                    ['t', 'bitcoin'],
                    ['r', item.url]
                ],
                content: content,
                pubkey: this.publicKey,
            };

            const signedEvent = finishEvent(event, this.privateKey);
            
            // Publish to relay
            const pub = this.relay.publish(signedEvent);
            
            await new Promise((resolve, reject) => {
                pub.on('ok', () => {
                    console.log('✅ Successfully published to Nostr');
                    resolve();
                });
                
                pub.on('failed', (reason) => {
                    console.error('❌ Failed to publish to Nostr:', reason);
                    reject(new Error(reason));
                });
                
                // Timeout after 10 seconds
                setTimeout(() => {
                    reject(new Error('Publish timeout'));
                }, 10000);
            });

            return true;
        } catch (error) {
            console.error('Error publishing to Nostr:', error);
            return false;
        }
    }

    async processNewItems() {
        console.log('🔍 Checking for new YouTube videos on Stacker News...');
        
        const items = await this.fetchStackerNewsItems();
        let newItemsFound = 0;

        for (const item of items) {
            if (this.processedItems.has(item.id)) {
                continue;
            }

            if (this.isYouTubeURL(item.url)) {
                console.log(`📺 Found YouTube video: ${item.title}`);
                
                const videoId = await this.getYouTubeVideoId(item.url);
                let youtubeInfo = null;
                
                if (videoId) {
                    youtubeInfo = await this.getYouTubeVideoInfo(videoId);
                }

                let retryCount = 0;
                let success = false;

                while (retryCount < MAX_RETRIES && !success) {
                    try {
                        success = await this.publishToNostr(item, youtubeInfo);
                        
                        if (success) {
                            this.processedItems.add(item.id);
                            newItemsFound++;
                            console.log(`✅ Successfully processed: ${item.title}`);
                        } else {
                            retryCount++;
                            if (retryCount < MAX_RETRIES) {
                                console.log(`⏳ Retrying in ${RETRY_DELAY/1000} seconds... (${retryCount}/${MAX_RETRIES})`);
                                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
                            }
                        }
                    } catch (error) {
                        retryCount++;
                        console.error(`❌ Error processing item (attempt ${retryCount}/${MAX_RETRIES}):`, error);
                        
                        if (retryCount < MAX_RETRIES) {
                            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
                        }
                    }
                }

                if (!success) {
                    console.error(`❌ Failed to process item after ${MAX_RETRIES} attempts: ${item.title}`);
                }
            }
        }

        if (newItemsFound > 0) {
            saveProcessedItems(this.processedItems);
            console.log(`✅ Processed ${newItemsFound} new YouTube video(s)`);
        } else {
            console.log('ℹ️ No new YouTube videos found');
        }
    }

    async start() {
        console.log('🚀 Starting Stacker News YouTube Bot...');
        
        try {
            await this.connectToRelay();
            console.log('✅ Bot connected and ready!');
            
            // Initial check
            await this.processNewItems();
            
            // Set up interval for continuous checking
            setInterval(async () => {
                try {
                    await this.processNewItems();
                } catch (error) {
                    console.error('Error in scheduled check:', error);
                }
            }, CHECK_INTERVAL);
            
        } catch (error) {
            console.error('❌ Failed to start bot:', error);
            process.exit(1);
        }
    }
}

// Main function
async function main() {
    try {
        const bot = new StackerNewsBot();
        await bot.start();
    } catch (error) {
        console.error('❌ Bot failed to start:', error);
        process.exit(1);
    }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n👋 Bot shutting down gracefully...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n👋 Bot shutting down gracefully...');
    process.exit(0);
});

// Start the bot
if (require.main === module) {
    main();
}
