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
import { commandExists, spawnCapture } from './spawn.js';

export const GITHUB_NOTE_FILENAME = 'ccc-github.json';
const COMMAND_TIMEOUT_MS = 60_000;

function outputDetail(result) {
  const detail = String(result?.stderr || result?.stdout || `exit ${result?.code ?? 'unknown'}`)
    .replace(/\s+/g, ' ')
    .trim();
  return detail === '' ? '' : `: ${detail.slice(0, 1000)}`;
}

async function capture(runCommand, bin, args, options, description) {
  let result;
  try {
    result = await runCommand(bin, args, options);
  } catch (error) {
    throw new Error(`${description} could not start: ${error.message}`);
  }
  if (result.code !== 0) {
    throw new Error(`${description} failed${outputDetail(result)}`);
  }
  return result;
}

function readCompletedRun(runDirectory) {
  const directory = resolve(runDirectory);
  let stat;
  try {
    stat = statSync(directory);
  } catch (error) {
    throw new Error(`cannot read run directory ${directory}: ${error.message}`);
  }
  if (!stat.isDirectory()) throw new Error(`run directory is not a directory: ${directory}`);

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
      consistency: iteration?.verifier?.verdictConsistency?.status
        ?? facts.verifierConsistency?.status
        ?? 'not recorded',
      findings: facts.verifierFindings ?? iteration?.verifier?.findings ?? '(none recorded)',
      artifact: facts.verifierPlan ?? iteration?.verifier?.plan ?? null,
    },
    {
      id: 'intent',
      label: 'Intent',
      verdict: iteration?.intentVerifier?.verdict ?? facts.intentVerdict ?? 'n/a',
      source: iteration?.intentVerifier?.verdictSource ?? facts.intentVerdictSource ?? 'n/a',
      consistency: iteration?.intentVerifier?.verdictConsistency?.status
        ?? facts.intentVerifierConsistency?.status
        ?? 'not recorded',
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

export function buildPullRequestContent({ facts, task }) {
  const iteration = Array.isArray(facts.iterations) ? facts.iterations.at(-1) : null;
  const rationale = iteration?.lastMessage ?? '(no executor rationale recorded)';
  const passes = verifierPasses(facts);
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
  return { title: compactTitle(task, facts.runId), body, passes };
}

function reviewMarker(runId, passId) {
  const digest = createHash('sha256').update(`${runId}\0${passId}`).digest('hex').slice(0, 24);
  return `<!-- ccc-verifier-review:${digest} pass:${passId} -->`;
}

export function buildReviewBody({ facts, pass }) {
  const failSafe = pass.source === 'none';
  return [
    reviewMarker(facts.runId, pass.id),
    `## CCC verifier pass: ${pass.label}`,
    '',
    `Verdict: ${pass.verdict} (source: ${pass.source})`,
    `Consistency: ${pass.consistency}`,
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

export function parseGitHubRemote(remoteUrl) {
  const value = String(remoteUrl ?? '').trim();
  const scp = /^git@github[.]com:([^/]+)\/([^/]+?)(?:[.]git)?$/i.exec(value);
  if (scp) return { owner: scp[1], name: scp[2], repository: `${scp[1]}/${scp[2]}` };

  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol)
    || url.hostname.toLowerCase() !== 'github.com'
    || url.password
    || (['http:', 'https:'].includes(url.protocol) && url.username)) return null;
  const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length !== 2) return null;
  const owner = decodeURIComponent(parts[0]);
  const name = decodeURIComponent(parts[1]).replace(/[.]git$/i, '');
  if (!owner || !name || /[\r\n]/.test(`${owner}/${name}`)) return null;
  return { owner, name, repository: `${owner}/${name}` };
}

