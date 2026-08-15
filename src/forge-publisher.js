import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { HARNESS_ARTIFACTS } from './artifacts.js';
import { spawnCapture } from './spawn.js';

export const FORGE_NOTE_FILENAME = 'ccc-forge.json';
const REQUIRED_CONFIG = Object.freeze([
  'CCC_FORGE_URL',
  'CCC_FORGE_REPOSITORY',
  'CCC_FORGE_TOKEN',
]);
const REQUEST_TIMEOUT_MS = 15_000;

function secretForms(secret) {
  if (typeof secret !== 'string' || secret === '') return [];
  const forms = new Set([secret, encodeURIComponent(secret)]);
  const json = JSON.stringify(secret);
  if (json.length >= 2) forms.add(json.slice(1, -1));
  return [...forms].filter(Boolean).sort((a, b) => b.length - a.length);
}

function redactText(value, token) {
  let text = String(value ?? '');
  for (const form of secretForms(token)) text = text.split(form).join('[REDACTED]');
  return text;
}

function containsSecret(value, token) {
  const text = String(value ?? '');
  return secretForms(token).some((form) => text.includes(form));
}

export function redactForgeError(error, token = process.env.CCC_FORGE_TOKEN) {
  const message = error instanceof Error ? error.message : String(error);
  return redactText(message, token);
}

export function readForgeConfig(env = process.env) {
  const missing = REQUIRED_CONFIG.filter((name) => (
    typeof env[name] !== 'string' || env[name].trim() === ''
  ));
  if (missing.length > 0) {
    throw new Error(`missing forge configuration: ${missing.join(', ')}`);
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(env.CCC_FORGE_URL);
  } catch {
    throw new Error('invalid CCC_FORGE_URL: expected an absolute http or https URL');
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)
    || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    throw new Error(
      'invalid CCC_FORGE_URL: expected an http or https URL without credentials, query, or fragment',
    );
  }

  const repository = env.CCC_FORGE_REPOSITORY.trim();
  const parts = repository.split('/');
  if (parts.length !== 2
    || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..')
    || parts[1].endsWith('.git')) {
    throw new Error('invalid CCC_FORGE_REPOSITORY: expected owner/name without a .git suffix');
  }

  const token = env.CCC_FORGE_TOKEN;
  if (/[\r\n]/.test(token)) {
    throw new Error('invalid CCC_FORGE_TOKEN: line breaks are not allowed');
  }
  if (containsSecret(parsedUrl, token) || containsSecret(repository, token)) {
    throw new Error('forge configuration would expose the access token in a URL or repository name');
  }

  parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/, '');
  return {
    url: parsedUrl.toString().replace(/\/$/, ''),
    repository,
    owner: parts[0],
    name: parts[1],
    token,
  };
}

