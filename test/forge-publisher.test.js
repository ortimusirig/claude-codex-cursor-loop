import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { spawnCapture } from '../src/spawn.js';
import { prepareAndPushBranch, publishRunToForge } from '../src/forge-publisher.js';

const cli = fileURLToPath(new URL('../bin/loop.js', import.meta.url));
const FORGE_KEYS = ['CCC_FORGE_URL', 'CCC_FORGE_REPOSITORY', 'CCC_FORGE_TOKEN'];

function factsFixture() {
  return {
    runId: 'publisher-run',
    target: 'C:/target-that-must-not-change',
    dir: 'ignored-by-publisher',
    isRepo: true,
    baseRef: 'HEAD',
    baseCommit: 'a'.repeat(40),
    branch: 'ccc/publisher-run',
    iterations: [{
      n: 1,
      changedFiles: ['change.txt'],
      lastMessage: 'Added the guarded widget path because the old path dropped failures.',
      verifier: {
        verdict: 'ISSUES', verdictSource: 'none', findings: 'Verifier preamble only.',
      },
      intentVerifier: {
        verdict: 'NO_BLOCKERS', verdictSource: 'result', findings: 'The task is covered.',
      },
    }],
    gateStatus: 'passed',
    verdict: 'ISSUES',
    verdictSource: 'none',
    verifierFindings: 'Verifier preamble only.',
    verifierPlan: '# Correctness audit\n\nNo terminal marker was emitted.',
    intentVerifierFindings: 'The task is covered.',
    intentVerdict: 'NO_BLOCKERS',
    intentVerdictSource: 'result',
    intentVerifierPlan: '# Intent audit\n\nNO_BLOCKERS',
    tokens: {
      executor: { inputTokens: 11, cachedInputTokens: 2, outputTokens: 3,
        reasoningOutputTokens: 1, cacheWriteTokens: 0 },
      verifier: { inputTokens: 17, cachedInputTokens: 5, outputTokens: 7,
        reasoningOutputTokens: 0, cacheWriteTokens: 1 },
      total: { inputTokens: 28, cachedInputTokens: 7, outputTokens: 10,
        reasoningOutputTokens: 1, cacheWriteTokens: 1 },
    },
    outcome: 'review-ready',
  };
}

function createRunFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ccc-forge-test-'));
  const runDirectory = join(root, 'run', 'w');
  const target = join(root, 'target');
  mkdirSync(runDirectory, { recursive: true });
  mkdirSync(target);
  writeFileSync(join(runDirectory, 'TASK.md'), '# Add guarded widget publishing\n\nKeep failures visible.\n');
  writeFileSync(join(runDirectory, 'CHANGES.diff'), 'reviewed diff\n');
  writeFileSync(join(runDirectory, 'ccc-runfacts.json'), `${JSON.stringify(factsFixture(), null, 2)}\n`);
  writeFileSync(join(runDirectory, 'ccc-report.md'), '# Existing report\n');
  writeFileSync(join(runDirectory, 'events.jsonl'), '{"type":"finish"}\n');
  writeFileSync(join(target, 'sentinel.txt'), 'target byte identity\n');
  return { root, runDirectory, target };
}

function snapshotTree(directory) {
  const snapshot = {};
  function visit(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else {
        assert.ok(statSync(path).isFile(), `test fixture contains unsupported entry ${path}`);
        snapshot[relative(directory, path).split(sep).join('/')] = readFileSync(path).toString('base64');
      }
    }
  }
  visit(directory);
  return snapshot;
}

function forgeEnvironment(forgeUrl, token) {
  return {
    ...process.env,
    CCC_FORGE_URL: forgeUrl,
    CCC_FORGE_REPOSITORY: 'acme/widgets',
    CCC_FORGE_TOKEN: token,
  };
}

const noOpPush = async () => 'b'.repeat(40);

async function git(args) {
  const result = await spawnCapture('git', args);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  server.close();
  await once(server, 'close');
}

