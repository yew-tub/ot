# Stacker.News YouTube to Yewtu.be Bot

A bot that monitors [Stacker.News](https://stacker.news) for YouTube links and automatically posts comments with privacy-friendly [Yewtu.be](https://yewtu.be) alternatives.

## Features

- 🔍 Monitors Stacker.News posts and comments for YouTube links
- 🔄 Automatically converts YouTube URLs to Yewtu.be alternatives
- 🔐 Authenticates via Nostr protocol
- 💬 Posts helpful comments with alternative links
- ⚡ Runs on GitHub Actions (free tier compatible)
- 🚀 Easy deployment to GitHub Pages/Actions

## How it works

1. The bot scans recent posts and comments on Stacker.News
2. Detects YouTube links in various formats (youtube.com, youtu.be, etc.)
3. Converts them to Yewtu.be equivalents
4. Posts a comment with the privacy-friendly alternative
5. Runs every 10 minutes via GitHub Actions

## Setup

### 1. Fork/Clone this repository

```bash
git clone https://github.com/yourusername/stacker-news-youtube-bot.git
cd stacker-news-youtube-bot
```

### 2. Generate Nostr Keys

You'll need a Nostr private key to authenticate with Stacker.News. You can:

**Option A: Generate new keys**
```bash
npm install
node -e "
const { generatePrivateKey, getPublicKey } = require('nostr-tools');
const privKey = generatePrivateKey();
const pubKey = getPublicKey(privKey);
console.log('Private Key:', privKey);
console.log('Public Key:', pubKey);
"
```

**Option B: Use existing Nostr keys**
If you already have a Nostr key pair, you can use your existing private key.

### 3. Set up Stacker.News Account

1. Go to [Stacker.News](https://stacker.news)
2. Sign up/sign in using your Nostr public key
3. Make sure your account has some sats for posting comments

### 4. Configure GitHub Secrets

In your GitHub repository:

1. Go to Settings → Secrets and variables → Actions
2. Add a new repository secret:
   - **Name**: `NOSTR_PRIVATE_KEY`
   - **Value**: Your Nostr private key (hex format)

### 5. Deploy

The bot will automatically start running when you push to the main branch. It's configured to:
- Run every 10 minutes via cron schedule
- Can be triggered manually from the Actions tab
- Runs a single scan per execution (GitHub Actions friendly)

## Local Development

```bash
# Install dependencies
npm install

# Run the bot locally
npm start

# Run with auto-restart during development
npm run dev
```

## Configuration

### Environment Variables

- `NOSTR_PRIVATE_KEY`: Your Nostr private key (required for posting comments)
- `NODE_ENV`: Set to 'production' in GitHub Actions

### Customization

You can modify the bot behavior by editing `bot.js`:

- Change the monitoring frequency
- Modify the comment template
- Adjust rate limiting delays
- Filter specific YouTube domains

## YouTube URL Detection

The bot detects these YouTube URL formats:
- `https://www.youtube.com/watch?v=VIDEO_ID`
- `https://youtu.be/VIDEO_ID`
- `https://youtube.com/embed/VIDEO_ID`
- `https://youtube.com/v/VIDEO_ID`
- `https://youtube.com/shorts/VIDEO_ID`

## Example Response

When the bot detects a YouTube link, it posts a comment like:

```
🔗 Alternative link: https://yewtu.be/watch?v=dQw4w9WgXcQ

*Privacy-friendly YouTube alternative via Yewtu.be*
```

## GitHub Actions Workflow

The bot uses GitHub Actions for deployment:

- **Schedule**: Runs every 10 minutes
- **Manual trigger**: Can be started from Actions tab
- **Timeout**: 9 minutes per run (GitHub Actions limit)
- **Rate limiting**: Built-in delays to avoid API limits

## Limitations

- GitHub Actions free tier has usage limits
- Rate limited to avoid spamming Stacker.News
- Requires sats in your Stacker.News account for commenting
- Single scan per execution (not continuously running)

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test locally
5. Submit a pull request

## License

MIT License - feel free to use and modify as needed.

## Disclaimer

This bot is for educational and utility purposes. Please use responsibly and respect Stacker.News community guidelines. Make sure you have sufficient sats in your account for commenting.

## Support

If you encounter issues:
1. Check the GitHub Actions logs
2. Verify your Nostr private key is correct
3. Ensure your Stacker.News account has sats
4. Open an issue in this repository
