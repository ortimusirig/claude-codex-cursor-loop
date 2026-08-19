import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HARNESS_ARTIFACTS } from '../src/artifacts.js';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildPullRequestContent,
  prepareAndPushBranch,
  publishRunToGitHub,
} from '../src/github-publisher.js';
import { spawnCapture } from '../src/spawn.js';

const cli = fileURLToPath(new URL('../bin/loop.js', import.meta.url));
const fakeGh = fileURLToPath(new URL('../fixtures/fake-gh.mjs', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

function factsFixture(baseCommit) {
  return {
    runId: 'publisher-run',
    target: 'unused-target',
    dir: 'ignored-by-publisher',
    isRepo: true,
    baseRef: 'main',
    baseCommit,
    branch: 'ccc/publisher-run',
    iterations: [{
      n: 1,
      changedFiles: ['change.txt'],
      lastMessage: 'Added the guarded widget path because the old path dropped failures.',
      verifier: {
        verdict: 'ISSUES',
        verdictSource: 'none',
        findings: 'Correctness preamble without a terminal marker.',
        verdictConsistency: { status: 'consistent' },
      },
      intentVerifier: {
        verdict: 'NO_BLOCKERS',
        verdictSource: 'result',
        findings: 'The task is covered.',
        verdictConsistency: { status: 'consistent' },
      },
    }],
    gateStatus: 'passed',
    verdict: 'ISSUES',
    verdictSource: 'none',
    verifierFindings: 'Correctness preamble without a terminal marker.',
    verifierConsistency: { status: 'consistent' },
    verifierPlan: '# Correctness audit\n\nNo terminal marker was emitted.',
    intentVerifierFindings: 'The task is covered.',
    intentVerdict: 'NO_BLOCKERS',
    intentVerdictSource: 'result',
    intentVerifierConsistency: { status: 'consistent' },
    intentVerifierPlan: '# Intent audit\n\nNO_BLOCKERS',
    tokens: {
      executor: {
        inputTokens: 11, cachedInputTokens: 2, outputTokens: 3,
        reasoningOutputTokens: 1, cacheWriteTokens: 0,
      },
      verifier: {
        inputTokens: 17, cachedInputTokens: 5, outputTokens: 7,
        reasoningOutputTokens: 0, cacheWriteTokens: 1,
      },
      total: {
        inputTokens: 28, cachedInputTokens: 7, outputTokens: 10,
        reasoningOutputTokens: 1, cacheWriteTokens: 1,
      },
    },
    outcome: 'review-ready',
  };
}

async function git(args) {
  const result = await spawnCapture('git', args);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

async function createRunFixture({ githubRemote = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ccc-github-test-'));
  const runDirectory = join(root, 'run');
  mkdirSync(runDirectory);
  await git(['-C', runDirectory, 'init', '-b', 'main']);
  await git(['-C', runDirectory, 'config', 'user.name', 'Fixture']);
  await git(['-C', runDirectory, 'config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(runDirectory, 'change.txt'), 'before\n');
  await git(['-C', runDirectory, 'add', 'change.txt']);
  await git(['-C', runDirectory, 'commit', '-m', 'base']);
  const baseCommit = await git(['-C', runDirectory, 'rev-parse', 'HEAD']);
  await git(['-C', runDirectory, 'switch', '-c', 'ccc/publisher-run']);
  writeFileSync(join(runDirectory, 'change.txt'), 'after\n');
  await git(['-C', runDirectory, 'add', 'change.txt']);
  writeFileSync(
    join(runDirectory, 'TASK.md'),
    '# Add guarded widget publishing\n\nKeep failures visible.\n',
  );
  writeFileSync(
    join(runDirectory, 'ccc-runfacts.json'),
    `${JSON.stringify(factsFixture(baseCommit), null, 2)}\n`,
  );
  writeFileSync(join(runDirectory, 'ccc-report.md'), '# Existing report\n');
  writeFileSync(join(runDirectory, 'events.jsonl'), '{"type":"finish"}\n');
  if (githubRemote) {
    await git(['-C', runDirectory, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
  }
  return { root, runDirectory, baseCommit };
}

function snapshotContents(directory) {
  const snapshot = {};
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else {
        assert.ok(statSync(path).isFile(), `unsupported fixture entry ${path}`);
        snapshot[relative(directory, path).split(sep).join('/')] = readFileSync(path)
          .toString('base64');
      }
    }
  };
  visit(directory);
  return snapshot;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function fakeGhEnvironment(root, overrides = {}) {
  const shims = join(root, 'bin');
  const statePath = join(root, 'gh-state.json');
  mkdirSync(shims, { recursive: true });
  let executable;
  if (process.platform === 'win32') {
    executable = join(shims, 'gh.cmd');
    writeFileSync(executable, `@echo off\r\n"${process.execPath}" "${fakeGh}" %*\r\n`);
  } else {
    executable = join(shims, 'gh');
    writeFileSync(
      executable,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fakeGh)} "$@"\n`,
    );
    chmodSync(executable, 0o755);
  }
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  return {
    executable,
    statePath,
    env: {
      ...process.env,
      [pathKey]: `${shims}${delimiter}${process.env[pathKey] ?? ''}`,
      CCC_FAKE_GH_STATE: statePath,
      CCC_GH_BIN: executable,
      ...overrides,
    },
  };
}

const noOpPush = async () => 'b'.repeat(40);

test('the pull request body carries no recorded event content', () => {
  const content = buildPullRequestContent({
    facts: factsFixture('a'.repeat(40)),
    task: '# Task\n\nTitle: example\n',
  });
  assert.ok(!content.body.includes('aggregated_output'));
  assert.ok(!content.body.includes('outputEncoding'));
  assert.ok(!/exit \d+ · recorded/.test(content.body));
});

test('GitHub publish preconditions have distinct actionable failures', async (t) => {
  const fixture = await createRunFixture({ githubRemote: false });
  const fake = fakeGhEnvironment(fixture.root);
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  await assert.rejects(
    () => publishRunToGitHub({
      runDirectory: fixture.runDirectory,
      ghBin: join(fixture.root, 'definitely-missing-gh'),
    }),
    /gh.*not installed.*install/i,
  );
  await assert.rejects(
    () => publishRunToGitHub({
      runDirectory: fixture.runDirectory,
      ghBin: fake.executable,
      env: { ...fake.env, CCC_FAKE_GH_AUTH: 'fail' },
    }),
    /not authenticated.*gh auth login/i,
  );
  await assert.rejects(
    () => publishRunToGitHub({
      runDirectory: fixture.runDirectory,
      ghBin: fake.executable,
      env: fake.env,
    }),
    /no GitHub remote.*git remote add origin/i,
  );
});

test('publishing creates one PR, posts two distinguishable pass comments, and reuses it', async (t) => {
  const fixture = await createRunFixture();
  const fake = fakeGhEnvironment(fixture.root);
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  const first = await publishRunToGitHub({
    runDirectory: fixture.runDirectory,
    ghBin: fake.executable,
    env: fake.env,
    adapters: { prepareAndPushBranch: noOpPush },
  });
  assert.equal(first.url, 'https://github.com/acme/widgets/pull/42');
  assert.equal(first.existing, false);
  const firstState = JSON.parse(readFileSync(fake.statePath, 'utf8'));
  assert.equal(firstState.createCount, 1);
  assert.equal(firstState.comments.length, 2);
  assert.match(firstState.pull.title, /guarded widget publishing/i);
  assert.match(firstState.pull.body, /Executor rationale[\s\S]*old path dropped failures/);
  assert.match(firstState.pull.body, /Outcome: review-ready/);
  assert.match(firstState.pull.body, /Gate status: passed/);
  assert.match(firstState.pull.body, /Correctness verdict: ISSUES \(source: none\)/);
  assert.match(firstState.pull.body, /fail-safe because no verdict marker.*not a reviewer finding/i);
  assert.match(firstState.pull.body, /Intent verdict: NO_BLOCKERS \(source: result\)/);
  assert.match(firstState.pull.body, /Total tokens: input 28/);
  const correctness = firstState.comments.find((body) => /pass: Correctness/.test(body));
  const intent = firstState.comments.find((body) => /pass: Intent/.test(body));
  assert.ok(correctness, 'correctness must be its own attributable comment');
  assert.ok(intent, 'intent must be its own attributable comment');
  assert.match(correctness, /source: none[\s\S]*fail-safe default, not a reviewer finding/i);
  assert.match(correctness, /not authoritative reviewer findings/);
  assert.match(intent, /^### Reviewer findings$/m);
  assert.match(intent, /The task is covered/);

  const note = JSON.parse(readFileSync(join(fixture.runDirectory, 'ccc-github.json'), 'utf8'));
  assert.equal(note.url, first.url);
  assert.equal(note.pullRequest, 42);

  const second = await publishRunToGitHub({
    runDirectory: fixture.runDirectory,
    ghBin: fake.executable,
    env: fake.env,
    adapters: { prepareAndPushBranch: noOpPush },
  });
  assert.equal(second.url, first.url);
  assert.equal(second.existing, true);
  const secondState = JSON.parse(readFileSync(fake.statePath, 'utf8'));
  assert.equal(secondState.createCount, 1, 'an open branch PR must never be duplicated');
  assert.equal(secondState.editCount, 1, 'the existing open PR should be updated');
  assert.equal(secondState.comments.length, 2, 'each verifier pass should be commented once');
});

test('a failed publish command exits non-zero cleanly and preserves all run contents', async (t) => {
  const fixture = await createRunFixture();
  const fake = fakeGhEnvironment(fixture.root, { CCC_FAKE_GH_FAIL: 'pr list' });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const before = snapshotContents(fixture.runDirectory);

  const result = await spawnCapture(process.execPath, [cli, 'publish', fixture.runDirectory], {
    env: fake.env,
  });
  assert.ok(existsSync(fake.statePath),
    `the fake gh executable must handle the CLI invocation; stderr was: ${result.stderr}`);
  assert.equal(result.code, 2, result.stderr);
  assert.equal(result.signal, null, 'the CLI must exit normally rather than crash or abort');
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /publish failed: Open pull-request lookup failed/);
  assert.doesNotMatch(result.stderr, /fatal:|assertion failed|abort/i);
  assert.deepEqual(snapshotContents(fixture.runDirectory), before,
    'failure must preserve file contents, not merely the directory listing');
});

test('the publish CLI prints and records the PR URL without contacting the network', async (t) => {
  const fixture = await createRunFixture();
  const bare = join(fixture.root, 'cli-remote.git');
  await git(['init', '--bare', bare]);
  const fake = fakeGhEnvironment(fixture.root, {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.${pathToFileURL(bare)}.insteadOf`,
    GIT_CONFIG_VALUE_0: 'https://github.com/acme/widgets.git',
  });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  const result = await spawnCapture(process.execPath, [cli, 'publish', fixture.runDirectory], {
    env: fake.env,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, 'https://github.com/acme/widgets/pull/42\n');
  const note = JSON.parse(readFileSync(join(fixture.runDirectory, 'ccc-github.json'), 'utf8'));
  assert.equal(note.url, result.stdout.trim());
  assert.equal(note.repository, 'acme/widgets');
  assert.equal(
    await git(['--git-dir', bare, 'show', 'ccc/publisher-run:change.txt']),
    'after',
  );
});

test('the production push publishes the reviewed index without changing the worktree', async (t) => {
  const fixture = await createRunFixture({ githubRemote: false });
  const bare = join(fixture.root, 'remote.git');
  await git(['init', '--bare', bare]);
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const before = snapshotContents(fixture.runDirectory);

  await prepareAndPushBranch({
    runDirectory: fixture.runDirectory,
    facts: factsFixture(fixture.baseCommit),
    title: 'Publish reviewed index',
    remoteUrl: bare,
  });

  assert.equal(
    await git(['--git-dir', bare, 'show', 'ccc/publisher-run:change.txt']),
    'after',
  );
  const tree = await git([
    '--git-dir', bare, 'ls-tree', '-r', '--name-only', 'ccc/publisher-run',
  ]);
  assert.equal(tree, 'change.txt', 'run artifacts must stay out of the pushed tree');
  assert.deepEqual(snapshotContents(fixture.runDirectory), before,
    'publishing must leave the local diff available for review');
});

test('removed publisher names and configuration are absent from the repository payload', () => {
  const forbidden = [
    `${['CCC', 'FORGE'].join('_')}_`,
    ['forge', 'publisher'].join('-'),
    ['ccc', 'forge.json'].join('-'),
  ];
  // Derived from the shared list, not hand-maintained. A subset of it made this test
  // time-dependent: CHANGES.diff is written AFTER the gate and carries the deleted
  // forge code as deletion hunks, so the check passed in the gate and failed at home.
  const ignoredRootArtifacts = new Set(HARNESS_ARTIFACTS);
  const matches = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      if (directory === repositoryRoot && entry.isDirectory() && entry.name.startsWith('.')) {
        continue;
      }
      if (directory === repositoryRoot && ignoredRootArtifacts.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      const relativePath = relative(repositoryRoot, path).split(sep).join('/');
      for (const text of forbidden) {
        if (relativePath.includes(text) || readFileSync(path, 'utf8').includes(text)) {
          matches.push(`${relativePath}: ${text}`);
        }
      }
    }
  };
  visit(repositoryRoot);
  assert.deepEqual(matches, []);
});
