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
- **Backfill + Live Modes** — Live mode (`LIVE_DEPTH` pages) for cron runs; Backfill mode (`BACKFILL_DEPTH`) for manual rescans
- **Cost Gate** — Skips any post whose `commentCost` exceeds `MAX_COMMENT_COST`; expensive posts are not more likely to be zapped, they just cost more
- **Engagement Window** — Only comments on posts aged between `MIN_POST_AGE_MIN` and `MAX_POST_AGE_MIN`
- **Target Track Records** — Learns per-author and per-sub profitability from its own past comments only, with decaying confidence, so unprofitable targets are skipped while still being periodically re-tested
- **Private Gist Archive** — Mirrors those records to a secret gist as a readable archive of every dead/recovered verdict, and as a backup that is restored automatically if the Actions cache is lost
- **Nostr Thumbnails** — Uploads the video thumbnail to a Blossom server and embeds it in the note, which makes the note far more inviting to zap
- **Cheap Gate Ordering** — All profitability gates run before any network work, so rejected posts cost nothing
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
| `BACKFILL` | `true` | Set to `false` for live-only mode (limited to `LIVE_DEPTH` pages) |
| `BACKFILL_DEPTH` | `21` | Max pages to scan in backfill mode (50 for manual rescans) |
| `LIVE_DEPTH` | `2` | Max pages to scan when `BACKFILL=false` |
| `MAX_COMMENT_COST` | `5` | Skip posts whose `commentCost` exceeds this many mcredits |
| `MIN_POST_AGE_MIN` | `30` | Skip posts younger than this many minutes (`0` disables) |
| `MAX_POST_AGE_MIN` | `360` | Skip posts older than this many minutes (`0` disables) |
| `TARGET_STATS_ENABLED` | `true` | Enable causal author/sub track records |
| `TARGET_MIN_COMMENTS` | `8` | Effective samples needed before judging a target |
| `TARGET_MIN_NET_PER` | `0` | Net mcredits/comment below which a target is unprofitable |
| `TARGET_STATS_HALF_LIFE_DAYS` | `30` | Days for record confidence to halve |
| `TARGET_STATS_MAX_AGE_DAYS` | `180` | Drop records untouched this long |
| `TARGET_SETTLE_HOURS` | `48` | Wait before reading a comment's outcome |
| `NOSTR_INCLUDE_THUMBNAIL` | `true` | Put the video thumbnail in the Nostr note |
| `THUMBNAIL_QUALITY` | `hqdefault` | Thumbnail variant (`hqdefault` is the most reliable) |
| `BLOSSOM_ENABLED` | `true` | Upload the thumbnail to a Blossom server |
| `BLOSSOM_SERVERS` | blossom.primal.net,blossom.band | Comma-separated BUD-02 endpoints |
| `GIST_ENABLED` | `false` | Mirror records to a private gist |
| `GIST_TOKEN` | — | PAT with `gist` scope (required for `GIST_ENABLED`) |
| `GIST_ID` | — | Optional. Auto-created and auto-discovered; only set this to pin a specific gist |
| `GIST_FILENAME` | `yewtubot-target-records.json` | File inside the gist |
| `PRIORITIZE_TARGETS` | `true` | Comment on the best-scoring candidates, not feed order |
| `PRIORITIZE_TARGETS` tier | good=3, unknown=2, stale=1 | Tier ordering; tier dominates the score |
| `PRIORITY_WEIGHT_CREDITS` | 1 | Tie-break weight on a post's existing credits |
| `PRIORITY_WEIGHT_COST` | 2 | Tie-break penalty per mcredit of comment cost |
| `PRIORITY_WEIGHT_AGE` | 0.5 | Tie-break penalty per minute of post age |
| `CIRCUIT_BREAKER_ENABLED` | `true` | Stop commenting when realised ROI is too poor |
| `CIRCUIT_ROI_WINDOW_DAYS` | `30` | Trailing window for the ROI judgement |
| `CIRCUIT_MIN_SAMPLES` | `40` | Settled comments required before the breaker may trip |
| `CIRCUIT_MIN_ROI` | `-0.25` | Trip when ROI over the window is worse than this |
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

- **Scheduled runs**: `BACKFILL=false`, `LIVE_DEPTH=2` (100 posts max)
- **Manual trigger with rescan**: `BACKFILL=true`, clear state, scan 50 pages deep

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
4. Age the target track records, then settle newly matured comments
5. Find working GraphQL query (re-derives on schema changes)
6. Fetch posts page-by-page (newest first) via cursor pagination
6b. Rank the page's eligible candidates (good > unknown > stale) and comment on
    the best ones; stop entirely if the ROI circuit breaker is open
