```bash
 @@@ @@@  @@@@@@@@  @@@  @@@  @@@  @@@@@@@  @@@  @@@  @@@@@@@    @@@@@@   @@@@@@@  
 @@@ @@@  @@@@@@@@  @@@  @@@  @@@  @@@@@@@  @@@  @@@  @@@@@@@@  @@@@@@@@  @@@@@@@  
 @@! !@@  @@!       @@!  @@!  @@!    @@!    @@!  @@@  @@!  @@@  @@!  @@@    @@!    
 !@! @!!  !@!       !@!  !@!  !@!    !@!    !@!  @!@  !@   @!@  !@!  !@!    !@!    
  !@!@!   @!!!:!    @!!  !!@  @!@    @!!    @!@  !@!  @!@!@!@   @!@  !@!    @!!    
   @!!!   !!!!!:    !@!  !!!  !@!    !!!    !@!  !!!  !!!@!!!!  !@!  !!!    !!!    
   !!:    !!:       !!:  !!:  !!:    !!:    !!:  !!!  !!:  !!!  !!:  !!!    !!:    
   :!:    :!:       :!:  :!:  :!:    :!:    :!:  !:!  :!:  !:!  :!:  !:!    :!:    
    ::     :: ::::   :::: :: :::      ::    ::::: ::   :: ::::  ::::: ::     ::    
    :     : :: ::     :: :  : :       :      : :  :   :: : ::    : :  :      :


                                        ___    ___   ___                 
 ____   ____   ____  ____  ____  _  __/ _ \  |_  | <  / ____  ____  ____  ____  ____
/___/  /___/  /___/ /___/ /___/ | |/ / // / / __/_ / / /___/ /___/ /___/ /___/ /___/
                                 |___/\___(_)____(_)_/

```