function forgeStub({ token, failFirstReview = false } = {}) {
  const state = {
    pulls: [],
    reviews: [],
    bodies: [],
    createPulls: 0,
    patchPulls: 0,
    authChecks: [],
    failedReview: false,
  };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    if (body !== '') state.bodies.push(body);
    state.authChecks.push(request.headers.authorization === `token ${token}`);
    const url = new URL(request.url, 'http://stub.invalid');
    const repoPath = '/api/v1/repos/acme/widgets';
    const send = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (request.method === 'GET' && url.pathname === repoPath) {
      send(200, { default_branch: 'main' });
      return;
    }
    if (request.method === 'GET' && url.pathname === `${repoPath}/pulls`) {
      send(200, state.pulls);
      return;
    }
    if (request.method === 'POST' && url.pathname === `${repoPath}/pulls`) {
      state.createPulls++;
      const incoming = JSON.parse(body);
      const pull = {
        number: 42,
        state: 'open',
        head: { ref: incoming.head, label: `acme:${incoming.head}` },
        title: incoming.title,
        body: incoming.body,
        html_url: `${state.baseUrl}/acme/widgets/pulls/42`,
      };
      state.pulls.push(pull);
      send(201, pull);
      return;
    }
    if (request.method === 'PATCH' && url.pathname === `${repoPath}/pulls/42`) {
      state.patchPulls++;
      Object.assign(state.pulls[0], JSON.parse(body));
      send(200, state.pulls[0]);
      return;
    }
    if (request.method === 'GET' && url.pathname === `${repoPath}/pulls/42/reviews`) {
      send(200, state.reviews);
      return;
    }
    if (request.method === 'POST' && url.pathname === `${repoPath}/pulls/42/reviews`) {
      if (failFirstReview && !state.failedReview) {
        state.failedReview = true;
        send(500, { message: `request rejected for ${token}` });
        return;
      }
      const review = { id: state.reviews.length + 1, ...JSON.parse(body) };
      state.reviews.push(review);
      send(201, review);
      return;
    }
    send(404, { message: `${request.method} ${url.pathname}` });
  });
  return { server, state };
}

