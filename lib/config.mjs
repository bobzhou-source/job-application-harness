import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const CONFIG_PATH = path.join(ROOT, 'config.json');

let cachedConfig;

function fail(field, reason) {
  throw new Error(`Invalid configuration field ${field}: ${reason}.`);
}

function record(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(field, 'expected an object');
  }
  return value;
}

function exactKeys(value, allowed, field) {
  record(value, field);
  const permitted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!permitted.has(key)) fail(`${field}.${key}`, 'unknown field');
  }
  return value;
}

function stringField(value, field, { empty = false } = {}) {
  if (typeof value !== 'string') fail(field, 'expected a string');
  if (!empty && !value.trim()) fail(field, 'must not be empty');
  return value;
}

function booleanField(value, field) {
  if (typeof value !== 'boolean') fail(field, 'expected true or false');
  return value;
}

function integerField(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(field, `expected an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function arrayField(value, field, { empty = false } = {}) {
  if (!Array.isArray(value)) fail(field, 'expected an array');
  if (!empty && value.length === 0) fail(field, 'must not be empty');
  return value;
}

function basenameField(value, field) {
  const name = stringField(value, field);
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    fail(field, 'expected a basename without directory components');
  }
  return name;
}

function regexField(value, field) {
  const source = stringField(value, field, { empty: true });
  try {
    new RegExp(source);
  } catch {
    fail(field, 'invalid regular expression');
  }
  return source;
}

function httpsUrlField(value, field, { handshake = false } = {}) {
  const source = stringField(value, field);
  let url;
  try {
    url = new URL(source);
  } catch {
    fail(field, 'expected a valid HTTPS URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    fail(field, 'expected an HTTPS URL without credentials');
  }
  if (handshake && (url.search || url.hash || (url.pathname !== '/' && url.pathname !== ''))) {
    fail(field, 'expected an origin only, with no path, query string, or fragment');
  }
  return source;
}

function laneNameField(value, field) {
  const name = stringField(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    fail(field, 'use only letters, numbers, dot, underscore, or hyphen');
  }
  return name;
}

function loopbackField(value, field) {
  const host = stringField(value, field).toLowerCase();
  if (host !== 'localhost' && !/^127(?:\.\d{1,3}){3}$/.test(host)
      && host !== '::1' && host !== '0:0:0:0:0:0:0:1') {
    fail(field, 'must be a loopback host');
  }
  if (host.startsWith('127.') && host.split('.').slice(1).some((part) => Number(part) > 255)) {
    fail(field, 'must be a loopback host');
  }
  return value;
}

function monthField(value, field) {
  const month = stringField(value, field);
  if (!['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].includes(month)) {
    fail(field, 'expected a three-letter month name');
  }
  return month;
}

function pathField(value, field) {
  stringField(value, field);
  try {
    return expandConfigPath(value);
  } catch {
    fail(field, 'expected a valid filesystem path');
  }
}

function modelConfig(value, field, { driver = false } = {}) {
  const input = exactKeys(value, ['backend', 'model', 'endpoint', 'apiKeyEnv'], field);
  const backend = stringField(input.backend, `${field}.backend`);
  const allowed = driver
    ? ['openrouter-decisions']
    : ['openai-compatible', 'openrouter', 'omp'];
  if (!allowed.includes(backend)) fail(`${field}.backend`, `expected one of ${allowed.join(', ')}`);

  const output = {
    backend,
    model: stringField(input.model, `${field}.model`),
  };
  if (backend !== 'omp') {
    output.endpoint = httpsUrlField(input.endpoint, `${field}.endpoint`);
    output.apiKeyEnv = stringField(input.apiKeyEnv, `${field}.apiKeyEnv`);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(output.apiKeyEnv)) {
      fail(`${field}.apiKeyEnv`, 'expected an environment variable name');
    }
  } else {
    // omp selects the model only; any endpoint/apiKeyEnv present is validated then dropped so
    // no consumer can accidentally wire an HTTP endpoint to a subscription backend.
    if (input.endpoint !== undefined) httpsUrlField(input.endpoint, `${field}.endpoint`);
    if (input.apiKeyEnv !== undefined) {
      const name = stringField(input.apiKeyEnv, `${field}.apiKeyEnv`);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) fail(`${field}.apiKeyEnv`, 'expected an environment variable name');
    }
  }
  return output;
}

function deeplyFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deeplyFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function expandConfigPath(value) {
  if (typeof value !== 'string' || !value) throw new Error('Config path must be a nonempty string.');
  let expanded = value;
  if (value === '~') expanded = homedir();
  else if (value.startsWith('~/') || value.startsWith('~\\')) expanded = path.join(homedir(), value.slice(2));
  return path.normalize(path.isAbsolute(expanded) ? expanded : path.resolve(ROOT, expanded));
}

export function requireSecret(envName) {
  const name = typeof envName === 'string' ? envName : String(envName ?? '');
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}. Add it to .env (see .env.example).`);
  return value;
}

