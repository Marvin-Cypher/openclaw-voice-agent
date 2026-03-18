import { execFile } from "node:child_process";
import { config } from "./config.js";

// ── Composio session state ──────────────────────────────────────────────
let composioSessionId = null;

// Connected apps (from Composio): gmail, googlecalendar, googledrive,
// googlesheets, linkedin, notion, slack, youtube
const CONNECTED_APPS = "gmail, googlecalendar, googledrive, googlesheets, linkedin, notion, slack, youtube";

// ── Tool definitions (3 tiers) ──────────────────────────────────────────
export const TOOLS = [
  // ── TIER 1: Composio (all connected apps via single smart tool) ──
  {
    type: "function",
    name: "composio_action",
    description: `Execute actions on connected apps: ${CONNECTED_APPS}. Use for ANY request involving these apps — reading/sending emails, checking/creating calendar events, reading/updating Google Sheets or Docs, posting to Slack, searching Notion, checking LinkedIn, YouTube, Google Drive. Describe what you want to do in plain English.`,
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "What to do, in plain English. Examples: 'get my latest 5 unread emails', 'what meetings do I have tomorrow', 'send email to john@example.com about the Q1 report', 'post hello to slack channel general', 'find my recent notion pages', 'list files in my google drive'",
        },
      },
      required: ["action"],
    },
  },

  // ── TIER 2: Hardcoded tools (fast, no external deps) ──
  {
    type: "function",
    name: "check_portfolio",
    description: "Check current short-scanner portfolio positions, P&L, and exposure for stock shorts",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "check_market",
    description: "Get current market data or quote for a stock ticker",
    parameters: {
      type: "object",
      properties: {
        ticker: { type: "string", description: "Stock ticker symbol (e.g. AAPL, TSLA)" },
      },
      required: ["ticker"],
    },
  },
  {
    type: "function",
    name: "check_crypto_portfolio",
    description: "Check crypto portfolio holdings and current prices — BTC, ETH, PHA, and other tokens with live prices",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "clawdi_metrics",
    description: "Get Clawdi platform metrics: total users, plan breakdown, active users, deployments, usage by model, top users. For questions about Clawdi stats, user counts, growth, signups.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "'users' for total+plan breakdown, 'new' for growth/active users, 'deployments' for active deploys, 'by_model' for model usage, 'top_users' for top users, 'overview' for everything",
        },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "phala_metrics",
    description: "Get Phala Cloud and RedPill platform metrics: active CVMs, new signups, RedPill requests, unique users, MRR, top models",
    parameters: {
      type: "object",
      properties: {
        days: { type: "number", description: "Days to look back (1 for 24h, 7 for weekly). Default 1." },
      },
    },
  },
  {
    type: "function",
    name: "get_cron_status",
    description: "Check status of scheduled cron jobs (daily scans, memos, engagement posts, etc.)",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "get_time",
    description: "Get the current date and time",
    parameters: { type: "object", properties: {} },
  },

  // ── TIER 3: Ask Rico (OpenClaw backend) for anything else ──
  {
    type: "function",
    name: "ask_rico",
    description: "Ask the full Rico AI agent (OpenClaw backend) to handle complex tasks, run skills, search the web, analyze data, or anything else not covered by other tools. Use this as a fallback when no other tool fits. Rico has access to 100+ skills, web search, browser, file operations, and more.",
    parameters: {
      type: "object",
      properties: {
        request: {
          type: "string",
          description: "What to ask Rico to do. Be specific. Examples: 'run a short scan for new candidates', 'search the web for latest PHA token news', 'check my Telegram messages', 'analyze the top movers today'",
        },
      },
      required: ["request"],
    },
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────

function runScript(cmd, args = [], timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 512 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

// ── Clawdi Admin API ────────────────────────────────────────────────────

const CLAWDI_API = "https://api.clawdi.ai/admin";
const CLAWDI_KEY = "007e2657ab7646d0f75901d58c79cf1324d2df89eed48840c3aff4fab50d41f4";

async function clawdiGet(path) {
  const res = await fetch(`${CLAWDI_API}${path}`, {
    headers: { "X-Admin-API-Key": CLAWDI_KEY },
  });
  if (!res.ok) throw new Error(`Clawdi API ${res.status}: ${res.statusText}`);
  return res.json();
}

// ── Composio MCP ────────────────────────────────────────────────────────

async function composioCall(method, params = {}) {
  const url = config.composioMcpUrl;
  if (!url) throw new Error("Composio MCP not configured");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "x-api-key": config.composioApiKey || "",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });

  const text = await res.text();
  const dataMatch = text.match(/^data:\s*(.+)$/m);
  const parsed = dataMatch ? JSON.parse(dataMatch[1]) : JSON.parse(text);
  if (parsed.error) throw new Error(parsed.error.message || JSON.stringify(parsed.error));
  return parsed.result;
}