test('successful publish carries run facts and two distinguishable verifier reviews, then reuses its PR', async (t) => {
  const fixture = createRunFixture();
  const token = 'forge-token-success-9f6b';
  const stub = forgeStub({ token });
  const baseUrl = await listen(stub.server);
  stub.state.baseUrl = baseUrl;
  t.after(async () => { if (stub.server.listening) await close(stub.server); });

  const targetBefore = snapshotTree(fixture.target);
  const env = forgeEnvironment(baseUrl, token);
  const first = await publishRunToForge({
    runDirectory: fixture.runDirectory,
    env,
    adapters: { prepareAndPushBranch: noOpPush },
  });
  assert.equal(first.url, `${baseUrl}/acme/widgets/pulls/42`);
  assert.equal(stub.state.createPulls, 1);
  assert.equal(stub.state.pulls.length, 1);
  assert.match(stub.state.pulls[0].title, /guarded widget publishing/i);
  assert.match(stub.state.pulls[0].body, /Executor rationale[\s\S]*old path dropped failures/);
  assert.match(stub.state.pulls[0].body, /Outcome: review-ready/);
  assert.match(stub.state.pulls[0].body, /Gate status: passed/);
  assert.match(stub.state.pulls[0].body, /Correctness verdict: ISSUES \(source: none\)/);
  assert.match(stub.state.pulls[0].body, /fail-safe because no verdict marker.*not a reviewer finding/i);
  assert.match(stub.state.pulls[0].body, /Intent verdict: NO_BLOCKERS \(source: result\)/);
  assert.match(stub.state.pulls[0].body, /Total tokens: input 28/);

  assert.equal(stub.state.reviews.length, 2);
  const correctness = stub.state.reviews.find((review) => /pass: Correctness/.test(review.body));
  const intent = stub.state.reviews.find((review) => /pass: Intent/.test(review.body));
  assert.ok(correctness, 'the correctness pass must be its own pull review');
  assert.ok(intent, 'the intent pass must be its own pull review');
  assert.equal(correctness.event, 'COMMENT');
  assert.equal(intent.event, 'COMMENT');
  assert.match(correctness.body, /source: none/);
  assert.match(correctness.body, /fail-safe default, not a reviewer finding/i);
  assert.match(correctness.body, /not authoritative reviewer findings/i);
  assert.doesNotMatch(correctness.body, /^### Reviewer findings$/m,
    'source none must not be presented under the genuine-finding heading');
  assert.match(intent.body, /^### Reviewer findings$/m);
  assert.match(intent.body, /The task is covered/);

  const note = JSON.parse(readFileSync(join(fixture.runDirectory, 'ccc-forge.json'), 'utf8'));
  assert.equal(note.url, `${baseUrl}/acme/widgets/pulls/42`);
  assert.equal(note.pullRequest, 42);
  assert.deepEqual(snapshotTree(fixture.target), targetBefore,
    'even a successful explicit publish must not modify the target folder');

  const second = await publishRunToForge({
    runDirectory: fixture.runDirectory,
    env,
    adapters: { prepareAndPushBranch: noOpPush },
  });
  assert.equal(second.url, first.url);
  assert.equal(stub.state.createPulls, 1, 'publishing twice must not create a second PR');
  assert.equal(stub.state.patchPulls, 1, 'the existing open PR should be refreshed');
  assert.equal(stub.state.reviews.length, 2,
    'stable pass markers must prevent duplicate verifier reviews');
  assert.ok(stub.state.authChecks.every(Boolean));

});

test('missing forge configuration exits non-zero, names every setting, and writes no bytes', async () => {
  const fixture = createRunFixture();
  const before = snapshotTree(fixture.runDirectory);
  const env = { ...process.env };
  for (const key of FORGE_KEYS) delete env[key];
  const result = await spawnCapture(process.execPath, [cli, 'publish', fixture.runDirectory], { env });
  assert.notEqual(result.code, 0);
  for (const key of FORGE_KEYS) assert.match(result.stderr, new RegExp(key));
  assert.equal(result.stdout, '');
  assert.deepEqual(snapshotTree(fixture.runDirectory), before,
    'missing configuration must preserve every filename and file byte');
});

test('an unreachable forge preserves every run-directory byte after the explicit push step', async () => {
  const fixture = createRunFixture();
  const reserve = createServer();
  const unavailableUrl = await listen(reserve);
  await close(reserve);
  const before = snapshotTree(fixture.runDirectory);
  await assert.rejects(() => publishRunToForge({
    runDirectory: fixture.runDirectory,
    env: forgeEnvironment(unavailableUrl, 'forge-token-unreachable-13a8'),
    adapters: { prepareAndPushBranch: noOpPush },
  }), /forge request/i);
  assert.deepEqual(snapshotTree(fixture.runDirectory), before,
    'unreachable publishing must preserve contents, not merely the directory listing');
});

test('a forge rejection cannot expose its token or change the completed run', async (t) => {
  const fixture = createRunFixture();
  const token = 'forge-token-must-never-leak-0c33';
  const stub = forgeStub({ token, failFirstReview: true });
  const baseUrl = await listen(stub.server);
  stub.state.baseUrl = baseUrl;
  t.after(async () => { if (stub.server.listening) await close(stub.server); });
  const before = snapshotTree(fixture.runDirectory);
  const factsBefore = readFileSync(join(fixture.runDirectory, 'ccc-runfacts.json'), 'utf8');

  let failureMessage = '';
  await assert.rejects(() => publishRunToForge({
    runDirectory: fixture.runDirectory,
    env: forgeEnvironment(baseUrl, token),
    adapters: { prepareAndPushBranch: noOpPush },
  }), (error) => {
    failureMessage = error.message;
    return true;
  });
  assert.match(failureMessage, /\[REDACTED\]/,
    'positive control: the token-bearing server error must have reached the redactor');
  assert.equal(failureMessage.includes(token), false);
  assert.equal(stub.state.bodies.some((body) => body.includes(token)), false,
    'the token must never be serialized into a logged request body');
  assert.equal(factsBefore.includes(token), false);
  assert.equal(readFileSync(join(fixture.runDirectory, 'ccc-runfacts.json'), 'utf8'), factsBefore);
  assert.deepEqual(snapshotTree(fixture.runDirectory), before,
    'a failure after PR creation must still preserve every local run byte');
  assert.equal(stub.state.createPulls, 1,
    'positive control: failure happened after a real PR creation request');
});

test('the publish command redacts its token from both output streams on failure', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-forge-redaction-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const token = 'forge-token-in-error-path-b2ef';
  const runDirectory = join(root, token);
  mkdirSync(runDirectory);
  const before = snapshotTree(runDirectory);
  const result = await spawnCapture(process.execPath, [cli, 'publish', runDirectory], {
    env: forgeEnvironment('http://127.0.0.1:1', token),
  });
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout.includes(token), false);
  assert.equal(result.stderr.includes(token), false);
  assert.match(result.stderr, /\[REDACTED\]/,
    'positive control: the failing path contained the token before redaction');
  assert.deepEqual(snapshotTree(runDirectory), before);
});

