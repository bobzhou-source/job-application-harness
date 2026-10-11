// lib/setup/dotenv.mjs — .env parsing plus legacy API-key migration into .env.

import { chmod, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./paths.mjs";
import { isReadable } from "./fsutil.mjs";

const LEGACY_KEYS = [
  { envName: "OPENROUTER_API_KEY", provider: "openrouter" },
  { envName: "DEEPSEEK_API_KEY", provider: "deepseek" },
];

function parseDotenvValue(raw) {
  const value = raw.trim();
  if (!value) return "";
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "string" ? parsed.trim() : "";
    } catch {
      return value.slice(1, -1).trim();
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).trim();
  }
  return value.replace(/\s+#.*$/, "").trim();
}

function readDotenvEntries(text) {
  const entries = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (match) entries.set(match[1], parseDotenvValue(match[2]));
  }
  return entries;
}

function setDotenvEntry(text, name, value) {
  const assignment = `${name}=${JSON.stringify(value)}`;
  const matcher = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => matcher.test(line));
  if (index >= 0) lines[index] = assignment;
  else {
    if (lines.length && lines.at(-1) !== "") lines.push("");
    lines.push(assignment);
  }
  const result = lines.join("\n");
  return result.endsWith("\n") ? result : `${result}\n`;
}

async function queryLegacyKey(provider) {
  const database = join(homedir(), ".omp", "agent", "agent.db");
  if (!(await isReadable(database))) return "";

  const sql = `select json_extract(data, '$.key') from auth_credentials where provider = '${provider}' and credential_type = 'api_key' limit 1`;
  try {
    const proc = Bun.spawn(["sqlite3", database, sql], {
      cwd: ROOT,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const [exitCode, output] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
    ]);
    return exitCode === 0 ? output.trim() : "";
  } catch {
    return "";
  }
}

export async function migrateLegacyKeys() {
  const envPath = join(ROOT, ".env");
  let text = await readFile(envPath, "utf8");
  let entries = readDotenvEntries(text);
  const missing = [];

  for (const { envName, provider } of LEGACY_KEYS) {
    if (entries.get(envName)?.trim()) {
      console.log(`[OK] ${envName} is present in .env`);
      continue;
    }

    const value = process.env[envName]?.trim() || await queryLegacyKey(provider);
    if (!value) {
      console.error(`[ERROR] Missing ${envName}. Add it to .env (see .env.example).`);
      missing.push(envName);
      continue;
    }

    text = setDotenvEntry(text, envName, value);
    entries = readDotenvEntries(text);
    process.env[envName] = value;
    console.log(`[OK] Migrated ${envName} into .env`);
  }

  await writeFile(envPath, text, { encoding: "utf8", mode: 0o600 });
  await chmod(envPath, 0o600);
  console.log("[OK] .env permissions are 0600");
  return missing;
}
