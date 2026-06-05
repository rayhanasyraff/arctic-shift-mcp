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
  { name: "arctic-shift-mcp", version: "1.0.2" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "search_submissions",
      description:
        "Search Reddit posts in the Arctic Shift archive (coverage up to ~February 2026). " +
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
            description: "Post ID (e.g. '1abc2d3', with or without t3_ prefix)",
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
      const rawId = (args?.link_id as string).replace(/^t3_/, "");
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
