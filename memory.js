import { readFileSync, existsSync } from "node:fs";
import { config } from "./config.js";

/**
 * Load memory context from OpenClaw's memory store for a given caller.
 * Falls back to loading the most recent memory entries if caller-specific
 * memory is not found.
 *
 * Returns a string to inject into the system prompt.
 */
export async function loadMemoryContext(callerNumber) {
  const dbPath = config.openclawMemoryDb;

  // If no SQLite DB exists, try loading from flat files
  if (!existsSync(dbPath)) {
    return loadFlatMemory();
  }

  // Use child_process to query SQLite (avoids native module dependency)
  const { execFile } = await import("node:child_process");

  return new Promise((resolve) => {
    // Get recent memory entries (last 20)
    const query = `SELECT key, value, updated_at FROM memory ORDER BY updated_at DESC LIMIT 20;`;

    execFile("sqlite3", ["-json", dbPath, query], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        // sqlite3 might not be installed — fall back to flat files
        resolve(loadFlatMemory());
        return;
      }

      try {
        const rows = JSON.parse(stdout);
        if (!rows.length) {
          resolve(loadFlatMemory());
          return;
        }

        const entries = rows.map((r) => {
          const val = tryParseJson(r.value);
          const summary = typeof val === "string" ? val : JSON.stringify(val).slice(0, 200);
          return `- ${r.key}: ${summary}`;
        });

        resolve(entries.join("\n"));
      } catch {
        resolve(loadFlatMemory());
      }
    });
  });
}

/**
 * Load memory from flat knowledge/memory files as fallback.
 */
function loadFlatMemory() {
  const paths = [
    "/data/openclaw/memory/context.txt",
    "/data/openclaw/memory/summary.txt",
  ];

  const chunks = [];
  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, "utf-8").trim();
        if (content) chunks.push(content);
      } catch {
        // skip
      }
    }
  }

  return chunks.join("\n\n") || "";
}

function tryParseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
