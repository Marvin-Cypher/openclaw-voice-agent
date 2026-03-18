import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { WebSocket } from "ws";
import { config } from "./config.js";
import { RICO_SYSTEM_PROMPT } from "./personality.js";
import { TOOLS, handleFunctionCall } from "./tools.js";
import { loadMemoryContext } from "./memory.js";

const app = Fastify({ logger: true });
await app.register(fastifyWebsocket);

// Parse application/x-www-form-urlencoded (Twilio sends this)
app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (req, body, done) => {
  const params = Object.fromEntries(new URLSearchParams(body));
  done(null, params);
});

// ── Health check ──────────────────────────────────────────────────────
app.get("/health", async () => ({ status: "ok", agent: "rico-voice" }));

// ── Twilio webhook: returns TwiML to connect caller to media stream ──
app.all("/voice/webhook", async (req, reply) => {
  const from = req.body?.From || req.query?.From || "";
  app.log.info(`Incoming call from ${from}`);

  // Allowlist check
  if (config.allowedCallers.length > 0 && !config.allowedCallers.includes(from)) {
    app.log.warn(`Rejected call from ${from} (not in allowlist)`);
    reply.type("text/xml").send(`
      <Response>
        <Say>Sorry, this number is not authorized.</Say>
        <Hangup/>
      </Response>
    `);
    return;
  }

  const streamUrl = config.publicUrl.replace("/voice/webhook", "/voice/stream");
  // Use wss:// for the WebSocket URL
  const wsUrl = streamUrl.replace(/^https?:\/\//, "wss://");

  reply.type("text/xml").send(`
    <Response>
      <Connect>
        <Stream url="${wsUrl}">
          <Parameter name="callerNumber" value="${from}" />
        </Stream>
      </Connect>
    </Response>
  `);
});

// ── Active calls tracking ─────────────────────────────────────────────
const activeCalls = new Map();

// ── WebSocket: Twilio Media Stream ↔ OpenAI Realtime API ─────────────
app.register(async (fastify) => {
  fastify.get("/voice/stream", { websocket: true }, (socket, req) => {
    app.log.info("Twilio media stream connected");

    let streamSid = null;
    let callSid = null;
    let callerNumber = "";
    let openaiWs = null;
    let sessionReady = false;
    const pendingAudio = [];

    // ── Connect to OpenAI Realtime API ──
    function connectOpenAI() {
      const url = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";
      const ws = new WebSocket(url, {
        headers: {
          "Authorization": `Bearer ${config.openaiApiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      ws.on("open", async () => {
        app.log.info("OpenAI Realtime WebSocket connected");

        // Load memory context for this caller
        let memoryContext = "";
        try {
          memoryContext = await loadMemoryContext(callerNumber);
        } catch (err) {
          app.log.warn(`Failed to load memory: ${err.message}`);
        }

        // Configure the session
        const sessionConfig = {
          type: "session.update",
          session: {
            instructions: RICO_SYSTEM_PROMPT + (memoryContext ? `\n\n## Recent Memory\n${memoryContext}` : ""),
            voice: "alloy",  // nova not available in Realtime API; alloy is closest
            input_audio_format: "g711_ulaw",
            output_audio_format: "g711_ulaw",
            input_audio_transcription: {
              model: "whisper-1",
            },
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
            },
            tools: TOOLS,
            tool_choice: "auto",
            temperature: 0.7,
            max_response_output_tokens: 500,
          },
        };

        // Composio tools are handled server-side as function tools
        // (MCP passthrough doesn't work reliably with Realtime API)

        ws.send(JSON.stringify(sessionConfig));
        app.log.info("Session configured with Rico personality + tools");
      });

      ws.on("message", (data) => {
        const event = JSON.parse(data.toString());
        handleOpenAIEvent(event);
      });

      ws.on("error", (err) => {
        app.log.error(`OpenAI WS error: ${err.message}`);
      });

      ws.on("close", (code, reason) => {
        app.log.info(`OpenAI WS closed: ${code} ${reason}`);
        openaiWs = null;
        sessionReady = false;
      });

      return ws;
    }

    // ── Handle events from OpenAI Realtime ──
    function handleOpenAIEvent(event) {
      switch (event.type) {
        case "session.created":
          app.log.info("OpenAI session created");
          break;

        case "session.updated":
          app.log.info("OpenAI session updated — ready");
          sessionReady = true;
          // Flush any buffered audio
          for (const chunk of pendingAudio) {
            sendAudioToOpenAI(chunk);
          }
          pendingAudio.length = 0;
          // Send initial greeting
          sendResponseCreate("Greet the caller briefly. Say something like 'Hey, this is Rico. What's up?'");
          break;

        case "response.audio.delta":
          // Stream audio back to Twilio
          if (streamSid && event.delta) {
            socket.send(JSON.stringify({
              event: "media",
              streamSid,
              media: {
                payload: event.delta, // Already base64 g711_ulaw
              },
            }));
          }
          break;

        case "response.audio.done":
          // Audio response complete
          break;

        case "response.audio_transcript.delta":
          // Assistant speech transcript (streaming)
          break;

        case "response.audio_transcript.done":
          if (event.transcript) {
            app.log.info(`Rico said: "${event.transcript}"`);
          }
          break;

        case "conversation.item.input_audio_transcription.completed":
          if (event.transcript) {
            app.log.info(`Caller said: "${event.transcript}"`);
          }
          break;

        case "response.function_call_arguments.done": {
          // A tool was called — execute it
          const { call_id, name, arguments: args } = event;
          app.log.info(`Tool call: ${name}(${args})`);

          // Execute async so voice doesn't block
          handleFunctionCall(name, args, app.log)
            .then((result) => {
              // Send result back to OpenAI
              if (openaiWs?.readyState === WebSocket.OPEN) {
                openaiWs.send(JSON.stringify({
                  type: "conversation.item.create",
                  item: {
                    type: "function_call_output",
                    call_id,
                    output: typeof result === "string" ? result : JSON.stringify(result),
                  },
                }));
                // Tell the model to respond with the tool result
                openaiWs.send(JSON.stringify({ type: "response.create" }));
              }
            })
            .catch((err) => {
              app.log.error(`Tool ${name} error: ${err.message}`);
              if (openaiWs?.readyState === WebSocket.OPEN) {
                openaiWs.send(JSON.stringify({
                  type: "conversation.item.create",
                  item: {
                    type: "function_call_output",
                    call_id,
                    output: JSON.stringify({ error: err.message }),
                  },
                }));
                openaiWs.send(JSON.stringify({ type: "response.create" }));
              }
            });
          break;
        }

        case "response.done":
          if (event.response?.status === "failed") {
            app.log.error(`Response failed: ${JSON.stringify(event.response.status_details)}`);
          }
          break;

        case "input_audio_buffer.speech_started":
          // User started speaking — interrupt any current response
          app.log.info("Caller speaking (interruption)");
          // Clear Twilio's audio buffer for instant interruption
          if (streamSid) {
            socket.send(JSON.stringify({
              event: "clear",
              streamSid,
            }));
          }
          break;

        case "error":
          app.log.error(`OpenAI error: ${JSON.stringify(event.error)}`);
          break;

        case "mcp_list_tools.completed":
          app.log.info(`MCP tools discovered: ${JSON.stringify(event.tools?.map(t => t.name) || [])}`);
          break;

        case "mcp_list_tools.failed":
          app.log.error(`MCP tool discovery failed: ${JSON.stringify(event)}`);
          break;

        case "response.mcp_call.in_progress":
          app.log.info(`MCP call in progress: ${event.name || "unknown"}`);
          break;

        case "response.mcp_call.completed":
          app.log.info(`MCP call completed: ${event.name || "unknown"}`);
          break;

        case "response.mcp_call.failed":
          app.log.error(`MCP call failed: ${JSON.stringify(event)}`);
          break;

        default:
          // Log unhandled events at debug level for troubleshooting
          if (event.type?.startsWith("mcp")) {
            app.log.info(`MCP event: ${event.type} ${JSON.stringify(event).slice(0, 200)}`);
          }
          break;
      }
    }

    // ── Send audio chunk to OpenAI ──
    function sendAudioToOpenAI(payload) {
      if (openaiWs?.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: payload, // base64 g711_ulaw from Twilio
        }));
      }
    }

    // ── Request a model response with optional instruction ──
    function sendResponseCreate(instructions) {
      if (openaiWs?.readyState === WebSocket.OPEN) {
        const msg = { type: "response.create" };
        if (instructions) {
          msg.response = { instructions };
        }
        openaiWs.send(JSON.stringify(msg));
      }
    }

    // ── Handle messages from Twilio ──
    socket.on("message", (message) => {
      const msg = JSON.parse(message.toString());

      switch (msg.event) {
        case "start":
          streamSid = msg.start.streamSid;
          callSid = msg.start.callSid;
          callerNumber = msg.start.customParameters?.callerNumber || "";
          app.log.info(`Stream started: ${streamSid} call=${callSid} from=${callerNumber}`);

          activeCalls.set(callSid, { streamSid, callerNumber, startedAt: Date.now() });

          // Connect to OpenAI
          openaiWs = connectOpenAI();
          break;

        case "media":
          // Forward audio to OpenAI
          if (sessionReady) {
            sendAudioToOpenAI(msg.media.payload);
          } else {
            // Buffer until session is ready
            pendingAudio.push(msg.media.payload);
            // Cap buffer to avoid memory issues
            if (pendingAudio.length > 100) pendingAudio.shift();
          }
          break;

        case "stop":
          app.log.info(`Stream stopped: ${streamSid}`);
          if (openaiWs) {
            openaiWs.close();
            openaiWs = null;
          }
          activeCalls.delete(callSid);
          break;

        case "mark":
          // Twilio mark events (for tracking playback)
          break;

        default:
          break;
      }
    });

    socket.on("close", () => {
      app.log.info(`Twilio WS closed for ${streamSid}`);
      if (openaiWs) {
        openaiWs.close();
        openaiWs = null;
      }
      if (callSid) activeCalls.delete(callSid);
    });

    socket.on("error", (err) => {
      app.log.error(`Twilio WS error: ${err.message}`);
    });
  });
});

// ── Start server ──────────────────────────────────────────────────────
const port = config.port;
app.listen({ port, host: "0.0.0.0" }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`Rico voice agent listening on port ${port}`);
  app.log.info(`Webhook: ${config.publicUrl}`);
  app.log.info(`Composio MCP: ${config.composioMcpUrl ? "enabled" : "disabled"}`);
});