async function findGitHubRemote(directory, runCommand) {
  const remotes = await capture(
    runCommand,
    'git',
    ['-C', directory, 'remote'],
    { timeoutMs: COMMAND_TIMEOUT_MS },
    'Git remote inspection',
  );
  const names = remotes.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .sort((a, b) => (a === 'origin' ? -1 : b === 'origin' ? 1 : 0));
  for (const name of names) {
    let configuredUrls = [];
    for (const field of ['pushurl', 'url']) {
      const result = await runCommand('git', [
        '-C', directory, 'config', '--get-all', `remote.${name}.${field}`,
      ], { timeoutMs: COMMAND_TIMEOUT_MS });
      if (result.code === 0) {
        configuredUrls = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        if (configuredUrls.length > 0) break;
      }
    }
    for (const url of configuredUrls) {
      const parsed = parseGitHubRemote(url);
      if (parsed) return { remote: name, url, ...parsed };
    }
  }
  throw new Error(
    'no GitHub remote is configured for this repository; add one with '
      + '`git remote add origin https://github.com/OWNER/REPOSITORY.git` and retry',
  );
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

async function checkedGit(runCommand, args, options, description) {
  return capture(runCommand, 'git', args, options, description);
}

export async function prepareAndPushBranch({
  runDirectory,
  facts,
  title,
  remoteUrl,
  runCommand = spawnCapture,
}) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'ccc-github-publish-'));
  const tempRepository = join(tempRoot, 'repository');
  const disabledHooks = join(tempRoot, 'disabled-hooks');
  const baseCommit = facts.merge?.mergeBase ?? facts.baseCommit;
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(baseCommit)) {
    removePublisherTemp(tempRoot);
    throw new Error('completed run facts contain an invalid publish base commit');
  }
  try {
    await checkedGit(runCommand, ['check-ref-format', '--branch', facts.branch], {
      timeoutMs: COMMAND_TIMEOUT_MS,
    }, 'Run branch validation');
    const excluded = HARNESS_ARTIFACTS.map((path) => `:(exclude)${path}`);
    const patch = await checkedGit(runCommand, [
      '-C', runDirectory, 'diff', '--cached', '--binary', '--full-index', baseCommit,
      '--', '.', ...excluded,
    ], { timeoutMs: COMMAND_TIMEOUT_MS }, 'Reviewed diff extraction');
    if (patch.stdout.trim() === '') throw new Error('completed run has no publishable diff');

    await checkedGit(runCommand, [
      'clone', '--no-local', '--no-checkout', '--', runDirectory, tempRepository,
    ], { timeoutMs: COMMAND_TIMEOUT_MS }, 'Temporary repository creation');
    await checkedGit(runCommand, [
      '-C', tempRepository, 'read-tree', baseCommit,
    ], { timeoutMs: COMMAND_TIMEOUT_MS }, 'Reviewed base checkout');
    await checkedGit(runCommand, [
      '-C', tempRepository, 'apply', '--cached', '--binary', '-',
    ], { input: patch.stdout, timeoutMs: COMMAND_TIMEOUT_MS }, 'Reviewed diff application');
    const date = await checkedGit(runCommand, [
      '-C', tempRepository, 'show', '-s', '--format=%cI', baseCommit,
    ], { timeoutMs: COMMAND_TIMEOUT_MS }, 'Base commit timestamp lookup');
    const commitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'CCC publisher',
      GIT_AUTHOR_EMAIL: 'ccc@local',
      GIT_AUTHOR_DATE: date.stdout.trim(),
      GIT_COMMITTER_NAME: 'CCC publisher',
      GIT_COMMITTER_EMAIL: 'ccc@local',
      GIT_COMMITTER_DATE: date.stdout.trim(),
    };
    const tree = await checkedGit(runCommand, [
      '-C', tempRepository, 'write-tree',
    ], { timeoutMs: COMMAND_TIMEOUT_MS }, 'Reviewed tree creation');
    const commit = await checkedGit(runCommand, [
      '-C', tempRepository, 'commit-tree', tree.stdout.trim(), '-p', baseCommit,
    ], { env: commitEnv, input: `${title}\n`, timeoutMs: COMMAND_TIMEOUT_MS }, 'Publish commit creation');
    const commitId = commit.stdout.trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commitId)) {
      throw new Error('git commit-tree returned an invalid commit identifier');
    }
    try {
      await checkedGit(runCommand, [
        '-C', tempRepository, '-c', `core.hooksPath=${disabledHooks}`,
        'push', '--', remoteUrl, `${commitId}:refs/heads/${facts.branch}`,
      ], { timeoutMs: COMMAND_TIMEOUT_MS }, 'GitHub branch push');
    } catch (error) {
      throw new Error(`${error.message}; check repository write access and run \`gh auth setup-git\``);
    }
    return commitId;
  } finally {
    removePublisherTemp(tempRoot);
  }
}

function parseJsonResult(result, description) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${description} returned invalid JSON`);
  }
}

function validatePull(pull) {
  if (!Number.isSafeInteger(pull?.number) || pull.number < 1) {
    throw new Error('GitHub pull-request response is missing its numeric number');
  }
  let url;
  try {
    url = new URL(pull.url);
  } catch {
    throw new Error('GitHub pull-request response is missing a valid URL');
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') {
    throw new Error('GitHub pull-request response returned an unexpected URL');
  }
  return { number: pull.number, url: url.toString() };
}

async function gh(runCommand, ghBin, env, args, description, input) {
  return capture(runCommand, ghBin, args, {
    env,
    timeoutMs: COMMAND_TIMEOUT_MS,
    ...(input === undefined ? {} : { input }),
  }, description);
}

async function findOpenPull({ runCommand, ghBin, env, repository, branch }) {
  const result = await gh(runCommand, ghBin, env, [
    'pr', 'list', '--repo', repository, '--head', branch, '--state', 'open',
    '--json', 'number,url', '--limit', '100',
  ], 'Open pull-request lookup');
  const pulls = parseJsonResult(result, 'Open pull-request lookup');
  if (!Array.isArray(pulls)) throw new Error('Open pull-request lookup did not return a list');
  if (pulls.length > 1) {
    throw new Error(`branch ${branch} has several open pull requests; resolve duplicates before publishing`);
  }
  return pulls.length === 0 ? null : validatePull(pulls[0]);
}

function normalizedBaseBranch(baseRef) {
  if (typeof baseRef !== 'string' || baseRef === '' || baseRef === 'HEAD'
    || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(baseRef)) return null;
  return baseRef
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\/[^/]+\//, '')
    .replace(/^origin\//, '');
}

async function ensurePullRequest({
  runCommand, ghBin, env, remote, facts, content, existing,
}) {
  if (existing) {
    await gh(runCommand, ghBin, env, [
      'pr', 'edit', String(existing.number), '--repo', remote.repository,
      '--title', content.title, '--body-file', '-',
    ], `Existing pull request #${existing.number} update`, content.body);
    return existing;
  }
  const base = normalizedBaseBranch(facts.baseRef);
  const result = await gh(runCommand, ghBin, env, [
    'pr', 'create', '--repo', remote.repository, '--head', facts.branch,
    ...(base === null ? [] : ['--base', base]),
    '--title', content.title, '--body-file', '-',
  ], 'Pull-request creation', content.body);
  const url = result.stdout.split(/\r?\n/).map((line) => line.trim())
    .find((line) => /^https:\/\/github[.]com\//i.test(line));
  if (!url) throw new Error('Pull-request creation did not return a GitHub URL');
  const viewed = await gh(runCommand, ghBin, env, [
    'pr', 'view', url, '--repo', remote.repository, '--json', 'number,url',
  ], 'Created pull-request lookup');
  return validatePull(parseJsonResult(viewed, 'Created pull-request lookup'));
}

