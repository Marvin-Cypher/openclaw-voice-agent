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

## Features

### Three-Tier Tool System

1. **Tier 1 — Composio** (connected apps): Routes natural language to Gmail, Google Calendar, Drive, Sheets, Slack, LinkedIn, Notion, YouTube via [Composio](https://composio.dev)
2. **Tier 2 — Hardcoded Tools** (fast metrics): Direct script execution for portfolio, market data, platform metrics, cron status
3. **Tier 3 — OpenClaw Backend** (100+ skills): Full agent delegation via `openclaw agent` CLI for anything not covered above

### Productivity Apps (Tier 1 — Composio)

Connect your apps through Composio and talk to them naturally:

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

### Platform Metrics (Tier 2)

| Tool | What It Covers |
|------|---------------|
| **Clawdi Metrics** | Total users, plan breakdown, active users, usage by model, deployments |
| **Phala Cloud + RedPill** | Active CVMs, signups, RedPill requests, MRR, top models |
| **Short Scanner** | Stock short positions, P&L, exposure |
| **Stock Quotes** | Real-time price for any ticker |
| **Crypto Portfolio** | Live holdings with CoinGecko prices |
| **Cron Status** | Scheduled task health |

### OpenClaw Backend (Tier 3)

Anything the voice agent can't handle directly gets delegated to the full OpenClaw agent — 100+ skills, web search, browser automation, file operations, and more.

## Architecture

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
                                          ┌────────────┼────────────┐
                                          │            │            │
                                   ┌──────▼──┐  ┌─────▼────┐ ┌────▼─────┐
                                   │Composio │  │Hardcoded │ │ OpenClaw │
                                   │  MCP    │  │  Tools   │ │ Backend  │
                                   │ 8 apps  │  │ 7 tools  │ │100+ skills│
                                   └─────────┘  └──────────┘ └──────────┘
```

### Key Technical Details

- **Audio**: G711 µ-law passthrough (Twilio native format, no conversion)
- **Latency**: Sub-second response (no transcription pipeline)
- **Interruption**: Caller can interrupt mid-sentence — audio buffer clears instantly
- **Memory**: Loads conversation context from OpenClaw's memory store at call start
- **VAD**: Server-side voice activity detection with 500ms silence threshold
- **Concurrent**: Each call gets its own OpenAI Realtime session

## Prerequisites

- A [Clawdi](https://clawdi.ai) CVM (or any OpenClaw instance)
- [OpenAI API key](https://platform.openai.com/) with Realtime API access
- [Twilio account](https://www.twilio.com/) with a phone number
- (Optional) [Composio account](https://composio.dev/) with connected apps

## Installation

### On your Clawdi CVM

```bash
# SSH into your CVM
phala ssh <your-cvm-name>

# Inside the container
docker exec -it openclaw bash

# Clone the repo
cd /data
git clone https://github.com/Marvin-Cypher/openclaw-voice-agent.git voice-agent

# Copy to runtime directory and install
mkdir -p /root/voice-agent
cp -r /data/voice-agent/* /root/voice-agent/
cd /root/voice-agent
npm install

# Configure
cp .env.example .env
# Edit .env with your credentials
vi .env

# Start
node server.js
```

### Twilio Setup

1. Go to your [Twilio Console](https://console.twilio.com/)
2. Navigate to **Phone Numbers** → your number → **Voice Configuration**
3. Set **"A call comes in"** webhook to:
   ```
   https://<your-cvm-url>-19000.dstack-pha-prod3.phala.network/voice/webhook
   ```
   Method: **POST**

### Composio Setup (Optional)

1. Create an account at [composio.dev](https://composio.dev)
2. Connect your apps (Gmail, Calendar, Slack, etc.)
3. Create a Tool Router and copy the MCP URL + API key to your `.env`

### Auto-Start on Reboot

Add this to your CVM's `post-boot.sh`:

```bash
# ── Step: Voice agent ──
echo "Starting voice agent..."
mkdir -p /root/voice-agent
cp -r /data/voice-agent/* /root/voice-agent/
cd /root/voice-agent && npm install --omit=dev 2>/dev/null
nohup node server.js > /tmp/voice-agent.log 2>&1 &
echo "Voice agent started on port ${PORT:-19000}"
```

## Customization

### Personality

Edit `personality.js` to change the agent's name, tone, and behavior. The default is a casual, witty assistant — modify the system prompt to match your style.

### Tools

Edit `tools.js` to add/remove/modify tools:

- **Tier 1 (Composio)**: Automatic — just connect more apps in Composio
- **Tier 2 (Hardcoded)**: Add new tool definitions to `TOOLS` array and handlers in `handleFunctionCall`
- **Tier 3 (OpenClaw)**: Automatic — any installed OpenClaw skill is accessible via `ask_rico`

### Caller Allowlist

Set `ALLOWED_CALLERS` in `.env` to restrict who can call:

```bash
# Single number
ALLOWED_CALLERS=+14155551234

# Multiple numbers
ALLOWED_CALLERS=+14155551234,+14155555678

# Allow anyone (leave empty)
ALLOWED_CALLERS=
```

## File Structure

```
├── server.js        # Fastify server, Twilio↔OpenAI bridge
├── tools.js         # 3-tier tool system (Composio, hardcoded, OpenClaw)
├── personality.js   # Agent system prompt and voice personality
├── memory.js        # Memory context loader (SQLite + flat files)
├── config.js        # Configuration from .env
├── package.json     # Dependencies
├── .env.example     # Template for environment variables
└── README.md        # This file
```

## License

MIT

---

Built with [OpenAI Realtime API](https://platform.openai.com/docs/guides/realtime), [Twilio Media Streams](https://www.twilio.com/docs/voice/media-streams), [Composio](https://composio.dev), and [OpenClaw](https://github.com/openclaw/openclaw).
