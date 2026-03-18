import "dotenv/config";

export const config = {
  // OpenAI
  openaiApiKey: process.env.OPENAI_API_KEY,

  // Twilio
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
  twilioPhoneNumber: process.env.TWILIO_PHONE_NUMBER,

  // Composio MCP
  composioMcpUrl: process.env.COMPOSIO_MCP_URL || "",
  composioApiKey: process.env.COMPOSIO_API_KEY || "",

  // Server
  port: parseInt(process.env.PORT || "19000", 10),
  publicUrl: process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 19000}/voice/webhook`,

  // Inbound caller allowlist (comma-separated, empty = open)
  allowedCallers: (process.env.ALLOWED_CALLERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // OpenClaw integration
  openclawSkillsDir: process.env.OPENCLAW_SKILLS_DIR || "/root/.openclaw/skills",
  openclawMemoryDb: process.env.OPENCLAW_MEMORY_DB || "/data/openclaw/memory/main.sqlite",
};
