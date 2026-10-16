const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
const MODEL = 'typesafe/jev-1.13';
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 15_000];

function finiteProbability(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function transientStatus(status) {
  return status === 408 || status === 429 || status === 499 || status >= 500;
}

function transientError(error) {
  return error?.name === 'AbortError' || error?.name === 'TimeoutError'
    || /fetch failed|network|socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|aborted|timed? ?out/i.test(String(error?.message ?? ''));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateOptions(options) {
  if (!Array.isArray(options) || options.length < 2) throw new TypeError('decide requires at least two options');
  const ids = new Set();
  return options.map((option) => {
    if (!option || typeof option.id !== 'string' || !option.id.trim()) throw new TypeError('each option requires a non-empty id');
    if (typeof option.label !== 'string' || !option.label.trim()) throw new TypeError(`option ${option.id} requires a non-empty label`);
    if (ids.has(option.id)) throw new TypeError(`duplicate option id: ${option.id}`);
    ids.add(option.id);
    return { id: option.id, label: option.label };
  });
}

async function postDecision(request, apiKey) {
  let response;
  let body;
  for (let attempt = 0; ; attempt += 1) {
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(20_000),
      });
      body = await response.json().catch(() => undefined);
    } catch (error) {
      if (!transientError(error) || attempt >= RETRY_DELAYS_MS.length) throw new Error(`Jev request failed: ${error?.message ?? error}`, { cause: error });
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }

    if (!transientStatus(response.status) || attempt >= RETRY_DELAYS_MS.length) break;
    const retryAfter = Number(response.headers.get('retry-after'));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1_000, 60_000)
      : RETRY_DELAYS_MS[attempt]);
  }

  if (!response.ok) {
    const detail = typeof body?.error?.message === 'string' ? body.error.message : `HTTP ${response.status}`;
    throw new Error(`Jev request failed: ${detail}`);
  }
  return body;
}

/**
 * Make one bounded probabilistic choice with Jev.
 *
 * @param {{question:string, context:unknown, options:{id:string,label:string}[], threshold?:number}} input
 * @returns {Promise<{choice:string, probs:Record<string,number>, confident:boolean}>}
 */
export async function decide({ question, context, options, threshold = 0.6 }) {
  if (typeof question !== 'string' || !question.trim()) throw new TypeError('decide requires a non-empty question');
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new RangeError('threshold must be between 0 and 1');
  const choices = validateOptions(options);
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('missing OPENROUTER_API_KEY');

  const criteria = Object.fromEntries(choices.map(({ id, label }) => [id, `The option "${label}".`]));
  const body = await postDecision({
    model: MODEL,
    state: { context },
    questions: {
      choice: {
        type: 'choice',
        instructions: question,
        criteria,
      },
    },
  }, apiKey);

  const answer = body?.answers?.choice;
  if (!answer || answer.type !== 'choice' || typeof answer.choice !== 'string') {
    throw new Error('Jev response did not contain a choice');
  }
  if (!Object.hasOwn(criteria, answer.choice)) throw new Error('Jev selected an unknown option');

  const probs = Object.fromEntries(choices.map(({ id }) => [id, finiteProbability(answer.probabilities?.[id])]));
  return {
    choice: answer.choice,
    probs,
    confident: probs[answer.choice] >= threshold,
  };
}