async function ensureVerifierComments({
  runCommand, ghBin, env, repository, facts, passes, pull,
}) {
  const viewed = await gh(runCommand, ghBin, env, [
    'pr', 'view', String(pull.number), '--repo', repository, '--json', 'comments',
  ], 'Pull-request comment lookup');
  const response = parseJsonResult(viewed, 'Pull-request comment lookup');
  const comments = Array.isArray(response?.comments) ? response.comments : [];
  const bodies = comments.map((comment) => comment?.body).filter((body) => typeof body === 'string');
  for (const pass of passes) {
    const marker = reviewMarker(facts.runId, pass.id);
    if (bodies.some((body) => body.includes(marker))) continue;
    await gh(runCommand, ghBin, env, [
      'pr', 'comment', String(pull.number), '--repo', repository,
      '--body-file', '-',
    ], `${pass.label} verifier comment`, buildReviewBody({ facts, pass }));
  }
}

function writeGitHubNote(runDirectory, note) {
  const path = join(runDirectory, GITHUB_NOTE_FILENAME);
  if (existsSync(path)) {
    try {
      const existing = JSON.parse(readFileSync(path, 'utf8'));
      if (existing?.url === note.url
        && existing?.repository === note.repository
        && existing?.pullRequest === note.pullRequest) return path;
    } catch {
      // Refuse to replace an unrelated or malformed record below.
    }
    throw new Error(`refusing to replace existing ${GITHUB_NOTE_FILENAME}`);
  }
  const temporary = join(
    runDirectory,
    `.${GITHUB_NOTE_FILENAME}.${process.pid}.${randomUUID()}.tmp`,
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

export async function publishRunToGitHub({
  runDirectory,
  ghBin = 'gh',
  env = process.env,
  adapters = {},
}) {
  const hasCommand = adapters.commandExists ?? commandExists;
  if (!await hasCommand(ghBin)) {
    throw new Error('GitHub CLI (`gh`) is not installed; install it from https://cli.github.com/ and retry');
  }
  const runCommand = adapters.runCommand ?? spawnCapture;
  let auth;
  try {
    auth = await runCommand(ghBin, ['auth', 'status'], { env, timeoutMs: COMMAND_TIMEOUT_MS });
  } catch (error) {
    throw new Error(`GitHub CLI authentication check could not start: ${error.message}`);
  }
  if (auth.code !== 0) {
    throw new Error('GitHub CLI is not authenticated; run `gh auth login` and retry');
  }

  const completed = readCompletedRun(runDirectory);
  const remote = await findGitHubRemote(completed.directory, runCommand);
  const content = buildPullRequestContent({ facts: completed.facts, task: completed.task });
  if (content.passes.some((pass) => pass.verdict === 'n/a' || pass.source === 'n/a')) {
    throw new Error('completed run does not contain both verifier verdicts and sources');
  }
  const existing = await findOpenPull({
    runCommand, ghBin, env, repository: remote.repository, branch: completed.facts.branch,
  });
  const push = adapters.prepareAndPushBranch ?? prepareAndPushBranch;
  await push({
    runDirectory: completed.directory,
    facts: completed.facts,
    title: content.title,
    remoteUrl: remote.url,
    runCommand,
  });
  const pull = await ensurePullRequest({
    runCommand, ghBin, env, remote, facts: completed.facts, content, existing,
  });
  await ensureVerifierComments({
    runCommand,
    ghBin,
    env,
    repository: remote.repository,
    facts: completed.facts,
    passes: content.passes,
    pull,
  });
  const notePath = writeGitHubNote(completed.directory, {
    version: 1,
    provider: 'github',
    repository: remote.repository,
    pullRequest: pull.number,
    url: pull.url,
  });
  return { ...pull, repository: remote.repository, existing: existing !== null, notePath };
}
