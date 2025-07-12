# Stacker.News YouTube Bot

A bot that monitors [Stacker.News](https://stacker.news) for YouTube links and automatically posts comments with privacy-friendly [Yewtu.be](https://yewtu.be) alternatives.

## Features

- 🔍 **Smart Detection**: Monitors new posts for YouTube links in various formats
- 🔄 **Automatic Conversion**: Converts YouTube URLs to Yewtu.be alternatives
- 🔐 **Nostr Authentication**: Uses Nostr protocol for secure authentication
- 💬 **Helpful Comments**: Posts informative comments with alternative links
- ⚡ **GitHub Actions**: Runs automatically every 10 minutes
- 🚀 **Easy Setup**: Simple configuration and deployment
- 📁 **State Management**: Remembers processed posts to avoid duplicates
- 🛡️ **Rate Limiting**: Built-in delays to respect API limits

## How It Works

1. **Monitoring**: Scans recent posts on Stacker.News
2. **Detection**: Identifies YouTube links using regex patterns
3. **Conversion**: Converts YouTube URLs to Yewtu.be equivalents
4. **Authentication**: Uses Nostr keys to authenticate with Stacker.News
5. **Commenting**: Posts helpful comments with privacy-friendly alternatives
6. **State Tracking**: Saves processed posts to avoid duplicate comments

## Supported YouTube Formats

The bot detects these YouTube URL formats:
- `https://www.youtube.com/watch?v=VIDEO_ID`
- `https://youtu.be/VIDEO_ID`
- `https://youtube.com/embed/VIDEO_ID`
- `https://youtube.com/v/VIDEO_ID`
- `https://youtube.com/shorts/VIDEO_ID`

## Setup Instructions

### 1. Generate Nostr Keys

You'll need a Nostr key pair for authentication. Choose one option:

**Option A: Generate new keys**
```bash
npm install
npm run generate-keys
```

**Option B: Use existing keys**
If you already have Nostr keys, you can use your existing private key.

### 2. Setup Stacker.News Account

1. Go to [Stacker.News](https://stacker.news)
2. Sign up/sign in using your Nostr public key
3. Add some sats to your account (required for posting comments)

### 3. Configure GitHub Repository

1. Fork this repository
2. Go to your repository's **Settings** → **Secrets and variables** → **Actions**
3. Add a new repository secret:
   - **Name**: `NOSTR_PRIVATE_KEY`
   - **Value**: Your Nostr private key (hex format)

### 4. Deploy

The bot will automatically start running when you push to the main branch. It's configured to:
- Run every 10 minutes via cron schedule
- Can be triggered manually from the Actions tab
- Automatically handles state persistence

## Local Development

### Installation

```bash
git clone https://github.com/yew-tub/ot.git
cd ot
npm install
```

### Configuration

Create a `.env` file (optional for local development):
```bash
NOSTR_PRIVATE_KEY=your_private_key_here
```

### Running

```bash
# Run once
npm start

# Run with auto-restart during development
npm run dev

# Generate new Nostr keys
npm run generate-keys
```

## Configuration Options

You can modify the bot behavior by editing `bot.js`:

```javascript
const CONFIG = {
  STACKER_NEWS_API: 'https://stacker.news/api/graphql',
  YEWTU_BE_BASE: 'https://yewtu.be',
  COMMENT_TEMPLATE: '🔗 Alternative link: {link}\n\n*Privacy-friendly YouTube alternative via Yewtu.be*',
  SCAN_LIMIT: 50, // Number of recent posts to scan
  RATE_LIMIT_DELAY: 2000, // ms between API calls
  STATE_FILE: './.bot-state.json'
};
```

## Example Bot Comment

When the bot detects a YouTube link, it posts a comment like:

```
🔗 Alternative link: https://yewtu.be/watch?v=dQw4w9WgXcQ

*Privacy-friendly YouTube alternative via Yewtu.be*
```

## GitHub Actions Details

The bot uses GitHub Actions for automated deployment:
- **Schedule**: Runs every 10 minutes
- **Manual Trigger**: Can be started from Actions tab
- **Timeout**: 9 minutes per run (GitHub Actions limit)
- **State Persistence**: Uses GitHub Actions cache for state storage
- **Error Handling**: Uploads logs on failure

## Troubleshooting

### Common Issues

1. **Bot not posting comments**
   - Check that your Nostr private key is correct
   - Verify your Stacker.News account has sufficient sats
   - Check the GitHub Actions logs for error messages

2. **Authentication errors**
   - Ensure your Nostr private key is in the correct hex format
   - Verify the key corresponds to your Stacker.News account

3. **Rate limiting**
   - The bot includes built-in delays to avoid API limits
   - If you're hitting limits, increase `RATE_LIMIT_DELAY`

### Debug Mode

You can enable debug logging when running manually:
1. Go to the Actions tab in your repository
2. Click "Run workflow" on the bot workflow
3. Check the "Enable debug logging" option

### Checking Logs

- GitHub Actions logs are available in the Actions tab
- Failed runs automatically upload logs as artifacts
- Local runs output to console

## Privacy and Ethics

This bot is designed to:
- Promote privacy-friendly alternatives to YouTube
- Respect Stacker.News community guidelines
- Avoid spam through intelligent state management
- Provide helpful information to users

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test locally
5. Submit a pull request

## License

MIT License - feel free to use and modify as needed.

## Support

If you encounter issues:
- Check the GitHub Actions logs
- Verify your Nostr configuration
- Ensure your Stacker.News account has sats
- Open an issue in this repository

---

**Note**: This bot is for educational and utility purposes. Please use responsibly and respect Stacker.News community guidelines.
