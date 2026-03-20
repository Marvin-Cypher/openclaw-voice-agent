import { execFile } from "node:child_process";
import { config } from "./config.js";

// ── Composio session state ──────────────────────────────────────────────
let composioSessionId = null;

// ── Tool definitions (2 layers) ─────────────────────────────────────────
export const TOOLS = [
  // ── LAYER 1: Composio Workbench (search → execute) ──
  {
    type: "function",
    name: "search_tools",
    description: `Search for the right tool to handle a request across connected apps: Gmail, Google Calendar, Google Drive, Google Sheets, LinkedIn, Notion, Slack, YouTube. Call this FIRST before execute_tool. Returns the tool name, required parameters, and step-by-step guidance. Always call this before execute_tool.`,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What the user wants to do, in natural language. Examples: 'fetch my latest emails', 'create a calendar event', 'search slack messages', 'get my linkedin profile'",
        },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "execute_tool",
    description: `Execute a Composio tool discovered via search_tools. You MUST call search_tools first to get the tool_slug and required parameters. Pass the exact tool_slug and fill in all required arguments based on the guidance from search_tools. Do NOT guess tool slugs.`,
    parameters: {
      type: "object",
      properties: {
        tool_slug: {
          type: "string",
          description: "The exact tool slug from search_tools result (e.g. GMAIL_FETCH_EMAILS, GOOGLECALENDAR_CREATE_EVENT)",
        },
        arguments: {
          type: "object",
          description: "Arguments for the tool, following the schema from search_tools guidance. Use exact field names and types.",
        },
      },
      required: ["tool_slug", "arguments"],
    },
  },

  // ── LAYER 2: OpenClaw backend (CLI/exec for everything else) ──
  {
    type: "function",
    name: "openclaw",
    description: `Run a task via the OpenClaw AI backend. Use this for: checking platform metrics (Clawdi users, Phala Cloud stats, RedPill usage), portfolio data (crypto holdings, stock positions, market quotes), cron job status, running scripts, web search, data analysis, or any task not handled by Composio tools. The backend has 100+ skills and can execute CLI commands. Be specific in your request.`,
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "What to do. Be specific. Examples: 'how many Clawdi users are there', 'check crypto portfolio', 'get RedPill metrics for the last 24 hours', 'check stock quote for AAPL', 'what are the cron job statuses', 'search the web for latest PHA news'",
        },
      },
      required: ["task"],
    },
  },

  // ── Utility ──
  {
    type: "function",
    name: "get_time",
    description: "Get the current date and time",
    parameters: { type: "object", properties: {} },
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
  return JSON.stringify(result).slice(0, 2000);
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

// ── Clawdi Admin API ────────────────────────────────────────────────────

const CLAWDI_API = "https://api.clawdi.ai/admin";
const CLAWDI_KEY = "007e2657ab7646d0f75901d58c79cf1324d2df89eed48840c3aff4fab50d41f4";

async function clawdiGet(path) {
  const res = await fetch(`${CLAWDI_API}${path}`, {
    headers: { "X-Admin-API-Key": CLAWDI_KEY },
  });
  if (!res.ok) throw new Error(`Clawdi API ${res.status}`);
  return res.json();
}

async function handleClawdiMetrics(query, log) {
  if (query.match(/new|signup|growth|recent/i)) {
    const [users, usage24h, usage7d] = await Promise.all([
      clawdiGet("/users?limit=1"),
      clawdiGet("/usage/global?days=1"),
      clawdiGet("/usage/global?days=7"),
    ]);
    const active24h = usage24h.items?.reduce((s, i) => Math.max(s, i.unique_users || 0), 0) || 0;
    const active7d = usage7d.items?.reduce((s, i) => Math.max(s, i.unique_users || 0), 0) || 0;
    const reqs24h = usage24h.items?.reduce((s, i) => s + (i.requests || 0), 0) || 0;
    return `Clawdi: ${users.count} total users. Last 24h: ${active24h} active, ${reqs24h.toLocaleString()} requests. Last 7d: ${active7d} unique active.`;
  }

  if (query.match(/deploy/i)) {
    const data = await clawdiGet("/deployments?limit=1");
    return `Active deployments: ${data.count || 0}`;
  }

  if (query.match(/model/i)) {
    const data = await clawdiGet("/usage/by-model?days=7");
    const lines = (data.items || []).slice(0, 10).map((m) =>
      `${m.model || m.name}: ${(m.requests || 0).toLocaleString()} reqs`);
    return `Usage by model (7d):\n${lines.join("\n")}`;
  }

  if (query.match(/top/i)) {
    const data = await clawdiGet("/usage/users?days=7&limit=10");
    const lines = (data.items || []).slice(0, 10).map((u, i) =>
      `${i + 1}. ${u.name || u.user_id}: ${(u.requests || 0).toLocaleString()} reqs`);
    return `Top users (7d): ${lines.join(", ")}`;
  }

  // Default: overview
  const [users, usage] = await Promise.all([
    clawdiGet("/users?limit=5000"),
    clawdiGet("/usage/global?days=1"),
  ]);
  const plans = {};
  for (const u of users.items || []) plans[u.plan || "free"] = (plans[u.plan || "free"] || 0) + 1;
  const breakdown = Object.entries(plans).map(([p, c]) => `${p}: ${c}`).join(", ");
  const totalReqs = usage.items?.reduce((s, i) => s + (i.requests || 0), 0) || 0;
  const activeUsers = usage.items?.reduce((s, i) => Math.max(s, i.unique_users || 0), 0) || 0;
  return `Clawdi: ${users.count} users (${breakdown}). ${activeUsers} active today, ${totalReqs.toLocaleString()} requests (24h).`;
}

// ── Main handler ────────────────────────────────────────────────────────

export async function handleFunctionCall(name, argsJson, log) {
  const args = argsJson ? JSON.parse(argsJson) : {};
  log.info(`Executing tool: ${name} with args: ${JSON.stringify(args)}`);

  switch (name) {
    // ── LAYER 1a: Search for Composio tools ──
    case "search_tools": {
      try {
        const searchResult = await composioCall("tools/call", {
          name: "COMPOSIO_SEARCH_TOOLS",
          arguments: {
            queries: [{ use_case: args.query }],
            session: composioSessionId ? { id: composioSessionId } : { generate_id: true },
            model: "gpt-4o",
          },
        });

        const sid = extractSessionId(searchResult);
        if (sid) composioSessionId = sid;

        const searchText = extractComposioText(searchResult);
        log.info(`Composio search result (truncated): ${searchText.slice(0, 400)}`);

        // Parse and return structured guidance for the model
        try {
          const inner = JSON.parse(searchText);
          const results = inner?.data?.results || [];

          if (!results.length) {
            return "No matching tools found. Try rephrasing or use the openclaw tool instead.";
          }

          const r = results[0];
          const slugs = r.primary_tool_slugs || [];
          const guidance = r.execution_guidance || "";

          // Build a concise summary for the voice model
          const summary = [];
          summary.push(`Found tool: ${slugs[0] || "unknown"}`);
          if (slugs.length > 1) summary.push(`Alternatives: ${slugs.slice(1).join(", ")}`);

          // Extract key guidance (parameter requirements, pitfalls)
          if (guidance) {
            // Truncate guidance to fit voice model context
            summary.push(`\nGuidance:\n${guidance.slice(0, 1500)}`);
          }

          if (composioSessionId) {
            summary.push(`\nSession ID: ${composioSessionId}`);
          }

          return summary.join("\n");
        } catch {
          return searchText.slice(0, 2000);
        }
      } catch (err) {
        log.error(`search_tools error: ${err.message}`);
        return `Search error: ${err.message}`;
      }
    }

    // ── LAYER 1b: Execute a Composio tool ──
    case "execute_tool": {
      const slug = args.tool_slug;
      const toolArgs = args.arguments || {};

      if (!slug) return "Missing tool_slug. Call search_tools first.";

      log.info(`Composio execute: ${slug} with args: ${JSON.stringify(toolArgs)}`);

      try {
        const execResult = await composioCall("tools/call", {
          name: "COMPOSIO_MULTI_EXECUTE_TOOL",
          arguments: {
            tools: [{ tool_slug: slug, arguments: toolArgs }],
            sync_response_to_workbench: false,
            session_id: composioSessionId || "",
            thought: `Executing ${slug}`,
          },
        });

        const execText = extractComposioText(execResult);
        log.info(`Composio exec result (truncated): ${execText.slice(0, 400)}`);

        // Parse and return a voice-friendly summary
        try {
          const execParsed = JSON.parse(execText);
          if (execParsed?.data?.results) {
            const results = execParsed.data.results;
            const summaries = results.map((r) => {
              if (r.error) return `Error: ${r.error}`;
              const resp = r.response;
              if (!resp?.successful) {
                const msg = resp?.data?.message || resp?.error || "Unknown error";
                return `Failed: ${msg}`;
              }
              const data = resp?.data || resp?.data_preview || resp;
              return JSON.stringify(data).slice(0, 1200);
            });
            return summaries.join("\n");
          }
          return execText.slice(0, 2000);
        } catch {
          return execText.slice(0, 2000);
        }
      } catch (err) {
        log.error(`execute_tool error: ${err.message}`);
        return `Execute error: ${err.message}`;
      }
    }

    // ── LAYER 2: OpenClaw backend ──
    case "openclaw": {
      const task = args.task;
      if (!task) return "No task provided.";

      log.info(`OpenClaw backend: ${task}`);
      const t = task.toLowerCase();

      // ── Fast paths: direct API/script calls for common queries ──

      // Clawdi metrics
      if (t.match(/clawdi|clawdy|cloudy/i) && t.match(/user|signup|growth|metric|plan|deploy|active|new/i)) {
        try {
          return await handleClawdiMetrics(t, log);
        } catch (err) {
          log.error(`Clawdi metrics error: ${err.message}`);
          return `Clawdi API error: ${err.message}`;
        }
      }

      // Phala / RedPill metrics
      if (t.match(/phala|redpill|red pill|cvm/i) && t.match(/metric|usage|request|user|model|mrr|signup/i)) {
        try {
          const daysMatch = t.match(/(\d+)\s*(?:day|hour)/i);
          const days = daysMatch ? parseInt(daysMatch[1]) : 1;
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

      // Crypto portfolio
      if (t.match(/crypto|bitcoin|btc|eth|pha|token|holdings/i) && t.match(/portfolio|holdings|balance|price|position/i)) {
        try {
          const result = await runScript("node", [
            "/root/.openclaw/skills/portfolio-watch/scripts/check-portfolio.mjs",
          ], 20000);
          const p = JSON.parse(result);
          if (!p.ok) return `Portfolio error: ${p.error || "unknown"}`;
          const total = Math.round(p.totalUsd || 0).toLocaleString();
          const positions = (p.positions || []).slice(0, 8);
          const lines = positions.map((pos) => {
            const val = Math.round(pos.valueUsd).toLocaleString();
            const ch = pos.change24hPct ? ` (${pos.change24hPct > 0 ? "+" : ""}${pos.change24hPct.toFixed(1)}% 24h)` : "";
            return `${pos.symbol}: $${val}${ch}`;
          });
          return `Crypto portfolio: $${total} total\n${lines.join("\n")}`;
        } catch (err) {
          return `Portfolio error: ${err.message}`;
        }
      }

      // Stock portfolio / market quotes
      if (t.match(/stock|short|portfolio|position|trade/i) && !t.match(/crypto/i)) {
        try {
          const dir = "/root/.openclaw/skills/short-scanner/scripts";
          const tickerMatch = t.match(/quote\s+(?:for\s+)?(\w+)/i) || t.match(/price\s+(?:of\s+)?(\w+)/i);
          if (tickerMatch) {
            return await runScript("node", [`${dir}/trade.js`, "--quote", tickerMatch[1].toUpperCase()]);
          }
          return await runScript("node", [`${dir}/trade.js`, "--portfolio"]);
        } catch (err) {
          return `Stock data error: ${err.message}`;
        }
      }

      // Cron status
      if (t.match(/cron|scheduled|job/i)) {
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

      // ── Fallback: openclaw CLI (slow — gateway WS + embedded fallback) ──
      try {
        const result = await runScript("openclaw", [
          "agent",
          "--agent", "main",
          "--message", task,
          "--json",
          "--timeout", "60",
        ], 90000);

        try {
          const parsed = JSON.parse(result);
          return parsed.reply || parsed.text || parsed.message || parsed.output || JSON.stringify(parsed).slice(0, 2000);
        } catch {
          return result.slice(0, 2000);
        }
      } catch (err) {
        log.error(`openclaw error: ${err.message}`);
        return `Backend error: ${err.message.slice(0, 300)}`;
      }
    }

    // ── Utility ──
    case "get_time": {
      return new Date().toLocaleString("en-US", {
        timeZone: "America/New_York",
        weekday: "long", year: "numeric", month: "long", day: "numeric",
        hour: "numeric", minute: "2-digit",
      });
    }

    default:
      return `Unknown tool: ${name}`;
  }
}