A bot that monitors [Stacker.News](https://stacker.news/r/YewTuBot) for YouTube links and automatically posts comments with privacy-friendly [Invidious](https://docs.invidious.io/instances/) alternatives. Also publishes corresponding Nostr notes.

```bash
₿ loading... 
₿ scanning SN items every 7 minutes via GitHub Actions
₿ detect all YouTube links in a post (multiple videos supported)
₿ post a comment with one of the available INVIDIOUS⁽¹⁾ instance links
₿ utilise the SponsorBlock⁽²⁾ browser extension to automatically skip sponsor segments in YT videos
₿ it is recommended to operate a VPN⁽³⁾ while browsing
₿ check wallet balance before commenting
₿ publish a Nostr note linking back to the comment
₿ resolve user npub from nostrAuthPubkey when available
₿ preserve state across runs in .bot-state.json
₿ backfill old posts or scan live — configurable depth
₿ examine the log⁽⁴⁾ for recently parsed YT links
₿ zap⁽⁵⁾ YewTuBot comments to activate the bot and ensure a persistent service
₿ waiting for zaps...
₿ █

```
- - -

<sub>1.</sub> [<sub>docs.invidious.io/instances</sub>](https://docs.invidious.io/instances/)<br/>
<sub>2.</sub> [<sub>www.sponsor.ajay.app</sub>](https://sponsor.ajay.app)<br/>
<sub>3.</sub> <sub>meet</sub> [<sub>**`obscura`**</sub>](https://obscura.com/refer#nmazby)<sub>: the first VPN that *can’t* **log your activity** and **outsmarts internet censorship**.</sub><br/>
<sub>4.</sub> [<sub>www.stacker.news/YewTuBot/all</sub>](https://stacker.news/YewTuBot/all/r/YewTuBot)<br/>
<sub>5.</sub> [<sub>https://coinos.io/pay/YewTuBot</sub>](https://coinos.io/pay/YewTuBot)


## Features

- **Smart Detection** — Detects YouTube links in multiple formats (`youtube.com/watch`, `youtu.be`, `youtube.com/embed`, `/shorts/`, `/v/`)
- **Multi-Video Support** — Detects all YouTube links in a single post, fetches titles via oEmbed (no API key), and batches them into one comment
- **Invidious Rotation** — Converts each URL to a random Invidious instance from a configurable list
- **Session-Based Auth** — Authenticates to Stacker.News via pre-fetched session cookies (see `get-session.js`)
- **Comment Cost Awareness** — Checks `commentCost` against mcredits wallet balance before posting; skips comments that would exceed balance
- **Existing Comment Detection** — Checks the API for existing bot comments before posting, avoids duplicates
- **Nostr Notes** — Publishes a Nostr note for each commented post, linking back to the specific comment on SN; resolves user npub from `nostrAuthPubkey` when available
- **Cursor Pagination** — Fetches posts page-by-page (newest-first) until the comment limit is reached or posts are exhausted
- **Backfill + Live Modes** — Live mode (2 pages) for cron runs; Backfill mode (configurable depth) for initial catch-up or manual rescans
- **Wallet Guard** — Skips the entire run if mcredits balance is 0
- **Consecutive Miss Limit** — Stops scanning after 500 posts without YouTube content
- **Rate Limiting** — Configurable comment delay (21s) and rate-limit pause (2s) between pages
- **State Persistence** — Tracks processed and commented post IDs in `.bot-state.json` across runs
- **GitHub Actions Automation** — Scheduled every 7 minutes via GitHub Actions; caches bot state between runs; uploads logs as artifacts

## Prerequisites

- **Node.js** 18+ (20 recommended for GitHub Actions)
- **npm**

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Generate a Nostr keypair

```bash
npm run generate-keys
```

Save the **private key (nsec)** — you'll need it as a GitHub secret.

### 3. Get Stacker.News session cookies

```bash
node get-session.js
```

This will output a `SESSION_COOKIES` value. You'll need this to authenticate API requests.

### 4. GitHub Secrets

Go to **Settings → Secrets and variables → Actions** and add:

| Secret | Description |
|--------|-------------|
| `NOSTR_PRIVATE_KEY` | Nostr nsec private key (required for Nostr notes) |
| `SESSION_COOKIES` | Pre-authenticated session cookies from `get-session.js` (required for API access) |

### 5. Optional Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BACKFILL` | `true` | Set to `false` for live-only mode (2 pages) |
| `BACKFILL_DEPTH` | `21` | Max pages to scan in backfill mode (10 for scheduled runs, 50 for manual rescans) |
| `INVIDIOUS_INSTANCES` | Curated list | Comma-separated Invidious instance URLs |
| `NOSTR_RELAYS` | 5 relays | Comma-separated Nostr relay URLs |
| `DEBUG` | `true` in dev | Enable detailed debug logging |

### 6. Run locally

```bash
npm start
```

Or with auto-restart on changes:

```bash
npm run dev
```

## GitHub Actions

The workflow (`.github/workflows/bot.yml`) runs every 7 minutes via cron:

- **Scheduled runs**: `BACKFILL=true`, `BACKFILL_DEPTH=10` (500 posts max)
- **Manual trigger with rescan**: Clear state and scan 50 pages deep

After a period without commits, GitHub may disable scheduled workflows. Push a trivial commit to re-enable:

```bash
git commit --allow-empty -m "chore: ping scheduled workflows"
git push
```

## How It Works

```
1. Check wallet balance → skip if 0 mcredits
2. Load state from .bot-state.json
3. Authenticate with Nostr
4. Find working GraphQL query (re-derives on schema changes)
5. Fetch posts page-by-page (newest first) via cursor pagination
6. For each post:
   a. Check if already processed (state file & API check)
   b. Extract all YouTube IDs from text/URL
   c. If found → fetch video titles via oEmbed
   d. Check commentCost ≤ creditBalance
   e. Post Invidious comment on Stacker.News
   f. Publish Nostr note with user npub (or @username fallback)
   g. Deduct cost from cached balance
   h. Wait 21s before next comment
7. Save state
```

## Configuration Reference

Key constants in `bot.js` (`CONFIG` object):

| Constant | Default | Description |
|----------|---------|-------------|
| `SCAN_LIMIT` | 50 | Posts per page |
| `COMMENT_LIMIT` | 3 | Max comments per run |
| `COMMENT_DELAY` | 21000 | Delay between comments (ms) |
| `MAX_CONSECUTIVE_MISSES` | 500 | Stop after this many non-YouTube posts |
| `RATE_LIMIT_DELAY` | 2000 | Pause between page fetches (ms) |

## License

GPL-3.0

## Acknowledgments

- [Stacker.News](https://stacker.news/r/YewTuBot) community
- [Nostr](https://nostr.com/) protocol
- [Invidious](https://docs.invidious.io/instances/) project
- [Yewtu.be](https://yewtu.be) (self-hosted Invidious instance)
