import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BASE_URL = "https://arctic-shift.photon-reddit.com";

// Only fetch fields we actually use — keeps responses token-efficient
const POST_FIELDS = "id,title,author,subreddit,score,num_comments,created_utc,url,selftext,link_flair_text";
const COMMENT_FIELDS = "id,author,subreddit,score,body,created_utc,link_id,parent_id";

// ─── API client ────────────────────────────────────────────────────────────

async function fetchAPI(
  endpoint: string,
  params: Record<string, string | number | boolean | undefined>
): Promise<any> {
  const url = new URL(`${BASE_URL}${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const res = await fetch(url.toString(), {
    headers: { "User-Agent": "arctic-shift-mcp/1.0.0" },
  });

  const remaining = res.headers.get("X-RateLimit-Remaining");
  if (remaining && parseInt(remaining) < 5) {
    process.stderr.write(`[arctic-shift-mcp] Rate limit low: ${remaining} requests remaining\n`);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Arctic Shift API ${res.status}: ${text}`);
  }

  const json = await res.json();
  if (json.error) throw new Error(`Arctic Shift: ${json.error}`);
  return json.data;
}

// ─── Reddit link resolution ─────────────────────────────────────────────────

interface RedditRef {
  postId: string;
  commentId?: string;
}

// Share links (reddit.com/r/<sub>/s/<code>) hide the post ID; Reddit answers
// them with a 301 whose Location is the canonical /comments/<id>/ URL.
async function resolveShareLink(url: string): Promise<string> {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetch(current, {
      redirect: "manual",
      headers: { "User-Agent": "arctic-shift-mcp/1.1.0" },
    });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).toString();
      if (/\/comments\/[a-z0-9]+/i.test(current)) return current;
      continue;
    }
    throw new Error(
      `Could not resolve share link (Reddit returned HTTP ${res.status}). ` +
        "Ask for the full URL containing /comments/<id>/ or the post title instead."
    );
  }
  throw new Error("Could not resolve share link: too many redirects.");
}

