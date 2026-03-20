import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
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

// ── OpenClaw Gateway RPC (direct WS, bypasses CLI) ─────────────────────

const GW_URL = "ws://127.0.0.1:18789";
function loadGatewayToken() {
  try {
    const cfg = JSON.parse(readFileSync("/root/.openclaw/openclaw.json", "utf-8"));
    return cfg.gateway?.auth?.token || null;
  } catch {
    return null;
  }
}

function gatewayAgentCall(agentId, message, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const gatewayToken = loadGatewayToken();
    const ws = new WebSocket(GW_URL, { maxPayload: 25 * 1024 * 1024 });
    let settled = false;
    let connectId = null;
    let agentReqId = null;

    const done = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (err) reject(err); else resolve(result);
    };
    const timer = setTimeout(() => done(new Error("gateway timeout")), timeoutMs);

    ws.on("error", (e) => done(e));
    ws.on("close", () => { if (!settled) done(new Error("gateway closed")); });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        // Step 1: Challenge → send connect with token auth
        if (msg.type === "event" && msg.event === "connect.challenge") {
          connectId = randomUUID();
          ws.send(JSON.stringify({
            type: "req",
            id: connectId,
            method: "connect",
            params: {
              minProtocol: 3,
              maxProtocol: 3,
              client: {
                id: "gateway-client",
                version: "1.0.0",
                platform: "linux",
                mode: "backend"
              },
              caps: [],
              auth: gatewayToken ? { token: gatewayToken } : undefined,
              role: "operator",
              scopes: ["operator.admin"]
            }
          }));
          return;
        }

        // Step 2: Connect response (hello) → send agent request
        if (msg.type === "res" && msg.id === connectId && msg.ok) {
          agentReqId = randomUUID();
          ws.send(JSON.stringify({
            type: "req",
            id: agentReqId,
            method: "agent",
            params: {
              agentId,
              message,
              idempotencyKey: randomUUID(),
              timeout: Math.floor(timeoutMs / 1000),
            }
          }));
          return;
        }

        // Step 3: Agent response (may come as accepted first, then final)
        if (msg.type === "res" && msg.id === agentReqId) {
          if (msg.ok) {
            const payload = msg.payload;
            if (payload?.status === "accepted") return; // wait for final
            done(null, payload);
          } else {
            done(new Error(msg.error?.message || "agent error"));
          }
          return;
        }

        // Agent result can also arrive as an event
        if (msg.type === "event" && msg.event === "agent.done") {
          done(null, msg.payload);
          return;
        }

        // Handle connect error
        if (msg.type === "res" && msg.id === connectId && !msg.ok) {
          done(new Error(msg.error?.message || "connect failed"));
          return;
        }
      } catch (e) {
        done(e);
      }
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
      // Model may pass args inside "arguments" object or at top level
      const toolArgs = args.arguments || (() => {
        const { tool_slug, ...rest } = args;
        return Object.keys(rest).length > 0 ? rest : {};
      })();

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

    // ── LAYER 2: OpenClaw backend (direct gateway WS RPC) ──
    case "openclaw": {
      const task = args.task;
      if (!task) return "No task provided.";

      log.info(`OpenClaw backend: ${task}`);

      try {
        const result = await gatewayAgentCall("main", task, 30000);
        log.info(`OpenClaw result: ${JSON.stringify(result).slice(0, 300)}`);

        // Extract the reply text from the agent response
        if (result?.payloads) {
          return result.payloads.map((p) => p.text).filter(Boolean).join("\n") || JSON.stringify(result).slice(0, 2000);
        }
        if (typeof result === "string") return result.slice(0, 2000);
        return JSON.stringify(result).slice(0, 2000);
      } catch (err) {
        log.error(`openclaw error: ${err.message}`);
        return `Backend error: ${err.message}`;
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