function extractComposioText(result) {
  const content = result?.content;
  if (content && Array.isArray(content)) {
    return content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  }
  return JSON.stringify(result).slice(0, 1000);
}

function extractSessionId(result) {
  const content = result?.content;
  if (content && Array.isArray(content)) {
    for (const item of content) {
      if (item.type === "text") {
        const m = item.text.match(/"session_id"\s*:\s*"([^"]+)"/);
        if (m) return m[1];
      }
    }
  }
  return null;
}

async function composioAction(actionText, log) {
  // Step 1: Search for the right tools
  const searchResult = await composioCall("tools/call", {
    name: "COMPOSIO_SEARCH_TOOLS",
    arguments: {
      queries: [{ use_case: actionText }],
      session: composioSessionId ? { id: composioSessionId } : { generate_id: true },
      model: "gpt-4o",
    },
  });

  const sid = extractSessionId(searchResult);
  if (sid) {
    composioSessionId = sid;
    log.info(`Composio session: ${sid}`);
  }

  const searchText = extractComposioText(searchResult);
  log.info(`Composio search (truncated): ${searchText.slice(0, 300)}`);

  // Parse the search result JSON to get primary_tool_slugs
  let primarySlug = null;
  try {
    const inner = JSON.parse(searchText);
    const results = inner?.data?.results || [];
    if (results.length > 0) {
      const slugs = results[0].primary_tool_slugs || [];
      if (slugs.length > 0) primarySlug = slugs[0];
    }
  } catch {
    // Fallback: regex search for tool slugs
    const m = searchText.match(/"primary_tool_slugs"\s*:\s*\["([A-Z_]+)"/);
    if (m) primarySlug = m[1];
  }

  if (!primarySlug) {
    // Try related_tool_slugs
    const m = searchText.match(/"related_tool_slugs"\s*:\s*\["([A-Z_]+)"/);
    if (m) primarySlug = m[1];
  }

  if (!primarySlug) {
    if (searchText.includes("no active connection") || searchText.includes("COMPOSIO_MANAGE_CONNECTIONS")) {
      return "This app needs to be reconnected in the Composio dashboard.";
    }
    return `Couldn't find a tool for "${actionText}". Connected apps: ${CONNECTED_APPS}`;
  }

  // Override bad tool selections
  if (primarySlug === "LINKEDIN_GET_ORG_PAGE_STATS" && !actionText.match(/org|company|page stats/i)) {
    primarySlug = "LINKEDIN_GET_MY_INFO"; // Personal profile, not org stats
  }
  if (primarySlug.startsWith("HEYREACH_")) {
    primarySlug = "LINKEDIN_GET_MY_INFO"; // HeyReach is not connected, use native LinkedIn
  }
  // Calendar: force event listing for "next meeting", "upcoming events", etc.
  if (primarySlug === "GOOGLECALENDAR_GET_CURRENT_DATE_TIME" && actionText.match(/meeting|event|schedule|calendar|agenda|appointment/i)) {
    primarySlug = "GOOGLECALENDAR_FIND_EVENT";
  }

  log.info(`Composio using tool: ${primarySlug}`);

  // Build arguments for the tool
  const toolArgs = buildToolArgs(primarySlug, actionText);
  log.info(`Composio tool args: ${JSON.stringify(toolArgs)}`);

  // Step 2: Execute
  try {
    const execResult = await composioCall("tools/call", {
      name: "COMPOSIO_MULTI_EXECUTE_TOOL",
      arguments: {
        tools: [{ tool_slug: primarySlug, arguments: toolArgs }],
        sync_response_to_workbench: false,
        session_id: composioSessionId || "",
        thought: actionText,
      },
    });

    const execText = extractComposioText(execResult);
    log.info(`Composio exec result (truncated): ${execText.slice(0, 300)}`);

    // Parse and summarize the result for voice
    try {
      const execParsed = JSON.parse(execText);
      if (execParsed?.data?.results) {
        const results = execParsed.data.results;
        // Summarize each result
        const summaries = results.map((r) => {
          const resp = r.response?.data || r.response || r;
          return JSON.stringify(resp).slice(0, 800);
        });
        return summaries.join("\n");
      }
      return execText.slice(0, 1500);
    } catch {
      return execText.slice(0, 1500);
    }
  } catch (err) {
    log.error(`Composio exec error: ${err.message}`);
    return `Error executing ${primarySlug}: ${err.message}`;
  }
}

function buildToolArgs(toolSlug, actionText) {
  const args = {};

  if (toolSlug.startsWith("GMAIL_FETCH") || toolSlug.startsWith("GMAIL_LIST")) {
    args.user_id = "me";
    const countMatch = actionText.match(/(\d+)\s*(?:latest|recent|last|emails?|messages?)/i) || actionText.match(/(?:latest|recent|last)\s*(\d+)/i);
    args.max_results = countMatch ? parseInt(countMatch[1]) : 5;
    const qMatch = actionText.match(/(?:about|from|subject|regarding|mention(?:ing|ed)?|for)\s+['"]?(.+?)['"]?$/i);
    if (qMatch) args.q = qMatch[1];
  } else if (toolSlug.startsWith("GMAIL_SEND")) {
    args.user_id = "me";
    const toMatch = actionText.match(/(?:to|email)\s+([\w.+-]+@[\w.-]+)/i);
    if (toMatch) args.to = toMatch[1];
  } else if (toolSlug.startsWith("GOOGLECALENDAR_FIND") || toolSlug.startsWith("GOOGLECALENDAR_LIST") || toolSlug.startsWith("GOOGLECALENDAR_EVENTS") || (toolSlug.startsWith("GOOGLECALENDAR_GET") && toolSlug !== "GOOGLECALENDAR_GET_CURRENT_DATE_TIME")) {
    args.calendar_id = "primary";
    const now = new Date();
    args.time_min = now.toISOString();
    args.timeMin = now.toISOString();
    const daysMatch = actionText.match(/(\d+)\s*days?/i);
    const weekMatch = actionText.match(/this\s+week|next\s+week/i);
    const days = daysMatch ? parseInt(daysMatch[1]) : weekMatch ? 7 : 1;
    args.time_max = new Date(now.getTime() + days * 86400000).toISOString();
    args.timeMax = new Date(now.getTime() + days * 86400000).toISOString();
    args.max_results = 10;
  } else if (toolSlug.startsWith("GOOGLECALENDAR_CREATE")) {
    args.calendar_id = "primary";

    // Extract date/time — look for ISO-like patterns or natural date references
    const isoMatch = actionText.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)/);
    if (isoMatch) {
      args.start_datetime = isoMatch[1];
      // Default 1 hour duration
      const start = new Date(isoMatch[1]);
      const end = new Date(start.getTime() + 3600000);
      args.end_datetime = end.toISOString().replace(/\.\d+Z$/, "");
    } else {
      // Try to build datetime from natural language
      const now = new Date();
      let targetDate = new Date(now);

      if (/tomorrow/i.test(actionText)) {
        targetDate.setDate(targetDate.getDate() + 1);
      } else if (/next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i.test(actionText)) {
        const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
        const target = days.indexOf(actionText.match(/next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i)[1].toLowerCase());
        const current = targetDate.getDay();
        const diff = ((target - current + 7) % 7) || 7;
        targetDate.setDate(targetDate.getDate() + diff);
      } else {
        // Try to extract date like "March 17" or "March 17th"
        const monthMatch = actionText.match(/(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/i);
        if (monthMatch) {
          const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
          const month = months.indexOf(monthMatch[1].toLowerCase());
          const day = parseInt(monthMatch[2]);
          const year = monthMatch[3] ? parseInt(monthMatch[3]) : now.getFullYear();
          targetDate = new Date(year, month, day);
        }
      }

      // Extract time
      const timeMatch = actionText.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm|AM|PM)/i);
      if (timeMatch) {
        let hours = parseInt(timeMatch[1]);
        const minutes = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
        const ampm = timeMatch[3].toLowerCase();
        if (ampm === "pm" && hours !== 12) hours += 12;
        if (ampm === "am" && hours === 12) hours = 0;
        targetDate.setHours(hours, minutes, 0, 0);
      } else {
        // Check for 24h time like "15:00"
        const h24Match = actionText.match(/(\d{1,2}):(\d{2})(?:\s|$)/);
        if (h24Match) {
          targetDate.setHours(parseInt(h24Match[1]), parseInt(h24Match[2]), 0, 0);
        }
      }

      const pad = (n) => String(n).padStart(2, "0");
      const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
      args.start_datetime = fmt(targetDate);
      const endDate = new Date(targetDate.getTime() + 3600000);
      args.end_datetime = fmt(endDate);
    }

    // Extract title/summary — use the person's name or meeting subject
    const withMatch = actionText.match(/(?:with|meeting\s+with)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/);
    const aboutMatch = actionText.match(/(?:about|titled?|called|named)\s+['"]?(.+?)['"]?(?:\s+(?:on|at|tomorrow|next)|\s*$)/i);
    if (aboutMatch) {
      args.title = aboutMatch[1];
    } else if (withMatch) {
      args.title = `Meeting with ${withMatch[1]}`;
    } else {
      // Use the action text as title, cleaned up
      args.title = actionText.replace(/^(schedule|create|set up|book|add)\s+(a\s+)?/i, "").replace(/\s+(on|at|for|tomorrow|next)\s+.*/i, "") || "Meeting";
    }

    // Extract attendees if email provided
    const emailMatch = actionText.match(/([\w.+-]+@[\w.-]+)/);
    if (emailMatch) {
      args.attendees = [emailMatch[1]];
    }
  } else if (toolSlug === "SLACK_SEARCH_MESSAGES") {
    args.query = actionText.match(/(?:about|for|regarding)\s+['"]?(.+?)['"]?$/i)?.[1] || "*";
    args.count = 5;
  } else if (toolSlug === "SLACK_FETCH_CONVERSATION_HISTORY") {
    args.limit = 10;
    // Try to extract channel name
    const chMatch = actionText.match(/(?:channel|in)\s+#?(\S+)/i);
    if (chMatch) args.channel = chMatch[1];
  } else if (toolSlug === "SLACK_LIST_CONVERSATIONS") {
    args.limit = 20;
  } else if (toolSlug.startsWith("SLACK_SEND")) {
    const chMatch = actionText.match(/(?:channel|to|in)\s+#?(\S+)/i);
    if (chMatch) args.channel = chMatch[1];
    const msgMatch = actionText.match(/(?:say|post|send|message)\s+['"](.+?)['"]/i);
    if (msgMatch) args.text = msgMatch[1];
  } else if (toolSlug === "LINKEDIN_GET_MY_INFO") {
    // No args needed
  } else if (toolSlug === "LINKEDIN_CREATE_LINKED_IN_POST") {
    const textMatch = actionText.match(/(?:post|say|share)\s+['"]?(.+?)['"]?$/i);
    if (textMatch) args.text = textMatch[1];
  } else if (toolSlug === "LINKEDIN_GET_COMPANY_INFO") {
    const coMatch = actionText.match(/(?:company|about)\s+['"]?(\S+)['"]?/i);
    if (coMatch) args.company_name = coMatch[1];
  } else if (toolSlug.startsWith("NOTION_")) {
    // Notion tools vary
  } else if (toolSlug.startsWith("GOOGLEDRIVE_")) {
    args.page_size = 10;
  } else if (toolSlug.startsWith("GOOGLESHEETS_")) {
    // Sheets tools vary
  } else if (toolSlug.startsWith("YOUTUBE_")) {
    const qMatch = actionText.match(/(?:search|find|about)\s+['"]?(.+?)['"]?$/i);
    if (qMatch) args.query = qMatch[1];
    args.max_results = 5;
  }

  return args;
}

// ── Main handler ────────────────────────────────────────────────────────

export async function handleFunctionCall(name, argsJson, log) {
  const args = argsJson ? JSON.parse(argsJson) : {};
  log.info(`Executing tool: ${name} with args: ${JSON.stringify(args)}`);

  switch (name) {
    // ── TIER 1: Composio ──

    case "composio_action": {
      try {
        return await composioAction(args.action, log);
      } catch (err) {
        log.error(`Composio error: ${err.message}`);
        return `Composio error: ${err.message}`;
      }
    }

    // ── TIER 2: Hardcoded tools ──

    case "check_portfolio": {
      const dir = `${config.openclawSkillsDir}/short-scanner/scripts`;
      return await runScript("node", [`${dir}/trade.js`, "--portfolio"]);
    }

    case "check_market": {
      const ticker = args.ticker?.toUpperCase();
      if (!ticker) return "No ticker provided";
      const dir = `${config.openclawSkillsDir}/short-scanner/scripts`;
      return await runScript("node", [`${dir}/trade.js`, "--quote", ticker]);
    }

    case "check_crypto_portfolio": {
      try {
        const result = await runScript("node", [
          `${config.openclawSkillsDir}/portfolio-watch/scripts/check-portfolio.mjs`,
        ], 20000);
        const p = JSON.parse(result);
        if (!p.ok) return `Portfolio error: ${p.error || "unknown"}`;
        const total = Math.round(p.totalUsd || 0).toLocaleString();
        const changePct = (p.portfolioChangePct || 0).toFixed(1);
        const changeUsd = Math.round(p.portfolioChangeUsd || 0).toLocaleString();
        const positions = (p.positions || []).slice(0, 8);
        const lines = positions.map((pos) => {
          const val = Math.round(pos.valueUsd).toLocaleString();
          const pct = pos.portfolioPct?.toFixed(1) || "0";
          const ch = pos.change24hPct ? ` (${pos.change24hPct > 0 ? "+" : ""}${pos.change24hPct.toFixed(1)}% 24h)` : "";
          return `${pos.symbol}: $${val} (${pct}%)${ch}`;
        });
        return `Crypto portfolio: $${total} total (${changePct}% / $${changeUsd} change)\n${lines.join("\n")}`;
      } catch (err) {
        return `Portfolio error: ${err.message}`;
      }
    }

    case "clawdi_metrics": {
      const q = (args.query || "overview").toLowerCase();
      try {
        if (q.includes("new") || q.includes("signup") || q.includes("growth")) {
          const users = await clawdiGet("/users?limit=1");
          const usage24h = await clawdiGet("/usage/global?days=1");
          const usage7d = await clawdiGet("/usage/global?days=7");
          const activeToday = usage24h.items?.reduce((s, i) => Math.max(s, i.unique_users || 0), 0) || 0;
          const active7d = usage7d.items?.reduce((s, i) => Math.max(s, i.unique_users || 0), 0) || 0;
          const totalReqs24h = usage24h.items?.reduce((s, i) => s + (i.requests || 0), 0) || 0;
          return `Clawdi: ${users.count} total users. Last 24h: ${activeToday} active users, ${totalReqs24h.toLocaleString()} requests. Last 7d: ${active7d} unique active users.`;
        } else if (q.includes("user")) {
          const data = await clawdiGet("/users?limit=5000");
          const plans = {};
          for (const u of data.items || []) plans[u.plan || "free"] = (plans[u.plan || "free"] || 0) + 1;
          const breakdown = Object.entries(plans).map(([p, c]) => `${p}: ${c}`).join(", ");
          return `Total Clawdi users: ${data.count}. Plan breakdown: ${breakdown}`;
        } else if (q.includes("deploy")) {
          const data = await clawdiGet("/deployments?limit=1");
          return `Active deployments: ${data.count || 0}`;
        } else if (q.includes("model")) {
          const data = await clawdiGet("/usage/by-model?days=7");
          const lines = (data.items || []).slice(0, 10).map((m) =>
            `${m.model || m.name}: ${(m.requests || 0).toLocaleString()} reqs`);
          return `Usage by model (7d):\n${lines.join("\n")}`;
        } else if (q.includes("top")) {
          const data = await clawdiGet("/usage/users?days=7&limit=10");
          const lines = (data.items || []).slice(0, 10).map((u, i) =>
            `${i + 1}. ${u.name || u.user_id}: ${(u.requests || 0).toLocaleString()} reqs`);
          return `Top users (7d): ${lines.join(", ")}`;
        } else {
          const users = await clawdiGet("/users?limit=1");
          const usage = await clawdiGet("/usage/global?days=1");
          const totalReqs = usage.items?.reduce((s, i) => s + (i.requests || 0), 0) || 0;
          const activeUsers = usage.items?.reduce((s, i) => Math.max(s, i.unique_users || 0), 0) || 0;
          return `Clawdi: ${users.count} total users, ${activeUsers} active today, ${totalReqs.toLocaleString()} requests (24h).`;
        }
      } catch (err) {
        return `Clawdi API error: ${err.message}`;
      }
    }

    case "phala_metrics": {
      const days = args.days || 1;
      try {
        const result = await runScript("node", [
          "/root/.openclaw/workspace/skills/phala-redpill-metrics/scripts/check-metrics.js",
          "--days", String(days),
        ], 25000);
        const p = JSON.parse(result);
        return p.ok && p.report_markdown ? p.report_markdown : result;
      } catch (err) {
        return `Phala metrics error: ${err.message}`;
      }
    }

    case "get_cron_status": {
      try {
        const { readFileSync } = await import("node:fs");
        const jobs = JSON.parse(readFileSync("/data/openclaw/cron/jobs.json", "utf-8"));
        return jobs.map((j) => {
          const status = j.consecutiveErrors > 0
            ? `ERROR (${j.consecutiveErrors} failures)`
            : j.lastRunAt ? "OK" : "never run";
          return `${j.name}: ${status}, next: ${j.nextRunAt || "unknown"}`;
        }).join("\n");
      } catch (err) {
        return `Cron error: ${err.message}`;
      }
    }

    case "get_time": {
      return new Date().toLocaleString("en-US", {
        timeZone: "America/New_York",
        weekday: "long", year: "numeric", month: "long", day: "numeric",
        hour: "numeric", minute: "2-digit",
      });
    }

    // ── TIER 3: Ask Rico (OpenClaw backend) ──

    case "ask_rico": {
      try {
        log.info(`Delegating to OpenClaw: ${args.request}`);
        const result = await runScript("openclaw", [
          "agent",
          "--agent", "main",
          "--message", args.request,
          "--json",
          "--timeout", "45",
        ], 50000);

        // Parse JSON response
        try {
          const parsed = JSON.parse(result);
          // Extract the agent's reply text
          if (parsed.reply) return parsed.reply;
          if (parsed.text) return parsed.text;
          if (parsed.message) return parsed.message;
          if (parsed.output) return parsed.output;
          // Fallback: stringify
          return JSON.stringify(parsed).slice(0, 1500);
        } catch {
          // Not JSON, return raw text (truncated for voice)
          return result.slice(0, 1500);
        }
      } catch (err) {
        log.error(`ask_rico error: ${err.message}`);
        return `I tried to ask the backend but got an error: ${err.message.slice(0, 200)}`;
      }
    }

    default:
      return `Unknown tool: ${name}`;
  }
}
