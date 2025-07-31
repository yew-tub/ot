```bash                                                                                  
@@@ @@@  @@@@@@@@  @@@  @@@  @@@  @@@@@@@  @@@  @@@  @@@@@@@    @@@@@@   @@@@@@@  
@@@ @@@  @@@@@@@@  @@@  @@@  @@@  @@@@@@@  @@@  @@@  @@@@@@@@  @@@@@@@@  @@@@@@@  
@@! !@@  @@!       @@!  @@!  @@!    @@!    @@!  @@@  @@!  @@@  @@!  @@@    @@!    
!@! @!!  !@!       !@!  !@!  !@!    !@!    !@!  @!@  !@   @!@  !@!  @!@    !@!    
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
                  
A bot that monitors [Stacker.News](https://stacker.news/r/YewTuBot) for YouTube links and automatically posts comments with privacy-friendly [Yewtu.be](https://yewtu.be) alternatives.

```bash
₿ loading... 
₿ fetching all recent posts every minute
₿ detect if a post contains or is a YT link
₿ add comment with one of the available INVIDIOUS instance⁽¹⁾ links
₿ utilise the SponsorBlock⁽²⁾ browser extension to automatically skip sponsor segments in YT videos
₿ it is recommended to operate a VPN while browsing
₿ examine the log⁽³⁾ for recently parsed YT links
₿ zap⁽⁴⁾ YewTuBot comments to activate the bot and ensure a persistent service
₿ waiting for zaps...
₿ █


```
- - -

<sub>1.</sub> [<sub>docs.invidious.io/instances</sub>](https://docs.invidious.io/instances/)
<sub>2.</sub> [<sub>www.sponsor.ajay.app</sub>](https://sponsor.ajay.app)
<sub>3.</sub> [<sub>www.stacker.news/YewTuBot/all</sub>](https://stacker.news/YewTuBot/all/r/YewTuBot)
<sub>4.</sub> [<sub>zap.tryspeed.com/plink_live_mbp695vnMFTI2YHq</sub>](https://buy.tryspeed.com/plink_live_mbp695vnMFTI2YHq)


## Key Features & Benefits

-   🔍 **Smart Detection**: Monitors new posts for YouTube links in various formats (e.g., `youtube.com`, `youtu.be`).
-   🔄 **Automatic Conversion**: Converts YouTube URLs to Yewtu.be alternatives, providing a more privacy-respecting experience.
-   🔐 **Nostr Authentication**: Uses the Nostr protocol for secure authentication and posting comments to Stacker.News.
-   💬 **Helpful Comments**: Posts informative comments containing the Yewtu.be link, encouraging users to switch to a privacy-focused alternative.
-   ⚙️ **Configurable**:  Easily configurable through environment variables and code modifications.

## Prerequisites & Dependencies

Before you begin, ensure you have the following installed:

-   **Node.js**:  (Version 16 or higher recommended)  [https://nodejs.org/](https://nodejs.org/)
-   **npm** (Node Package Manager): Usually comes with Node.js
-   **Git**:  (Optional, for cloning the repository) [https://git-scm.com/](https://git-scm.com/)

## Installation & Setup Instructions

1.  **Clone the Repository (Optional):**

    ```bash
    git clone https://github.com/yew-tub/ot.git
    cd ot
    ```

2.  **Install Dependencies:**

    ```bash
    npm install
    ```

3.  **Configure Environment Variables:**

    You'll need to set up environment variables to configure the bot.  Create a `.env` file (or set them directly in your environment). The following variables are crucial:

    -   `NOSTR_PRIVATE_KEY`: Your Nostr private key (hex or nsec format).  **Keep this secure!**
    -   `STACKER_NEWS_API`:  The URL for the Stacker.News GraphQL API (default: `https://stacker.news/api/graphql`).
    -   `STACKER_NEWS_BASE`: The base URL for Stacker.News (default: `https://stacker.news`).
    -   `YEWTU_BE_BASE`: The base URL for Yewtu.be (default: `https://yewtu.be`).
    -   `RELAY_URLS`: A comma-separated list of Nostr relay URLs to connect to. Example: `wss://relay.damus.io,wss://relay.snort.social`. If empty, will use the relays provided by SN api.

    Example `.env` file:

    ```bash
    NOSTR_PRIVATE_KEY=nsec1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
    STACKER_NEWS_API=https://stacker.news/api/graphql
    STACKER_NEWS_BASE=https://stacker.news
    YEWTU_BE_BASE=https://yewtu.be
    RELAY_URLS=wss://relay.damus.io,wss://relay.snort.social
    ```

4.  **Generate Nostr Keys (if needed):**

    The `package.json` includes a script to generate Nostr keys:

    ```bash
    npm run generate-keys
    ```

    **Important**: Store your private key securely. This command is only intended for testing purposes.

5.  **Run the Bot:**

    ```bash
    npm start
    ```

    Alternatively, for development with automatic restarts on code changes:

    ```bash
    npm run dev
    ```

## Usage Examples & Code Snippets

The core logic resides in `bot.js`.  It periodically queries the Stacker.News API, parses posts for YouTube links, constructs Yewtu.be links, and posts comments using the Nostr protocol.

Example:

```javascript
// Inside bot.js

const { getPublicKey, finalizeEvent, verifyEvent, nip19, SimplePool } = require('nostr-tools');
const { GraphQLClient } = require('graphql-request');

// ... other code ...

async function processPost(post) {
  const youtubeLink = findYouTubeLink(post.text);
  if (youtubeLink) {
    const yewtubeLink = convertToYewtube(youtubeLink);
    const commentText = `I found a YouTube link in this post!  Check out the privacy-friendly Yewtu.be alternative: ${yewtubeLink}`;
    await postComment(post.id, commentText);
  }
}
```

## Configuration Options

The bot's behavior can be configured through environment variables and by modifying the `bot.js` file.

-   **Environment Variables:**  As described in the "Installation & Setup Instructions" section.

-   **Code Modifications:** You can adjust the polling interval, customize the comment text, or modify the logic for detecting YouTube links.  See the `bot.js` file for details.

## Contributing Guidelines

We welcome contributions to improve this bot!  Here's how you can contribute:

1.  Fork the repository.
2.  Create a new branch for your feature or bug fix.
3.  Make your changes and commit them with clear, descriptive commit messages.
4.  Submit a pull request to the `main` branch.

Please follow these guidelines:

-   Write clean, well-documented code.
-   Include tests for new features or bug fixes.
-   Adhere to the project's coding style.

## License Information

No license is specified. All rights reserved.

## Acknowledgments

-   This project leverages the [Nostr](https://nostr.com/) protocol for secure communication.
-   Thanks to the [Stacker.News](https://stacker.news/r/YewTuBot) community for inspiring this project.
-   Special thanks to the [Yewtu.be](https://yewtu.be) project for providing a privacy-friendly YouTube alternative.