7. For each chosen post:
   a. Check if already processed (state file & API check)
   b. Extract all YouTube IDs from text/URL
   c. Skip if the author or sub is currently judged unprofitable
   d. Skip if post age outside MIN/MAX_POST_AGE_MIN
   e. Skip if commentCost > MAX_COMMENT_COST
   f. Skip if commentCost > creditBalance
   g. Skip if stacked value < MIN_STACKED_VALUE
   h. Fetch video titles via oEmbed
   i. Post Invidious comment on Stacker.News
   j. Publish Nostr note with user npub (or @username fallback)
   k. Deduct cost from cached balance
   l. Queue the comment's real outcome to be settled on a later run
   m. Wait 21s before next comment
8. Save state
9. Mirror records to the private gist
```

## Target Track Records

The bot keeps its own causal record of every author and sub it has commented on,
using only outcomes from comments it posted itself. Nothing is seeded from
outside data, so a verdict never reflects information the bot did not have at the
time.

A record holds a decayed sample count `n`, the mcredits `spent`, the `credits`
earned (what actually survived zap decay), and gross zap `sats`. A target is
judged **unprofitable** once `n >= TARGET_MIN_COMMENTS` and
`(earned - spent) / n < TARGET_MIN_NET_PER`.

Records are never final. Every `TARGET_STATS_HALF_LIFE_DAYS` both `n` and the
monetary totals are multiplied by 0.5, which leaves the per-comment average
intact but shrinks the sample. Once `n` decays below `TARGET_MIN_COMMENTS` the
verdict becomes *stale* and the target returns to **probation**: the bot comments
again and re-tests it with real money at risk. A dead target is therefore always
temporary — an author who simply had a bad month is not blocked forever, and one
who recovers re-enters rotation on its own. Records untouched for
`TARGET_STATS_MAX_AGE_DAYS` are dropped entirely.

Because a zap outcome is unknown when a comment is posted, each comment is queued
in `pendingSettles` and its `credits`/`sats` are re-read
`TARGET_SETTLE_HOURS` later via batched `item(id:)` queries. A failed settle is
retried on the next run rather than recorded as a loss.

Author and sub verdicts are independent: a post is skipped if **either** is
currently unprofitable.

### Private gist archive

Set `GIST_ENABLED=true` and provide `GIST_TOKEN` (a classic PAT with the `gist`
scope — fine-grained tokens cannot be used for gists). On the first run the bot
creates a **secret** gist; on later runs it patches it. If `GIST_ID` is set it
updates that gist, otherwise it finds the gist by filename.

**You do not need to create anything.** Leave `GIST_ID` unset and the bot creates
the secret gist itself on the first run, logs `GIST_ID: <id>` plus the clickable
URL, and writes the id into `.bot-state.json` so later runs go straight to it.
The id also appears in the run summary and in the `gistArchive` summary field. If
the state file is ever lost, the bot rediscovers the gist by filename, so the
`GIST_ID` secret is optional.

Each save writes the live records, a convenient `currentlyDead` list of authors
and subs sorted worst-first, and an append-only `history` of verdict transitions
(`dead` -> `stale` means a target recovered). The history is capped at
`GIST_HISTORY_LIMIT` entries.

The gist doubles as a backup: if `.bot-state.json` comes back empty (cache
eviction, a cleared cache, a changed cache key), the records and history are
restored from it. Existing local records are never overwritten by the restore.
Every gist call is best-effort — a bad token or an outage logs a warning and the
run continues.

Note that secret gists are *unlisted*, not private: anyone with the URL can read
one. That is fine for a list of public Stacker usernames, but do not put
credentials in it.

### Good-over-unknown prioritisation

Sub profitability varies by roughly 40x, so *which* eligible post gets funded
matters more than whether it is eligible. With `PRIORITIZE_TARGETS=true` the bot
screens a whole page, scores every candidate, and comments on the best ones
rather than the first eligible ones the feed returns.

Tier dominates the score:

| Tier | Target | Why |
|------|--------|-----|
| 3 | `good` | Proven profitable — funded first |
| 2 | `unknown` | No history yet |
| 1 | `stale` | Was judged before, record has decayed — deliberate re-test |

`dead` targets never reach scoring; they are filtered by the gate. Within a tier
the tie-breakers are all things the data supports: posts that already hold
`credits` are in a zapping mood, cheaper posts are less risky, and fresher posts
sit inside the engagement window. `credits` and `commentCost` are both mcredits,
so they compare directly.

Unknown targets are still used whenever no proven winner is on offer, so the bot
keeps discovering new ones instead of exhausting its winners and going silent.

Scoring is advisory only: the chosen posts are then run through the normal
`processPost` path, which re-applies every gate. A bug in scoring therefore
cannot let a post through that would otherwise be rejected.

### Rolling-ROI circuit breaker

Zap income is a lottery — the top 10 of 694 comments produced 47% of gross sats
and the median zap among zapped comments was 33 sats. Losing streaks are
therefore expected, and the bot should not ride one all the way to an empty
wallet.

Every comment whose outcome has actually been read appends `{earned, spent}` to
`settledLedger`. Over a trailing `CIRCUIT_ROI_WINDOW_DAYS`, once at least
`CIRCUIT_MIN_SAMPLES` comments have settled, an ROI worse than
`CIRCUIT_MIN_ROI` opens the breaker: the run settles pending comments, saves
state, mirrors to the gist, and posts nothing.

The breaker judges the bot's own realised P&L, never the candidates it is
considering and never comments whose outcome is still pending. It will not trip
on thin evidence — a fresh install with 3 losses keeps trading — and a failed
settle is retried rather than booked as a loss, so a network blip cannot trip it.
Set `CIRCUIT_BREAKER_ENABLED=false` to disable.

### Nostr thumbnails

The note template now embeds the video thumbnail between the "posted" line and
the "Watch the video" line:

```
@alice posted "Cool Video"

