# arctic-shift-mcp

MCP server for the [Arctic Shift](https://arctic-shift.photon-reddit.com) Reddit archive. Covers **May 2025 to today** with a ~24-48h indexing lag. The main complement to PullPush for AI tools.

No Reddit API key, no credentials, no authentication. Just install and run.

## Why this exists

Reddit search is broken for AI tools:
- `site:reddit.com` in web search returns almost nothing useful
- Reddit's official API became paid in 2023 (the change that killed Apollo)
- [PullPush](https://pullpush.io) covers up to May 2025 only
- [reddit-mcp-buddy](https://github.com/karanb192/reddit-mcp-buddy) hits Reddit's live endpoints, which get blocked or rate-limited intermittently

Arctic Shift is an independent archive that doesn't call Reddit at query time. It covers everything from May 2025 to today, and it's fast.

## Coverage

```
PullPush          ████████████████████░░░░░░░░░  2005 → May 2025
arctic-shift-mcp  ░░░░░░░░░░░░░░░░░░░░█████████  May 2025 → today (~48h lag)
Reddit Buddy      ░░░░░░░░░░░░░░░░░░░░░░░░░░░██  live (frequently blocked)
```

**Note on recent posts:** engagement data (scores, comment counts) is fully indexed for posts older than ~48h. Posts from the last 24-48h are present but show `score: 1, comments: 0` until indexing catches up — use `sort_by: date_desc` for very recent content.

Use PullPush + arctic-shift-mcp together for complete Reddit coverage from 2005 to today.

## Install

```bash
npm install -g arctic-shift-mcp
```

Register it in Claude Code at user scope (available in every session):

```bash
claude mcp add arctic-shift /opt/homebrew/bin/arctic-shift-mcp --scope user
```

If npm installed the binary elsewhere, use `which arctic-shift-mcp` to find the path.

## Tools

### `get_post`
Fetch Reddit content from any Reddit link. Handles `/s/` share links copied from the Reddit app (for posts and comments alike) by following Reddit's redirect to the real URL.

- **Post link** → title, full body, stats, and the comment tree.
- **Comment link** → post header, up to 3 parent comments for context, the shared comment in full, and its reply thread.
- **Subreddit/profile link** → a clear error pointing to `search_submissions`.

```
url_or_id      Share link, /comments/ URL, comment permalink, redd.it link, or post ID (required)
comment_limit  Max comments to include (default 50, max 500, 0 for none)
```

### `search_submissions`
Search Reddit posts by keyword, subreddit, author, date range, or flair.

```
query          Keyword search in title and body
subreddit      Subreddit name without r/ prefix
author         Filter by username
after          Posts after this date (e.g. "1year", "6m", "2025-01-01")
before         Posts before this date
limit          Results to return (1-100, default 15)
sort_by        date_desc | date_asc | score | num_comments
               score/num_comments fetch 50 then rank client-side
min_comments   Minimum comment count (client-side filter)
link_flair_text  Filter by post flair
title          Keyword search in title only (requires subreddit or author)
```

### `search_comments`
Search comments by keyword. Supports `link_id` to get comments from a specific post — this works correctly (unlike PullPush which has no post ID filter).

```
query      Keyword search in comment body
link_id    Post ID to get comments from (e.g. "1abc2d3")
subreddit  Subreddit name
author     Filter by username
after      Comments after this date
before     Comments before this date
limit      Results to return (1-100, default 20)
```

### `get_post_comments`
Get the full nested comment tree for a post, sorted by score.

```
link_id  Post ID or any Reddit post URL, required (e.g. "1abc2d3", "t3_1abc2d3", or a /s/ share link)
limit    Max comments to return (default 50, max 500)
```

## Usage with Claude Code

Once registered, call it in any Claude Code session:

```
/reddit best espresso machine under $500
```

Or use it directly:

> Search r/espresso for recommendations on entry-level espresso machines, focus on posts from 2025.

## Pair with

For full Reddit coverage across all time periods:

```bash
npm install -g pullpush-mcp          # 2005 → May 2025
npm install -g arctic-shift-mcp      # May 2025 → today (~48h lag)  ← this package
npm install -g reddit-mcp-buddy      # live (last resort, frequently blocked by Reddit)
```

## Stack

- TypeScript, compiled to a single `dist/index.js`
- MCP SDK (`@modelcontextprotocol/sdk`)
- No extra dependencies beyond the SDK
- Token-efficient: only fetches the fields actually needed (`id`, `title`, `author`, `score`, `num_comments`, `created_utc`, `body`, `link_flair_text`)

## License

MIT
