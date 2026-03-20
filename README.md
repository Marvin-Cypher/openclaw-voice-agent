# OpenClaw Voice Agent

A real-time voice AI agent for [Clawdi](https://clawdi.ai) / OpenClaw users. Talk to your AI agent over the phone with natural, low-latency speech-to-speech conversation powered by OpenAI's Realtime API and Twilio.

No waterfall transcription pipeline, no awkward pauses — speech goes in, speech comes out.

## How It Works

```
Caller dials in
  → Twilio receives call, opens audio stream
  → Voice agent bridges audio to OpenAI Realtime API
  → Speech-to-speech processing (no STT→LLM→TTS waterfall)
  → Agent responds naturally in real-time
  → Tools execute in background without blocking conversation
```

## Two-Layer Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│   Caller     │────▶│  Twilio          │────▶│  Voice Agent        │
│   Phone      │◀────│  Media Streams   │◀────│  (Fastify + WS)     │
└─────────────┘     └──────────────────┘     └─────────┬───────────┘
                         g711 µ-law                     │
                         bidirectional                  │
                                              ┌────────▼────────┐
                                              │ OpenAI Realtime  │
                                              │ API (gpt-4o)     │
                                              │ Speech-to-Speech │
                                              └────────┬────────┘
                                                       │
                                              ┌────────┼────────┐
                                              │                 │
                                       ┌──────▼──┐       ┌─────▼──────┐
                                       │Composio │       │  OpenClaw  │
                                       │Workbench│       │  Gateway   │
                                       │ 8+ apps │       │ 100+ skills│
                                       └─────────┘       └────────────┘
```

### Layer 1 — Composio Workbench (Connected Apps)

The voice model calls `search_tools` to find the right tool and read its parameter schema, then calls `execute_tool` with the correct arguments. No hardcoded arg-building — the model reads Composio's execution guidance and builds params itself.

| App | Examples |
|-----|---------|
| **Gmail** | "Check my latest emails", "Send an email to team about the report" |
| **Google Calendar** | "What's my next meeting?", "Schedule a meeting with John tomorrow at 3pm" |
| **Google Drive** | "Find my recent documents" |
| **Google Sheets** | "Check the data in my tracking sheet" |
| **Slack** | "Any new messages?", "Post an update to general" |
| **LinkedIn** | "Check my profile info" |
| **Notion** | "Find my recent pages" |
| **YouTube** | "Search for videos about AI agents" |

### Layer 2 — OpenClaw Gateway (Skills + Exec)

Everything else routes to the OpenClaw agent via direct WebSocket RPC to the gateway. The agent has access to all installed skills, web search, CLI execution, and more. No hardcoding — any question goes through the same generic pipeline.

Examples:
- "How many Clawdi users?" → runs Clawdi admin skill
- "RedPill metrics for last 7 days" → runs phala-redpill-metrics skill
- "Check my crypto portfolio" → runs portfolio-watch skill
- "Search the web for latest PHA news" → runs web search
- Any other question → OpenClaw figures out which skill to use

## Setup Guide

### Prerequisites

| Requirement | Where to get it |
|-------------|----------------|
| **Clawdi CVM** | [clawdi.ai](https://clawdi.ai) — sign up and deploy a CVM |
| **OpenAI API key** | [platform.openai.com](https://platform.openai.com/) — needs Realtime API access |
| **Twilio account** | [twilio.com](https://www.twilio.com/) — need a phone number with Voice enabled |
| **Composio account** (optional) | [composio.dev](https://composio.dev/) — for Gmail, Calendar, Slack, etc. |

### Step 1: Expose Port 19000 on Your CVM

The voice agent runs on port 19000. Your CVM's docker-compose needs this port exposed.

SSH into your CVM host and edit the docker-compose:

```bash
phala ssh <your-cvm-name>

# Edit docker-compose to add port 19000
vi /dstack/docker-compose.yaml
```

Add `19000:19000` to the ports section:

```yaml
ports:
  - "18789:18789"
  - "19000:19000"   # ← add this line
  - "1022:22"
```

Then recreate the container:

```bash
cd /dstack && docker compose up -d
```

### Step 2: Install the Voice Agent

```bash
# SSH into your CVM
phala ssh <your-cvm-name>

# Enter the OpenClaw container
docker exec -it openclaw bash

# Clone to persistent storage
cd /data
git clone https://github.com/Marvin-Cypher/openclaw-voice-agent.git voice-agent

# Copy to runtime directory and install deps
mkdir -p /root/voice-agent
cp -r /data/voice-agent/* /root/voice-agent/
cd /root/voice-agent
npm install
```

### Step 3: Configure Environment

```bash
cd /root/voice-agent
cp .env.example .env
vi .env
```

Fill in your credentials:

```bash
# Required
OPENAI_API_KEY=sk-proj-...          # Your OpenAI key (needs Realtime API)
TWILIO_ACCOUNT_SID=AC...            # From Twilio Console
TWILIO_AUTH_TOKEN=...               # From Twilio Console
TWILIO_PHONE_NUMBER=+1...           # Your Twilio phone number

# Required — your CVM's public URL
# Find it: your CVM app_id + port 19000
PUBLIC_URL=https://<app-id>-19000.dstack-pha-prod3.phala.network/voice/webhook

# Optional — restrict who can call (empty = anyone can call)
ALLOWED_CALLERS=+14155551234

# Optional — Composio for Gmail, Calendar, Slack, etc.
COMPOSIO_MCP_URL=https://backend.composio.dev/tool_router/trs_XXXXX/mcp
COMPOSIO_API_KEY=ak_...
```

**How to find your CVM's public URL:**
```bash
# From your local machine
phala cvms list
# Find your CVM's APP_ID, then your URL is:
# https://<APP_ID>-19000.dstack-pha-prod3.phala.network/voice/webhook
```

### Step 4: Configure Twilio

1. Go to [Twilio Console](https://console.twilio.com/)
2. Navigate to **Phone Numbers** → your number → **Voice Configuration**
3. Under **"A call comes in"**, set:
   - **URL**: `https://<APP_ID>-19000.dstack-pha-prod3.phala.network/voice/webhook`
   - **Method**: POST

### Step 5: Start the Voice Agent

```bash
cd /root/voice-agent
node server.js
```

Test it by calling your Twilio phone number. You should hear "Hey, this is Rico. What's up?"

To run in the background:

```bash
nohup node server.js > /tmp/voice-agent.log 2>&1 &
```

### Step 6: Set Up Composio (Optional)

Skip this if you only need the OpenClaw backend (Layer 2).

1. Create an account at [composio.dev](https://composio.dev)
2. Connect your apps (Gmail, Google Calendar, Slack, LinkedIn, etc.)
3. Go to **Tool Router** → create a new router
4. Copy the **MCP URL** and **API Key** to your `.env`

### Step 7: Auto-Start on Reboot

Add this to your CVM's `/data/openclaw/scripts/post-boot.sh`:

```bash
# ── Voice agent ──
echo "Starting voice agent..."
mkdir -p /root/voice-agent
cp -r /data/voice-agent/* /root/voice-agent/
cd /root/voice-agent && npm install --omit=dev 2>/dev/null
nohup node server.js > /tmp/voice-agent.log 2>&1 &
echo "Voice agent started on port ${PORT:-19000}"
```

## Customization

### Personality

Edit `personality.js` to change the agent's name, tone, and behavior:

```javascript
// Default: casual, witty assistant named Rico
export const RICO_SYSTEM_PROMPT = `You are Rico, a sharp and capable AI...`
```

Change the name, voice style, and instructions to match your brand.

### Composio Apps

Just connect more apps in your Composio dashboard — the voice agent discovers them automatically via `search_tools`. No code changes needed.

### OpenClaw Skills

Any skill installed on your OpenClaw instance is automatically accessible via the `openclaw` tool. Install new skills through ClawHub or your Clawdi dashboard.

### Caller Allowlist

```bash
# In .env:
ALLOWED_CALLERS=+14155551234,+14155555678   # only these numbers
ALLOWED_CALLERS=                             # anyone can call
```

## File Structure

```
├── server.js        # Fastify server, Twilio ↔ OpenAI Realtime bridge
├── tools.js         # 2-layer tool system (Composio + OpenClaw gateway WS RPC)
├── personality.js   # Agent system prompt and voice personality
├── memory.js        # Memory context loader (SQLite + flat files)
├── config.js        # Configuration from .env
├── package.json     # Dependencies (ws, fastify, dotenv)
├── .env.example     # Template for environment variables
└── README.md
```

## Troubleshooting

### "Rejected call from (not in allowlist)"
Your phone number isn't in `ALLOWED_CALLERS`. Add it or leave the field empty.

### Composio tools fail with "Missing required field"
The voice model reads execution guidance from Composio to build correct args. If it fails, it usually self-corrects on retry. If not, the specific tool's required params may need to be documented in `personality.js`.

### OpenClaw backend times out
Some skills (RedPill metrics, web search) take 20-40 seconds. The default timeout is 60 seconds. If your skills take longer, increase it in `tools.js` (`gatewayAgentCall` timeout parameter).

### Port 19000 not reachable
Make sure port 19000 is exposed in your CVM's docker-compose (see Step 1).

### Voice agent dies on reboot
Add the auto-start script to `post-boot.sh` (see Step 7). Files at `/root/` are ephemeral — the persistent copy at `/data/voice-agent/` gets copied back on boot.

## Technical Details

- **Audio**: G711 µ-law passthrough (Twilio native format, no conversion)
- **Latency**: Sub-second for speech, 3-40s for tool calls depending on skill
- **Interruption**: Caller can interrupt mid-sentence — audio buffer clears instantly
- **Memory**: Loads conversation context from OpenClaw's memory store at call start
- **VAD**: Server-side voice activity detection with 500ms silence threshold
- **Concurrent**: Each call gets its own OpenAI Realtime session
- **Gateway RPC**: Direct WebSocket to OpenClaw gateway (no CLI overhead)

## License

MIT

---

Built with [OpenAI Realtime API](https://platform.openai.com/docs/guides/realtime), [Twilio Media Streams](https://www.twilio.com/docs/voice/media-streams), [Composio](https://composio.dev), and [OpenClaw](https://github.com/openclaw/openclaw).