function readCompletedRun(runDirectory) {
  const directory = resolve(runDirectory);
  if (!statSync(directory).isDirectory()) {
    throw new Error(`run directory is not a directory: ${directory}`);
  }
  const factsPath = join(directory, 'ccc-runfacts.json');
  let facts;
  try {
    facts = JSON.parse(readFileSync(factsPath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read completed run facts at ${factsPath}: ${error.message}`);
  }
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) {
    throw new Error(`invalid completed run facts at ${factsPath}`);
  }
  for (const field of ['runId', 'branch', 'baseCommit', 'outcome', 'gateStatus']) {
    if (typeof facts[field] !== 'string' || facts[field] === '') {
      throw new Error(`completed run facts are missing ${field}`);
    }
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(facts.baseCommit)) {
    throw new Error('completed run facts contain an invalid baseCommit');
  }
  const taskPath = join(directory, 'TASK.md');
  let task;
  try {
    task = readFileSync(taskPath, 'utf8');
  } catch (error) {
    throw new Error(`cannot read completed task at ${taskPath}: ${error.message}`);
  }
  return { directory, facts, task };
}

function compactTitle(task, runId) {
  const lines = task.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const heading = lines.find((line) => /^#{1,6}\s+\S/.test(line));
  const source = heading ?? lines[0] ?? `CCC run ${runId}`;
  const plain = source
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length <= 120 ? plain : `${plain.slice(0, 117).trimEnd()}...`;
}

function verifierPasses(facts) {
  const iteration = Array.isArray(facts.iterations) ? facts.iterations.at(-1) : null;
  return [
    {
      id: 'correctness',
      label: 'Correctness',
      verdict: iteration?.verifier?.verdict ?? facts.verdict ?? 'n/a',
      source: iteration?.verifier?.verdictSource ?? facts.verdictSource ?? 'n/a',
      findings: facts.verifierFindings ?? iteration?.verifier?.findings ?? '(none recorded)',
      artifact: facts.verifierPlan ?? iteration?.verifier?.plan ?? null,
    },
    {
      id: 'intent',
      label: 'Intent',
      verdict: iteration?.intentVerifier?.verdict ?? facts.intentVerdict ?? 'n/a',
      source: iteration?.intentVerifier?.verdictSource ?? facts.intentVerdictSource ?? 'n/a',
      findings: facts.intentVerifierFindings
        ?? iteration?.intentVerifier?.findings
        ?? '(none recorded)',
      artifact: facts.intentVerifierPlan ?? iteration?.intentVerifier?.plan ?? null,
    },
  ];
}

function usageLine(usage) {
  return `input ${usage?.inputTokens ?? 0}; cached input ${usage?.cachedInputTokens ?? 0}; `
    + `output ${usage?.outputTokens ?? 0}; reasoning output ${usage?.reasoningOutputTokens ?? 0}; `
    + `cache write ${usage?.cacheWriteTokens ?? 0}`;
}

export function buildPullRequestContent({ facts, task, token }) {
  const iteration = Array.isArray(facts.iterations) ? facts.iterations.at(-1) : null;
  const rationale = iteration?.lastMessage ?? '(no executor rationale recorded)';
  const passes = verifierPasses(facts);
  const title = compactTitle(task, facts.runId);
  const body = [
    '## Executor rationale',
    '',
    rationale,
    '',
    '## Run facts',
    '',
    `- Outcome: ${facts.outcome}`,
    `- Gate status: ${facts.gateStatus}`,
    ...passes.map((pass) => (
      `- ${pass.label} verdict: ${pass.verdict} (source: ${pass.source})`
        + (pass.source === 'none'
          ? ' — fail-safe because no verdict marker was found; not a reviewer finding'
          : '')
    )),
    `- Executor tokens: ${usageLine(facts.tokens?.executor)}`,
    `- Verifier tokens: ${usageLine(facts.tokens?.verifier)}`,
    `- Total tokens: ${usageLine(facts.tokens?.total)}`,
    '',
    `CCC run: ${facts.runId}`,
  ].join('\n');
  return {
    title: redactText(title, token),
    body: redactText(body, token),
    passes: passes.map((pass) => ({
      ...pass,
      verdict: redactText(pass.verdict, token),
      source: redactText(pass.source, token),
      findings: redactText(pass.findings, token),
      artifact: pass.artifact === null ? null : redactText(pass.artifact, token),
    })),
  };
}

function reviewMarker(runId, passId) {
  const digest = createHash('sha256').update(`${runId}\0${passId}`).digest('hex').slice(0, 24);
  return `<!-- ccc-verifier-review:${digest} pass:${passId} -->`;
}

export function buildReviewBody({ facts, pass }) {
  const marker = reviewMarker(facts.runId, pass.id);
  const failSafe = pass.source === 'none';
  return [
    marker,
    `## CCC verifier pass: ${pass.label}`,
    '',
    `Verdict: ${pass.verdict} (source: ${pass.source})`,
    ...(failSafe ? [
      '',
      'Fail-safe: no verdict marker was found. ISSUES is the fail-safe default, not a reviewer finding.',
    ] : []),
    '',
    failSafe
      ? '### Retained verifier output (not authoritative reviewer findings)'
      : '### Reviewer findings',
    '',
    pass.findings,
    ...(pass.artifact === null ? [] : [
      '',
      '### Verifier artifact',
      '',
      pass.artifact,
    ]),
  ].join('\n');
}

function remoteUrl(config) {
  return `${config.url}/${config.repository}.git`;
}

function apiUrl(config, path, query) {
  const url = new URL(config.url);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/v1/${path.replace(/^\/+/, '')}`;
  if (query) url.search = new URLSearchParams(query).toString();
  return url;
}

function responseDetail(text, token) {
  const clean = redactText(text, token).replace(/\s+/g, ' ').trim();
  return clean === '' ? '' : `: ${clean.slice(0, 1000)}`;
}

function forgeClient(config, fetchImpl) {
  return async function request(method, path, body, query) {
    const url = apiUrl(config, path, query);
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Accept: 'application/json',
          Authorization: `token ${config.token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'run-claude-codex-cursor-loop',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new Error(
        `forge request ${method} ${url.pathname} failed: ${redactForgeError(error, config.token)}`,
      );
    }
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `forge request ${method} ${url.pathname} failed with HTTP ${response.status}`
          + responseDetail(text, config.token),
      );
    }
    if (text.trim() === '') return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`forge request ${method} ${url.pathname} returned invalid JSON`);
    }
  };
}

async function checkedGit(run, args, options, token) {
  let result;
  try {
    result = await run('git', args, options);
  } catch (error) {
    throw new Error(`git launch failed: ${redactForgeError(error, token)}`);
  }
  if (result.code !== 0) {
    const detail = redactText(result.stderr || result.stdout || `exit ${result.code}`, token).trim();
    throw new Error(`git publish step failed: ${detail}`);
  }
  return result.stdout;
}