![Cool Video](https://blossom.primal.net/<sha256>.jpg)

Watch the video https://stacker.news/items/123/r/YewTuBot?commentId=c1
```

The image is also attached as an `imeta` tag, which clients such as Damus and
Primal render natively. The bytes are fetched from a working Invidious instance
first and from `i.ytimg.com` as a fallback (`yewtu.be` returns 403 for hotlinked
thumbnails), and the resulting URL is cached per video for the run.

Blossom upload is best-effort. Public servers increasingly reject programmatic
uploads — `blossom.primal.net` and `blossom.band` currently answer `401` to every
BUD-02 auth shape, so in practice the note falls back to the direct
`i.ytimg.com` thumbnail URL and still renders. After one failed round the bot
stops retrying for the rest of the run. Point `BLOSSOM_SERVERS` at a server you
run to get content-addressed URLs.

## Configuration Reference

Key constants in `bot.js` (`CONFIG` object):

| Constant | Default | Description |
|----------|---------|-------------|
| `SCAN_LIMIT` | 50 | Posts per page |
| `COMMENT_LIMIT` | 3 | Max comments per run |
| `COMMENT_DELAY` | 21000 | Delay between comments (ms) |
| `MAX_CONSECUTIVE_MISSES` | 500 | Stop after this many non-YouTube posts |
| `MAX_COMMENT_COST` | 5 | Max `commentCost` willing to pay, in mcredits |
| `MIN_POST_AGE_MIN` | 30 | Minimum post age to comment (minutes) |
| `MAX_POST_AGE_MIN` | 360 | Maximum post age to comment (minutes) |
| `MIN_STACKED_VALUE` | 123 | Minimum `sats + credits - boost - commentCost` |
| `RATE_LIMIT_DELAY` | 2000 | Pause between page fetches (ms) |
| `TARGET_STATS_ENABLED` | `true` | Enable the causal author/sub track records |
| `TARGET_MIN_COMMENTS` | 8 | Effective sample count required before judging a target |
| `TARGET_MIN_NET_PER` | 0 | Below this net mcredits per comment a target is unprofitable |
| `TARGET_STATS_HALF_LIFE_DAYS` | 30 | Days for a record's confidence to halve |
| `TARGET_STATS_MAX_AGE_DAYS` | 180 | Drop records untouched for this long |
| `TARGET_SETTLE_HOURS` | 48 | Wait before reading a comment's real outcome |
| `TARGET_SETTLE_BATCH` | 20 | Comments re-read per GraphQL request |
| `TARGET_SETTLE_MAX_PER_RUN` | 60 | Cap on settlements per run |

## License

GPL-3.0

## Acknowledgments

- [Stacker.News](https://stacker.news/r/YewTuBot) community
- [Nostr](https://nostr.com/) protocol
- [Invidious](https://docs.invidious.io/instances/) project
- [Yewtu.be](https://yewtu.be) (self-hosted Invidious instance)