export function loadConfig() {
  if (cachedConfig) return cachedConfig;

  let source;
  try {
    source = readFileSync(CONFIG_PATH, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Configuration not found at ${CONFIG_PATH}. Run: bun setup.mjs`);
    }
    throw new Error(`Unable to read configuration at ${CONFIG_PATH}.`);
  }

  let raw;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new Error(`Invalid JSON in configuration at ${CONFIG_PATH}.`);
  }

  const input = exactKeys(raw, [
    'browser', 'resumes', 'discovery', 'models', 'applicant', 'email',
    'credentials', 'notifications', 'queue', 'runtime',
  ], 'config');

  const browser = exactKeys(input.browser, ['executable', 'profileDir', 'debugHost', 'debugPort', 'maxTabs'], 'browser');
  const resumes = exactKeys(input.resumes, ['directory', 'filePattern', 'fallbackLane', 'factsFile', 'latexPreamble'], 'resumes');
  const discovery = exactKeys(input.discovery, [
    'handshakeBaseUrl', 'queries', 'includeTitlePattern', 'excludeTitlePattern', 'excludeEmployerPattern',
    'lanes', 'specialLane', 'season', 'sources', 'listings',
  ], 'discovery');
  const models = exactKeys(input.models, ['driver', 'planner', 'fallback', 'writer'], 'models');
  const applicant = exactKeys(input.applicant, [
    'displayName', 'coverLetterHeading', 'relocateAnywhere', 'workInPerson', 'summerAvailability',
  ], 'applicant');
  const email = exactKeys(input.email, [
    'enabled', 'accountLabel', 'mcpServer', 'tokenDatabase', 'oauthCredentials',
  ], 'email');
  const credentials = exactKeys(input.credentials, ['backend', 'servicePrefix'], 'credentials');
  const notifications = exactKeys(input.notifications, ['backend', 'title', 'sound'], 'notifications');
  const queue = exactKeys(input.queue, ['runTimeoutSeconds'], 'queue');
  const runtime = exactKeys(input.runtime, ['debug'], 'runtime');

  const directory = pathField(resumes.directory, 'resumes.directory');
  const filePattern = basenameField(resumes.filePattern, 'resumes.filePattern');
  if (filePattern.split('{lane}').length !== 2) {
    fail('resumes.filePattern', 'must contain {lane} exactly once');
  }
  const factsFile = basenameField(resumes.factsFile, 'resumes.factsFile');
  const latexPreamble = basenameField(resumes.latexPreamble, 'resumes.latexPreamble');

  const queryValues = arrayField(discovery.queries, 'discovery.queries').map((value, index) =>
    stringField(value, `discovery.queries[${index}]`));
  const laneInputs = arrayField(discovery.lanes, 'discovery.lanes');
  const laneNames = new Set();
  const lanes = laneInputs.map((value, index) => {
    const field = `discovery.lanes[${index}]`;
    const lane = exactKeys(value, ['name', 'titlePattern'], field);
    const name = laneNameField(lane.name, `${field}.name`);
    if (laneNames.has(name)) fail(`${field}.name`, 'lane names must be unique');
    laneNames.add(name);
    return { name, titlePattern: regexField(lane.titlePattern, `${field}.titlePattern`) };
  });
  const specialInput = exactKeys(discovery.specialLane, ['name', 'employerPattern'], 'discovery.specialLane');
  const specialLane = {
    name: laneNameField(specialInput.name, 'discovery.specialLane.name'),
    employerPattern: regexField(specialInput.employerPattern, 'discovery.specialLane.employerPattern'),
  };
  const fallbackLane = laneNameField(resumes.fallbackLane, 'resumes.fallbackLane');
  if (!laneNames.has(fallbackLane) && specialLane.name !== fallbackLane) {
    fail('resumes.fallbackLane', 'must name a configured discovery lane');
  }
  const seasonInput = exactKeys(discovery.season, [
    'primaryStartMonths', 'shortTermStartMonth', 'shortTermEndMonths',
  ], 'discovery.season');
  const primaryStartMonths = arrayField(seasonInput.primaryStartMonths, 'discovery.season.primaryStartMonths')
    .map((value, index) => monthField(value, `discovery.season.primaryStartMonths[${index}]`));
  const shortTermEndMonths = arrayField(seasonInput.shortTermEndMonths, 'discovery.season.shortTermEndMonths')
    .map((value, index) => monthField(value, `discovery.season.shortTermEndMonths[${index}]`));
  const sources = discovery.sources === undefined ? ['handshake']
    : arrayField(discovery.sources, 'discovery.sources').map((value, index) => {
      const source = stringField(value, `discovery.sources[${index}]`);
      if (!['handshake', 'listings'].includes(source)) fail(`discovery.sources[${index}]`, 'expected handshake or listings');
      return source;
    });
  const listingsInput = discovery.listings === undefined ? null
    : exactKeys(discovery.listings, ['url', 'terms', 'locationPattern'], 'discovery.listings');
  if (sources.includes('listings') && !listingsInput) fail('discovery.listings', 'is required when discovery.sources includes listings');
  const listings = listingsInput && {
    url: httpsUrlField(listingsInput.url, 'discovery.listings.url'),
    terms: arrayField(listingsInput.terms, 'discovery.listings.terms').map((value, index) => stringField(value, `discovery.listings.terms[${index}]`)),
    locationPattern: regexField(listingsInput.locationPattern, 'discovery.listings.locationPattern'),
  };

  const emailEnabled = booleanField(email.enabled, 'email.enabled');
  const accountLabel = stringField(email.accountLabel, 'email.accountLabel', { empty: !emailEnabled });
  const credentialsBackend = stringField(credentials.backend, 'credentials.backend');
  if (credentialsBackend !== 'macos-keychain') fail('credentials.backend', 'expected macos-keychain');
  const notificationBackend = stringField(notifications.backend, 'notifications.backend');
  if (!['console', 'macos-osascript'].includes(notificationBackend)) {
    fail('notifications.backend', 'expected console or macos-osascript');
  }

  cachedConfig = deeplyFreeze({
    browser: {
      executable: pathField(browser.executable, 'browser.executable'),
      profileDir: pathField(browser.profileDir, 'browser.profileDir'),
      debugHost: loopbackField(browser.debugHost ?? '127.0.0.1', 'browser.debugHost'),
      debugPort: integerField(browser.debugPort ?? 0, 'browser.debugPort', 0, 65535),
      maxTabs: integerField(browser.maxTabs ?? 4, 'browser.maxTabs', 1, 1000),
    },
    resumes: {
      directory,
      filePattern,
      fallbackLane,
      factsFile,
      latexPreamble,
      factsPath: path.join(directory, factsFile),
      preamblePath: path.join(directory, latexPreamble),
    },
    discovery: {
      handshakeBaseUrl: httpsUrlField(discovery.handshakeBaseUrl, 'discovery.handshakeBaseUrl', { handshake: true }),
      queries: queryValues,
      includeTitlePattern: regexField(discovery.includeTitlePattern, 'discovery.includeTitlePattern'),
      excludeTitlePattern: regexField(discovery.excludeTitlePattern, 'discovery.excludeTitlePattern'),
      // Optional: employers never queued (ones the applicant applies to by hand, or has paused).
      excludeEmployerPattern: discovery.excludeEmployerPattern === undefined ? ''
        : regexField(discovery.excludeEmployerPattern, 'discovery.excludeEmployerPattern'),
      lanes,
      specialLane,
      season: {
        primaryStartMonths,
        shortTermStartMonth: monthField(seasonInput.shortTermStartMonth, 'discovery.season.shortTermStartMonth'),
        shortTermEndMonths,
      },
      // Where postings come from: Handshake searches and/or a public internship listings feed (JSON array of
      // {company_name, title, url, active, is_visible, terms, locations}, the SimplifyJobs listings.json format).
      sources,
      listings,
    },
    models: {
      driver: modelConfig(models.driver, 'models.driver', { driver: true }),
      planner: modelConfig(models.planner, 'models.planner'),
      fallback: modelConfig(models.fallback, 'models.fallback'),
      writer: modelConfig(models.writer, 'models.writer'),
    },
    applicant: {
      displayName: stringField(applicant.displayName, 'applicant.displayName'),
      coverLetterHeading: stringField(applicant.coverLetterHeading, 'applicant.coverLetterHeading', { empty: true }),
      relocateAnywhere: booleanField(applicant.relocateAnywhere, 'applicant.relocateAnywhere'),
      workInPerson: booleanField(applicant.workInPerson, 'applicant.workInPerson'),
      summerAvailability: stringField(applicant.summerAvailability, 'applicant.summerAvailability', { empty: true }),
    },
    email: {
      enabled: emailEnabled,
      accountLabel,
      mcpServer: pathField(email.mcpServer, 'email.mcpServer'),
      tokenDatabase: pathField(email.tokenDatabase, 'email.tokenDatabase'),
      oauthCredentials: pathField(email.oauthCredentials, 'email.oauthCredentials'),
    },
    credentials: {
      backend: credentialsBackend,
      servicePrefix: stringField(credentials.servicePrefix ?? 'job-app:', 'credentials.servicePrefix'),
    },
    notifications: {
      backend: notificationBackend,
      title: stringField(notifications.title, 'notifications.title'),
      sound: stringField(notifications.sound, 'notifications.sound', { empty: true }),
    },
    queue: {
      runTimeoutSeconds: integerField(queue.runTimeoutSeconds ?? 900, 'queue.runTimeoutSeconds', 1, 86400),
    },
    runtime: {
      debug: booleanField(runtime.debug ?? false, 'runtime.debug'),
    },
  });

  return cachedConfig;
}