function removePublisherTemp(directory) {
  const root = resolve(tmpdir());
  const target = resolve(directory);
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`refusing to remove publisher temp outside ${root}`);
  }
  rmSync(target, { recursive: true, force: true });
}

export async function prepareAndPushBranch({
  runDirectory,
  facts,
  title,
  config,
  runCommand = spawnCapture,
}) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'ccc-forge-publish-'));
  const tempRepository = join(tempRoot, 'repository');
  const disabledHooks = join(tempRoot, 'disabled-hooks');
  const baseCommit = facts.merge?.mergeBase ?? facts.baseCommit;
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(baseCommit)) {
    removePublisherTemp(tempRoot);
    throw new Error('completed run facts contain an invalid publish base commit');
  }
  try {
    const excluded = HARNESS_ARTIFACTS.map((path) => `:(exclude)${path}`);
    const patch = await checkedGit(runCommand, [
      '-C', runDirectory, 'diff', '--cached', '--binary', '--full-index', baseCommit,
      '--', '.', ...excluded,
    ], {}, config.token);
    if (patch.trim() === '') throw new Error('completed run has no publishable diff');
    if (containsSecret(patch, config.token)) {
      throw new Error('refusing to publish a diff that contains the forge access token');
    }

    await checkedGit(runCommand, [
      'clone', '--no-local', '--no-checkout', '--', runDirectory, tempRepository,
    ], {}, config.token);
    await checkedGit(runCommand, [
      '-C', tempRepository, 'read-tree', baseCommit,
    ], {}, config.token);
    await checkedGit(runCommand, [
      '-C', tempRepository, 'apply', '--cached', '--binary', '-',
    ], { input: patch }, config.token);
    const baseDate = (await checkedGit(runCommand, [
      '-C', tempRepository, 'show', '-s', '--format=%cI', baseCommit,
    ], {}, config.token)).trim();
    const commitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'CCC publisher',
      GIT_AUTHOR_EMAIL: 'ccc@local',
      GIT_AUTHOR_DATE: baseDate,
      GIT_COMMITTER_NAME: 'CCC publisher',
      GIT_COMMITTER_EMAIL: 'ccc@local',
      GIT_COMMITTER_DATE: baseDate,
    };
    const tree = (await checkedGit(runCommand, [
      '-C', tempRepository, 'write-tree',
    ], {}, config.token)).trim();
    const commit = (await checkedGit(runCommand, [
      '-C', tempRepository, 'commit-tree', tree, '-p', baseCommit,
    ], { env: commitEnv, input: `${title}\n` }, config.token)).trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commit)) {
      throw new Error('git commit-tree returned an invalid commit identifier');
    }
    const pushEnv = {
      ...process.env,
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: token ${config.token}`,
      GIT_CONFIG_KEY_1: 'http.followRedirects',
      GIT_CONFIG_VALUE_1: 'false',
      GIT_TERMINAL_PROMPT: '0',
    };
    await checkedGit(runCommand, [
      '-C', tempRepository, '-c', `core.hooksPath=${disabledHooks}`,
      'push', remoteUrl(config),
      `${commit}:refs/heads/${facts.branch}`,
    ], { env: pushEnv }, config.token);
    return commit;
  } finally {
    removePublisherTemp(tempRoot);
  }
}

function normalizedBaseBranch(baseRef, defaultBranch) {
  if (typeof baseRef !== 'string' || baseRef === '' || baseRef === 'HEAD'
    || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(baseRef)) {
    return defaultBranch;
  }
  return baseRef
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\/[^/]+\//, '')
    .replace(/^origin\//, '');
}

function pullIndex(pull) {
  const index = pull?.number ?? pull?.index;
  if (!Number.isSafeInteger(index) || index < 1) {
    throw new Error('forge pull-request response is missing its numeric index');
  }
  return index;
}

function pullUrl(config, pull, index) {
  const candidate = typeof pull?.html_url === 'string' && pull.html_url !== ''
    ? pull.html_url
    : `${config.url}/${config.repository}/pulls/${index}`;
  if (containsSecret(candidate, config.token)) {
    throw new Error('forge returned a pull-request URL containing the access token');
  }
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('forge returned an invalid pull-request URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('forge returned an unsafe pull-request URL');
  }
  return parsed.toString();
}

function isPullForBranch(pull, branch) {
  return pull?.head?.ref === branch
    || pull?.head?.label === branch
    || (typeof pull?.head?.label === 'string' && pull.head.label.endsWith(`:${branch}`));
}

async function ensurePullRequest({ request, config, facts, content, base }) {
  const pulls = [];
  for (let page = 1; page <= 100; page++) {
    const batch = await request('GET', `repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.name)}/pulls`, undefined, {
      state: 'all',
      head: `${config.owner}:${facts.branch}`,
      limit: '50',
      page: String(page),
    });
    if (!Array.isArray(batch)) throw new Error('forge pull-request list was not an array');
    pulls.push(...batch);
    if (batch.length < 50) break;
    if (page === 100) throw new Error('forge pull-request search exceeded 5000 results');
  }
  let pull = pulls.find((candidate) => isPullForBranch(candidate, facts.branch));
  if (pull) {
    const index = pullIndex(pull);
    if (pull.state === 'open') {
      pull = await request(
        'PATCH',
        `repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.name)}/pulls/${index}`,
        { title: content.title, body: content.body, base },
      ) ?? pull;
    }
    return { pull, index, existing: true };
  }
  pull = await request(
    'POST',
    `repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.name)}/pulls`,
    { title: content.title, body: content.body, base, head: facts.branch },
  );
  return { pull, index: pullIndex(pull), existing: false };
}

async function ensureVerifierReviews({ request, config, facts, passes, pull, index }) {
  if (pull?.state && pull.state !== 'open') return;
  const path = `repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.name)}`
    + `/pulls/${index}/reviews`;
  const reviews = [];
  for (let page = 1; page <= 100; page++) {
    const batch = await request('GET', path, undefined, { limit: '50', page: String(page) });
    if (!Array.isArray(batch)) throw new Error('forge pull-review list was not an array');
    reviews.push(...batch);
    if (batch.length < 50) break;
    if (page === 100) throw new Error('forge pull-review search exceeded 5000 results');
  }
  const existingBodies = reviews
    .map((review) => review?.body)
    .filter((body) => typeof body === 'string');
  for (const pass of passes) {
    const marker = reviewMarker(facts.runId, pass.id);
    if (existingBodies.some((body) => body.includes(marker))) continue;
    await request('POST', path, {
      event: 'COMMENT',
      body: buildReviewBody({ facts, pass }),
    });
  }
}

function writeForgeNote(runDirectory, note) {
  const path = join(runDirectory, FORGE_NOTE_FILENAME);
  if (existsSync(path)) {
    try {
      const existing = JSON.parse(readFileSync(path, 'utf8'));
      if (existing?.url === note.url && existing?.repository === note.repository) return path;
    } catch {
      // Do not silently replace an unrelated or malformed record below.
    }
    throw new Error(`refusing to replace existing ${FORGE_NOTE_FILENAME}`);
  }
  const temporary = join(
    runDirectory,
    `.${FORGE_NOTE_FILENAME}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, `${JSON.stringify(note, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
    throw error;
  }
  return path;
}

export async function publishRunToForge({
  runDirectory,
  env = process.env,
  adapters = {},
}) {
  const token = env.CCC_FORGE_TOKEN;
  try {
    const config = readForgeConfig(env);
    const completed = readCompletedRun(runDirectory);
    if (containsSecret(completed.facts.branch, config.token)) {
      throw new Error('refusing to publish a branch name containing the forge access token');
    }
    const content = buildPullRequestContent({
      facts: completed.facts,
      task: completed.task,
      token: config.token,
    });
    if (content.passes.some((pass) => pass.verdict === 'n/a' || pass.source === 'n/a')) {
      throw new Error('completed run does not contain both verifier verdicts and sources');
    }
    const push = adapters.prepareAndPushBranch ?? prepareAndPushBranch;
    await push({
      runDirectory: completed.directory,
      facts: completed.facts,
      title: content.title,
      config,
      ...(adapters.runCommand ? { runCommand: adapters.runCommand } : {}),
    });

    const request = forgeClient(config, adapters.fetch ?? globalThis.fetch);
    const repository = await request(
      'GET',
      `repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.name)}`,
    );
    if (typeof repository?.default_branch !== 'string' || repository.default_branch === '') {
      throw new Error('forge repository response is missing default_branch');
    }
    const base = normalizedBaseBranch(completed.facts.baseRef, repository.default_branch);
    const ensured = await ensurePullRequest({
      request,
      config,
      facts: completed.facts,
      content,
      base,
    });
    await ensureVerifierReviews({
      request,
      config,
      facts: completed.facts,
      passes: content.passes,
      pull: ensured.pull,
      index: ensured.index,
    });
    const url = pullUrl(config, ensured.pull, ensured.index);
    const notePath = writeForgeNote(completed.directory, {
      provider: 'forgejo',
      repository: config.repository,
      branch: completed.facts.branch,
      pullRequest: ensured.index,
      url,
    });
    return { url, notePath, existing: ensured.existing };
  } catch (error) {
    throw new Error(redactForgeError(error, token));
  }
}