test('the production push passes the token only in child environment, never Git argv', async () => {
  const fixture = createRunFixture();
  const token = 'forge-token-env-only-47dd';
  const calls = [];
  const runCommand = async (_bin, args, options = {}) => {
    calls.push({ args, options });
    const command = args.join(' ');
    if (command.includes(' diff ')) {
      return { code: 0, stdout: 'diff --git a/a b/a\n', stderr: '' };
    }
    if (command.includes(' show -s --format=%cI ')) {
      return { code: 0, stdout: '2026-01-01T00:00:00+00:00\n', stderr: '' };
    }
    if (command.endsWith(' write-tree')) {
      return { code: 0, stdout: `${'c'.repeat(40)}\n`, stderr: '' };
    }
    if (command.includes(' commit-tree ')) {
      return { code: 0, stdout: `${'b'.repeat(40)}\n`, stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  await prepareAndPushBranch({
    runDirectory: fixture.runDirectory,
    facts: factsFixture(),
    title: 'Safe title',
    config: {
      url: 'https://forge.invalid', repository: 'acme/widgets',
      owner: 'acme', name: 'widgets', token,
    },
    runCommand,
  });
  const push = calls.find((call) => call.args.includes('push'));
  assert.ok(push, 'positive control: the push command must run');
  assert.equal(JSON.stringify(calls.map((call) => call.args)).includes(token), false);
  assert.equal(push.options.env.GIT_CONFIG_VALUE_0, `Authorization: token ${token}`);
  assert.equal(push.options.env.GIT_CONFIG_VALUE_1, 'false');
});

test('the production push reconstructs and pushes the reviewed index without changing its source', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-forge-git-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runDirectory = join(root, 'run');
  const forgeRoot = join(root, 'forge');
  const bare = join(forgeRoot, 'acme', 'widgets.git');
  mkdirSync(runDirectory);
  mkdirSync(join(forgeRoot, 'acme'), { recursive: true });
  await git(['-C', runDirectory, 'init', '-b', 'main']);
  await git(['-C', runDirectory, 'config', 'user.name', 'Fixture']);
  await git(['-C', runDirectory, 'config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(runDirectory, 'change.txt'), 'before\n');
  await git(['-C', runDirectory, 'add', 'change.txt']);
  await git(['-C', runDirectory, 'commit', '-m', 'base']);
  const baseCommit = await git(['-C', runDirectory, 'rev-parse', 'HEAD']);
  writeFileSync(join(runDirectory, 'change.txt'), 'after\n');
  await git(['-C', runDirectory, 'add', 'change.txt']);
  writeFileSync(join(runDirectory, 'TASK.md'), '# Artifact that must not be committed\n');
  writeFileSync(join(runDirectory, 'ccc-runfacts.json'), '{}\n');
  await git(['init', '--bare', bare]);
  const before = snapshotTree(runDirectory);

  await prepareAndPushBranch({
    runDirectory,
    facts: { ...factsFixture(), baseCommit },
    title: 'Publish reviewed index',
    config: {
      url: pathToFileURL(forgeRoot).toString().replace(/\/$/, ''),
      repository: 'acme/widgets', owner: 'acme', name: 'widgets',
      token: 'forge-token-local-push-31ea',
    },
  });

  assert.equal(await git(['--git-dir', bare, 'show', 'ccc/publisher-run:change.txt']), 'after');
  const publishedTree = await git(['--git-dir', bare, 'ls-tree', '-r', '--name-only',
    'ccc/publisher-run']);
  assert.equal(publishedTree, 'change.txt', 'harness artifacts must stay out of the pushed tree');
  assert.deepEqual(snapshotTree(runDirectory), before,
    'commit construction and push must not change any source worktree or Git byte');
});
