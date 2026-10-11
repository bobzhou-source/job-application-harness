// Decisions backend transport: config access, the API key, and one metered, retried Decisions POST
// with response parsing (unknown answer types dropped, never guessed).

import * as runlog from "../trace.mjs";
import { loadConfig, requireSecret } from "../config.mjs";

// Driver settings come from the ignored config.json (backend openrouter-decisions); the loader caches and freezes it.
let configCache;
export function config() {
  return (configCache ??= loadConfig());
}
export function driver() {
  return config().models.driver;
}

// ---------------------------------------------------------------------------
// The driver's key comes from the environment variable the config names
// (.env); nothing is read from a credential database, and it is never logged.
// ---------------------------------------------------------------------------

function openRouterKey() {
  return requireSecret(driver().apiKeyEnv);
}

// ---------------------------------------------------------------------------
// One Decisions POST. Response parsing mirrors legacy liveJevDecide: unknown
// answer types (e.g. a future primitive) are dropped, never guessed.
// ---------------------------------------------------------------------------

export function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// Rate limits (429) and transient server errors (5xx) are retried with backoff, honoring Retry-After,
// for up to ~2 minutes; every attempt is metered so telemetry shows the retries.
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 15_000, 30_000, 60_000];

export async function decide(request, purpose = "drive") {
  let response;
  let body;
  for (let attempt = 0; ; attempt += 1) {
    const started = Date.now();
    try {
      response = await fetch(driver().endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${await openRouterKey()}`, "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(15_000),
      });
      body = await response.json().catch(() => undefined);
    } catch (error) {
      runlog.meter("jev", { purpose, ms: Date.now() - started, ok: false });
      throw error;
    }
    const usage = typeof body === "object" && body !== null && typeof body.usage === "object" && body.usage !== null ? body.usage : {};
    runlog.meter("jev", {
      purpose, ms: Date.now() - started, ok: response.ok, cost: num(usage.cost),
      input: num(usage.prompt_tokens ?? usage.input_tokens), output: num(usage.completion_tokens ?? usage.output_tokens),
    });
    const transient = response.status === 429 || response.status >= 500;
    if (!transient || attempt >= RETRY_DELAYS_MS.length) break;
    const retryAfter = Number(response.headers.get("retry-after"));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 60_000) : RETRY_DELAYS_MS[attempt];
    const line = `JEV RETRY HTTP ${response.status} in ${Math.round(wait / 1000)}s (${attempt + 1}/${RETRY_DELAYS_MS.length})`;
    console.log(line);
    runlog.trace("log", { line });
    await Bun.sleep(wait);
  }
  if (!response.ok || typeof body !== "object" || body === null || !("answers" in body) || typeof body.answers !== "object" || body.answers === null) {
    const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "object" && body.error !== null
      && "message" in body.error && typeof body.error.message === "string" ? body.error.message : `HTTP ${response.status}`;
    throw new Error(`jev decisions failed: ${message}`);
  }
  const answers = {};
  for (const [key, value] of Object.entries(body.answers)) {
    if (typeof value !== "object" || value === null || !("type" in value)) continue;
    if (value.type === "noul" && "noul" in value && typeof value.noul === "number") answers[key] = { type: "noul", noul: value.noul };
    if (value.type === "choice" && "choice" in value && typeof value.choice === "string") {
      answers[key] = {
        type: "choice",
        choice: value.choice,
        confidence: "confidence" in value ? num(value.confidence) : 0,
        probabilities: "probabilities" in value && typeof value.probabilities === "object" && value.probabilities !== null
          ? Object.fromEntries(Object.entries(value.probabilities).map(([option, p]) => [option, num(p)]))
          : {},
      };
    }
  }
  const cost = "usage" in body && typeof body.usage === "object" && body.usage !== null && "cost" in body.usage ? num(body.usage.cost) : 0;
  return { answers, cost };
}