// Accepts a bare post ID (with or without t3_), a full post/comment URL,
// a redd.it short link, or a /s/ share link.
async function parseRedditRef(input: string): Promise<RedditRef> {
  let s = input.trim();

  if (!/[/.]/.test(s)) {
    return { postId: s.replace(/^t3_/, "") };
  }

  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;

  if (/reddit\.com\/r\/[^/]+\/s\/[a-z0-9]+/i.test(s) || /reddit\.com\/s\/[a-z0-9]+/i.test(s)) {
    s = await resolveShareLink(s);
  }

  const short = s.match(/redd\.it\/([a-z0-9]+)/i);
  if (short) return { postId: short[1] };

  // /comments/<post>/<slug>/<comment>/ (old style) or /comments/<post>/comment/<comment>/
  const m = s.match(/\/comments\/([a-z0-9]+)(?:\/([^/?#]*))?(?:\/([a-z0-9]+))?/i);
  if (!m) throw new Error(`Not a recognisable Reddit post link or ID: ${input}`);

  const postId = m[1];
  let commentId: string | undefined;
  if (m[2] === "comment" && m[3]) commentId = m[3];
  else if (m[2] && m[3]) commentId = m[3];
  return { postId, commentId };
}

// ─── Formatters ─────────────────────────────────────────────────────────────

function formatPost(p: any): string {
  const date = new Date(p.created_utc * 1000).toISOString().split("T")[0];
  const preview = p.selftext
    ? p.selftext.slice(0, 250).replace(/\n+/g, " ").trim()
    : "";
  return [
    `[${p.id}] ${p.title}`,
    `r/${p.subreddit} • u/${p.author} • score: ${p.score} • comments: ${p.num_comments} • ${date}`,
    p.link_flair_text ? `flair: ${p.link_flair_text}` : null,
    preview ? `body: ${preview}${p.selftext.length > 250 ? "…" : ""}` : null,
    `link: https://reddit.com/r/${p.subreddit}/comments/${p.id}/`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatComment(c: any): string {
  const date = new Date(c.created_utc * 1000).toISOString().split("T")[0];
  const body = c.body ? c.body.slice(0, 400).replace(/\n+/g, " ").trim() : "[deleted]";
  return `u/${c.author} • score: ${c.score} • ${date}\n${body}`;
}

function flattenTree(comments: any[], depth = 0): string[] {
  const lines: string[] = [];
  for (const item of comments) {
    // Tree endpoint wraps each comment in {kind: "t1", data: {...}}
    const c = item?.data ?? item;
    // Skip placeholders (deleted comments or "load more" stubs)
    if (!c?.created_utc || !c?.author) continue;
    const indent = "  ".repeat(depth);
    const date = new Date(c.created_utc * 1000).toISOString().split("T")[0];
    const body = c.body ? c.body.slice(0, 400).replace(/\n+/g, " ").trim() : "[deleted]";
    lines.push(`${indent}u/${c.author} (score: ${c.score}, ${date}): ${body}`);
    // replies format: {kind: "Listing", data: {children: [...]}} or "" or null
    const children = c.replies?.data?.children ?? [];
    if (children.length) {
      lines.push(...flattenTree(children, depth + 1));
    }
  }
  return lines;
}

// ─── MCP server ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: "arctic-shift-mcp", version: "1.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_post",
      description:
        "Fetch one Reddit post (title, full body, stats) plus its top comments from any Reddit link or post ID. " +
        "Accepts share links (reddit.com/r/<sub>/s/<code>, as copied from the Reddit app), " +
        "full /comments/ URLs, comment permalinks, redd.it short links, or bare IDs. " +
        "Use this whenever the user pastes a Reddit link.",
      inputSchema: {
        type: "object",
        required: ["url_or_id"],
        properties: {
          url_or_id: {
            type: "string",
            description: "Any Reddit post/comment URL (including /s/ share links) or a post ID",
          },
          comment_limit: {
            type: "number",
            description: "Max comments to include (default 50, max 500, 0 for none)",
            default: 50,
          },
        },
      },
    },
    {
      name: "search_submissions",
      description:
        "Search Reddit posts in the Arctic Shift archive (covers 2005 to today, usually within hours). " +
        "Searches by keyword, subreddit, author, date range. " +
        "Use sort_by to rank results by score or num_comments (client-side after fetching).",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Keyword search across title and body",
          },
          title: {
            type: "string",
            description: "Keyword search in title only (requires subreddit or author)",
          },
          subreddit: {
            type: "string",
            description: "Subreddit name without r/ prefix",
          },
          author: {
            type: "string",
            description: "Filter by username",
          },
          after: {
            type: "string",
            description: "Posts after this date (e.g. '1year', '6m', '2024-01-01')",
          },
          before: {
            type: "string",
            description: "Posts before this date",
          },
          limit: {
            type: "number",
            description: "Results to fetch (1-100, default 15). Fetch more when sorting client-side.",
            default: 15,
          },
          sort_by: {
            type: "string",
            enum: ["date_desc", "date_asc", "score", "num_comments"],
            description: "date_desc = newest first (default). score/num_comments = fetch 50 then rank.",
            default: "date_desc",
          },
          min_comments: {
            type: "number",
            description: "Minimum comment count (client-side filter)",
          },
          link_flair_text: {
            type: "string",
            description: "Filter by post flair",
          },
        },
      },
    },
    {
      name: "search_comments",
      description:
        "Search Reddit comments in the Arctic Shift archive. " +
        "Supports link_id to get comments from a specific post — unlike PullPush, this actually works.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Keyword search in comment body",
          },
          link_id: {
            type: "string",
            description: "Post ID to get comments from (e.g. '1abc2d3'). Strips t3_ prefix automatically.",
          },
          subreddit: {
            type: "string",
            description: "Subreddit name without r/ prefix",
          },
          author: {
            type: "string",
            description: "Filter by username",
          },
          after: {
            type: "string",
            description: "Comments after this date",
          },
          before: {
            type: "string",
            description: "Comments before this date",
          },
          limit: {
            type: "number",
            description: "Results to return (1-100, default 20)",
            default: 20,
          },
        },
      },
    },
    {
      name: "get_post_comments",
      description:
        "Get the full comment tree for a Reddit post. " +
        "Returns comments sorted by score (best first). Ideal for reading a post's discussion.",
      inputSchema: {
        type: "object",
        required: ["link_id"],
        properties: {
          link_id: {
            type: "string",
            description: "Post ID (e.g. '1abc2d3', with or without t3_ prefix) or any Reddit post URL, including /s/ share links",
          },
          limit: {
            type: "number",
            description: "Max comments to return (default 50, max 500)",
            default: 50,
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // ── get_post ───────────────────────────────────────────────────────────
    if (name === "get_post") {
      const ref = await parseRedditRef(String(args?.url_or_id ?? ""));
      const commentLimit = Math.min((args?.comment_limit as number) ?? 50, 500);

      const posts: any[] = await fetchAPI("/api/posts/ids", {
        ids: ref.postId,
        fields: POST_FIELDS,
      });
      const p = posts?.[0];
      if (!p) {
        return {
          content: [{ type: "text", text: `Post ${ref.postId} is not in the Arctic Shift archive (yet).` }],
        };
      }

      const date = new Date(p.created_utc * 1000).toISOString().split("T")[0];
      const body = p.selftext ? p.selftext.slice(0, 5000) : "";
      const sections: string[] = [
        [
          `[${p.id}] ${p.title}`,
          `r/${p.subreddit} • u/${p.author} • score: ${p.score} • comments: ${p.num_comments} • ${date}`,
          p.link_flair_text ? `flair: ${p.link_flair_text}` : null,
          p.url && !p.url.includes(`/comments/${p.id}`) ? `linked url: ${p.url}` : null,
          `link: https://reddit.com/r/${p.subreddit}/comments/${p.id}/`,
          body ? `\n${body}${p.selftext.length > 5000 ? "\n…[truncated]" : ""}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
      ];

      if (ref.commentId) {
        const linked: any[] = await fetchAPI("/api/comments/ids", {
          ids: ref.commentId,
          fields: COMMENT_FIELDS,
        });
        if (linked?.[0]) {
          sections.push(`Linked comment:\n${formatComment(linked[0])}`);
        }
      }

      if (commentLimit > 0) {
        const tree: any[] = await fetchAPI("/api/comments/tree", {
          link_id: p.id,
          limit: commentLimit,
        });
        const lines = tree?.length ? flattenTree(Array.isArray(tree) ? tree : [tree]) : [];
        sections.push(lines.length ? `Comments:\n${lines.join("\n")}` : "No comments archived.");
      }

      return { content: [{ type: "text", text: sections.join("\n\n---\n\n") }] };
    }

    // ── search_submissions ─────────────────────────────────────────────────
    if (name === "search_submissions") {
      const sortBy = (args?.sort_by as string) ?? "date_desc";
      // Fetch more when we need to sort client-side
      const fetchLimit = ["score", "num_comments"].includes(sortBy)
        ? Math.max((args?.limit as number) ?? 15, 50)
        : (args?.limit as number) ?? 15;

      const params: Record<string, any> = {
        query: args?.query,
        title: args?.title,
        subreddit: args?.subreddit,
        author: args?.author,
        after: args?.after,
        before: args?.before,
        link_flair_text: args?.link_flair_text,
        limit: fetchLimit,
        sort: sortBy === "date_asc" ? "asc" : "desc",
        fields: POST_FIELDS,
      };

      let posts: any[] = await fetchAPI("/api/posts/search", params);

      if (!posts?.length) {
        return { content: [{ type: "text", text: "No posts found." }] };
      }

      // Client-side filters
      if (args?.min_comments) {
        posts = posts.filter((p) => p.num_comments >= (args.min_comments as number));
      }

      // Client-side sort
      if (sortBy === "score") {
        posts.sort((a, b) => b.score - a.score);
      } else if (sortBy === "num_comments") {
        posts.sort((a, b) => b.num_comments - a.num_comments);
      }

      // Trim to requested limit
      const finalLimit = (args?.limit as number) ?? 15;
      posts = posts.slice(0, finalLimit);

      const formatted = posts.map(formatPost).join("\n\n---\n\n");
      return {
        content: [{ type: "text", text: `Found ${posts.length} posts:\n\n${formatted}` }],
      };
    }

    // ── search_comments ────────────────────────────────────────────────────
    if (name === "search_comments") {
      // Strip t3_ prefix if present
      const rawLinkId = args?.link_id as string | undefined;
      const linkId = rawLinkId?.replace(/^t3_/, "");

      const params: Record<string, any> = {
        body: args?.query,
        link_id: linkId,
        subreddit: args?.subreddit,
        author: args?.author,
        after: args?.after,
        before: args?.before,
        limit: (args?.limit as number) ?? 20,
        sort: "desc",
        fields: COMMENT_FIELDS,
      };

      const comments: any[] = await fetchAPI("/api/comments/search", params);

      if (!comments?.length) {
        return { content: [{ type: "text", text: "No comments found." }] };
      }

      // Sort by score client-side (API only sorts by date)
      comments.sort((a, b) => b.score - a.score);

      const formatted = comments.map(formatComment).join("\n\n---\n\n");
      return {
        content: [
          { type: "text", text: `Found ${comments.length} comments:\n\n${formatted}` },
        ],
      };
    }

    // ── get_post_comments ──────────────────────────────────────────────────
    if (name === "get_post_comments") {
      const rawId = (await parseRedditRef(String(args?.link_id ?? ""))).postId;
      const limit = (args?.limit as number) ?? 50;

      const params: Record<string, any> = {
        link_id: rawId,
        limit: Math.min(limit, 500),
      };

      const tree: any[] = await fetchAPI("/api/comments/tree", params);

      if (!tree?.length) {
        return { content: [{ type: "text", text: "No comments found for this post." }] };
      }

      const lines = flattenTree(Array.isArray(tree) ? tree : [tree]);
      return {
        content: [
          {
            type: "text",
            text: `Comment tree for post ${rawId} (${lines.length} lines):\n\n${lines.join("\n")}`,
          },
        ],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("Arctic Shift MCP server running\n");
