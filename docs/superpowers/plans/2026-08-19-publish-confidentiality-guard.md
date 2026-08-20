# Publish Confidentiality Guard Implementation Plan

> **For agentic workers:** This plan is executed by uroboros. Codex implements in an
> isolated worktree, the gate verifies by true exit code, and Cursor reviews read-only. The
> planner never implements.

**Goal:** Stop `publish` from sending credentials or confidential identifiers to GitHub, by
scanning both the branch and the assembled pull-request content before any network call and
refusing when anything is found.

**Architecture:** A new `src/publish-guard.js` runs four checks over two surfaces and returns
a structured result. `publishRunToGitHub` calls it after `buildPullRequestContent` and before
`prepareAndPushBranch`. Every external command is injected so no test spawns a real binary,
makes a network call, or spends tokens.

**Tech Stack:** Node 24, `node:test`, external binaries `gitleaks` (blocking) and
`trufflehog` (advisory), Cursor CLI (`agent`) for the contextual pass.

**Spec:** `docs/superpowers/specs/2026-08-19-publish-confidentiality-guard-design.md`

## Global Constraints

- `package.json` gains no dependencies. Gitleaks, TruffleHog, and Cursor are external
  binaries, not npm packages.
- The guard performs no network calls of its own and writes nothing outside one temporary
  file it removes on every path, including failure.
- **Fail closed.** Gitleaks missing or erroring, blocklist unset or unreadable, or the
  contextual pass unavailable all refuse. Only TruffleHog degrades to a warning.
- TruffleHog is never invoked with `--only-verified`: that flag reports only credentials
  confirmed live by calling provider APIs, which both misses format-valid unverified keys and
  transmits detected secrets to third parties.
- Secret values are never printed. Report location and matching rule only — echoing a
  detected credential creates a new copy of the thing being protected.
- No override flag.
- No existing test is deleted, skipped, or weakened.
- No test may depend on `process.cwd()`, the checkout location, or the run time.
- Blocklist path comes from the `CCC_PUBLISH_BLOCKLIST` environment variable.

---

### Task 1: Assemble the prose surface

**Files:**
- Create: `src/publish-guard.js`
- Test: `test/publish-guard.test.js`

**Interfaces:**
- Consumes: the `{ title, body, passes }` object from `buildPullRequestContent`.
- Produces: `assembleProseSurface(content)` → a single string containing the title, the body,
  and for each pass its `findings` and its `artifact`.

- [ ] **Step 1: Write the failing tests**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleProseSurface } from '../src/publish-guard.js';

const content = {
  title: 'Title line',
  body: '## Executor rationale\n\nrationale text\n',
  passes: [
    { id: 'correctness', label: 'Correctness', findings: 'finding-A', artifact: 'artifact-A' },
    { id: 'intent', label: 'Intent', findings: 'finding-B', artifact: null },
  ],
};

test('the prose surface contains every value publish would send', () => {
  const prose = assembleProseSurface(content);
  for (const needle of ['Title line', 'rationale text', 'finding-A', 'artifact-A', 'finding-B']) {
    assert.ok(prose.includes(needle), `prose surface must contain ${needle}`);
  }
});

test('a null artifact does not become the string null', () => {
  assert.ok(!assembleProseSurface(content).includes('null'));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/publish-guard.test.js`
Expected: FAIL — cannot find module `../src/publish-guard.js`.

- [ ] **Step 3: Write the implementation**

```javascript
export function assembleProseSurface(content) {
  const parts = [content.title ?? '', content.body ?? ''];
  for (const pass of content.passes ?? []) {
    if (typeof pass.findings === 'string') parts.push(pass.findings);
    if (typeof pass.artifact === 'string') parts.push(pass.artifact);
  }
  return parts.filter((part) => part !== '').join('\n\n');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/publish-guard.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/publish-guard.js test/publish-guard.test.js
git commit -m "feat: assemble the prose surface publish would send"
```

---

### Task 2: The blocklist check

**Files:**
- Modify: `src/publish-guard.js`
- Test: `test/publish-guard.test.js`

**Interfaces:**
- Consumes: `assembleProseSurface` from Task 1.
- Produces: `checkBlocklist({ prose, codeText, blocklistPath, readFile })` → `{ ok, findings }`
  where each finding is `{ check: 'blocklist', surface, rule }`.

- [ ] **Step 1: Write the failing tests**

```javascript
import { checkBlocklist } from '../src/publish-guard.js';

const readFile = (path) => (path === '/list' ? 'Cintas\nGilead\n# a comment\n' : (() => {
  throw new Error('ENOENT');
})());

test('a blocklist term in the prose surface is a finding', () => {
  const result = checkBlocklist({
    prose: 'Title: Cintas phase 1', codeText: '', blocklistPath: '/list', readFile,
  });
  assert.equal(result.ok, false);
  assert.equal(result.findings[0].rule, 'Cintas');
  assert.equal(result.findings[0].surface, 'prose');
});

test('matching is case-insensitive', () => {
  const result = checkBlocklist({
    prose: 'about gilead', codeText: '', blocklistPath: '/list', readFile,
  });
  assert.equal(result.ok, false);
});

test('comment lines are not treated as terms', () => {
  const result = checkBlocklist({
    prose: 'a comment', codeText: '', blocklistPath: '/list', readFile,
  });
  assert.equal(result.ok, true, 'lines beginning with # must be ignored');
});

test('clean content passes', () => {
  const result = checkBlocklist({
    prose: 'nothing sensitive', codeText: 'const a = 1;', blocklistPath: '/list', readFile,
  });
  assert.equal(result.ok, true);
  assert.equal(result.findings.length, 0);
});

test('an unreadable blocklist refuses rather than passing', () => {
  const result = checkBlocklist({
    prose: 'x', codeText: '', blocklistPath: '/missing', readFile,
  });
  assert.equal(result.ok, false);
  assert.match(result.findings[0].rule, /blocklist/i);
});

test('an unset blocklist path refuses', () => {
  const result = checkBlocklist({
    prose: 'x', codeText: '', blocklistPath: undefined, readFile,
  });
  assert.equal(result.ok, false);
});

test('an empty blocklist refuses rather than passing vacuously', () => {
  const result = checkBlocklist({
    prose: 'x', codeText: '', blocklistPath: '/empty',
    readFile: () => '\n# only comments\n',
  });
  assert.equal(result.ok, false);
});

test('a finding never echoes surrounding content', () => {
  const result = checkBlocklist({
    prose: 'secret context around Cintas here', codeText: '', blocklistPath: '/list', readFile,
  });
  assert.ok(!JSON.stringify(result.findings).includes('secret context'));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/publish-guard.test.js`
Expected: FAIL — `checkBlocklist` is not exported.

- [ ] **Step 3: Write the implementation**

```javascript
export function checkBlocklist({ prose, codeText, blocklistPath, readFile }) {
  if (typeof blocklistPath !== 'string' || blocklistPath === '') {
    return { ok: false, findings: [{ check: 'blocklist', surface: 'config',
      rule: 'CCC_PUBLISH_BLOCKLIST is not set, so the blocklist check could not run' }] };
  }
  let raw;
  try {
    raw = readFile(blocklistPath);
  } catch (error) {
    return { ok: false, findings: [{ check: 'blocklist', surface: 'config',
      rule: `blocklist could not be read: ${error.message}` }] };
  }
  const terms = String(raw).split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  if (terms.length === 0) {
    return { ok: false, findings: [{ check: 'blocklist', surface: 'config',
      rule: 'blocklist is empty, so the check would pass vacuously' }] };
  }
  const findings = [];
  for (const [surface, text] of [['prose', prose], ['code', codeText]]) {
    const haystack = String(text ?? '').toLocaleLowerCase('en-US');
    for (const term of terms) {
      if (haystack.includes(term.toLocaleLowerCase('en-US'))) {
        findings.push({ check: 'blocklist', surface, rule: term });
      }
    }
  }
  return { ok: findings.length === 0, findings };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/publish-guard.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/publish-guard.js test/publish-guard.test.js
git commit -m "feat: fail-closed blocklist check for publish"
```

---

### Task 3: Scanner checks — gitleaks blocking, trufflehog advisory

**Files:**
- Modify: `src/publish-guard.js`
- Test: `test/publish-guard.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `runScanners({ codeDirectory, proseFilePath, runCommand, commandExists })` →
  `{ ok, findings, advisories, warnings }`. Findings block; advisories and warnings do not.

- [ ] **Step 1: Write the failing tests**

```javascript
import { runScanners } from '../src/publish-guard.js';

const present = () => true;

test('a gitleaks finding blocks and names its surface', async () => {
  const runCommand = async (bin) => (bin === 'gitleaks'
    ? { code: 1, stdout: '[{"RuleID":"aws-access-key","File":"src/a.js","StartLine":3}]', stderr: '' }
    : { code: 0, stdout: '', stderr: '' });
  const result = await runScanners({
    codeDirectory: '/w', proseFilePath: '/tmp/p', runCommand, commandExists: present,
  });
  assert.equal(result.ok, false);
  assert.equal(result.findings[0].check, 'gitleaks');
  assert.match(result.findings[0].rule, /aws-access-key/);
});

test('a trufflehog finding is advisory and does not block', async () => {
  const runCommand = async (bin) => (bin === 'trufflehog'
    ? { code: 183, stdout: '{"DetectorName":"Slack","SourceMetadata":{}}\n', stderr: '' }
    : { code: 0, stdout: '', stderr: '' });
  const result = await runScanners({
    codeDirectory: '/w', proseFilePath: '/tmp/p', runCommand, commandExists: present,
  });
  assert.equal(result.ok, true, 'trufflehog alone must not block');
  assert.equal(result.advisories.length > 0, true);
});

test('trufflehog is never run with --only-verified', async () => {
  const calls = [];
  const runCommand = async (bin, args) => {
    calls.push({ bin, args });
    return { code: 0, stdout: '', stderr: '' };
  };
  await runScanners({
    codeDirectory: '/w', proseFilePath: '/tmp/p', runCommand, commandExists: present,
  });
  const truffle = calls.filter((call) => call.bin === 'trufflehog');
  assert.ok(truffle.length > 0, 'trufflehog must actually be invoked');
  for (const call of truffle) {
    assert.ok(!call.args.includes('--only-verified'));
  }
});

test('both surfaces are scanned by gitleaks', async () => {
  const targets = [];
  const runCommand = async (bin, args) => {
    if (bin === 'gitleaks') targets.push(args.join(' '));
    return { code: 0, stdout: '', stderr: '' };
  };
  await runScanners({
    codeDirectory: '/w', proseFilePath: '/tmp/p', runCommand, commandExists: present,
  });
  assert.ok(targets.some((t) => t.includes('/w')), 'code surface must be scanned');
  assert.ok(targets.some((t) => t.includes('/tmp/p')), 'prose surface must be scanned');
});

test('missing gitleaks refuses', async () => {
  const result = await runScanners({
    codeDirectory: '/w', proseFilePath: '/tmp/p',
    runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
    commandExists: (bin) => bin !== 'gitleaks',
  });
  assert.equal(result.ok, false);
  assert.match(result.findings[0].rule, /gitleaks/i);
});

test('missing trufflehog warns and proceeds', async () => {
  const result = await runScanners({
    codeDirectory: '/w', proseFilePath: '/tmp/p',
    runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
    commandExists: (bin) => bin !== 'trufflehog',
  });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => /trufflehog/i.test(w)));
});

test('a gitleaks execution error refuses rather than passing', async () => {
  const result = await runScanners({
    codeDirectory: '/w', proseFilePath: '/tmp/p',
    runCommand: async (bin) => {
      if (bin === 'gitleaks') throw new Error('spawn failed');
      return { code: 0, stdout: '', stderr: '' };
    },
    commandExists: present,
  });
  assert.equal(result.ok, false);
});

test('clean scans pass', async () => {
  const result = await runScanners({
    codeDirectory: '/w', proseFilePath: '/tmp/p',
    runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
    commandExists: present,
  });
  assert.equal(result.ok, true);
  assert.equal(result.findings.length, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/publish-guard.test.js`
Expected: FAIL — `runScanners` is not exported.

- [ ] **Step 3: Write the implementation**

Implement `runScanners` so that it: refuses when `commandExists('gitleaks')` is false; runs
gitleaks against `codeDirectory` and `proseFilePath` separately with JSON reporting, treating
a non-zero exit with parseable findings as findings and a throw as a refusal; runs trufflehog
against both surfaces without `--only-verified`, collecting results into `advisories` and
never into `findings`; and pushes a warning string when trufflehog is absent or errors.
Findings carry `{ check, surface, rule }` and never the matched value.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/publish-guard.test.js`
Expected: PASS, 18 tests.

- [ ] **Step 5: Commit**

```bash
git add src/publish-guard.js test/publish-guard.test.js
git commit -m "feat: gitleaks blocking and trufflehog advisory scanning for publish"
```

---

### Task 4: The contextual Cursor pass

**Files:**
- Modify: `src/publish-guard.js`
- Test: `test/publish-guard.test.js`

**Interfaces:**
- Consumes: `assembleProseSurface` from Task 1.
- Produces: `runContextualReview({ proseFilePath, runVerifier })` → `{ ok, findings }`.

- [ ] **Step 1: Write the failing tests**

```javascript
import { runContextualReview } from '../src/publish-guard.js';

test('a CONFIDENTIAL verdict blocks', async () => {
  const result = await runContextualReview({
    proseFilePath: '/tmp/p',
    runVerifier: async () => ({ verdict: 'CONFIDENTIAL', text: 'names a customer', code: 0 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.findings[0].check, 'contextual');
});

test('a CLEAN verdict passes', async () => {
  const result = await runContextualReview({
    proseFilePath: '/tmp/p',
    runVerifier: async () => ({ verdict: 'CLEAN', text: 'nothing found', code: 0 }),
  });
  assert.equal(result.ok, true);
});

test('an unusable verdict refuses rather than passing', async () => {
  const result = await runContextualReview({
    proseFilePath: '/tmp/p',
    runVerifier: async () => ({ verdict: null, text: '', code: 0 }),
  });
  assert.equal(result.ok, false);
  assert.match(result.findings[0].rule, /no usable verdict/i);
});

test('a launch failure refuses', async () => {
  const result = await runContextualReview({
    proseFilePath: '/tmp/p',
    runVerifier: async () => { throw new Error('agent not found'); },
  });
  assert.equal(result.ok, false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/publish-guard.test.js`
Expected: FAIL — `runContextualReview` is not exported.

- [ ] **Step 3: Write the implementation**

Implement `runContextualReview` to call the injected `runVerifier` with the prose file path,
treat exactly `CLEAN` as passing, treat exactly `CONFIDENTIAL` as a blocking finding, and
treat anything else — including a throw, a missing verdict, or an unrecognised token — as a
refusal. Follow the existing fail-safe convention in `src/verifier.js`: an unusable verdict
is never upgraded to a pass.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/publish-guard.test.js`
Expected: PASS, 22 tests.

- [ ] **Step 5: Commit**

```bash
git add src/publish-guard.js test/publish-guard.test.js
git commit -m "feat: contextual confidentiality review for publish"
```

---

### Task 5: Wire the guard into publish

**Files:**
- Modify: `src/github-publisher.js` (inside `publishRunToGitHub`, between
  `buildPullRequestContent` at line ~474 and `prepareAndPushBranch` at line ~481)
- Modify: `src/publish-guard.js` (add the orchestrating export)
- Test: `test/github-publisher.test.js`

**Interfaces:**
- Consumes: all four checks from Tasks 1–4.
- Produces: `guardPublish({ runDirectory, content, env, adapters })` → `{ ok, findings,
  advisories, warnings }`, and its invocation inside `publishRunToGitHub`.

- [ ] **Step 1: Write the failing tests**

```javascript
test('publish refuses and makes no network call when the guard finds something', async () => {
  const calls = [];
  await assert.rejects(() => publishRunToGitHub({
    runDirectory: fixtureRunDirectory(),
    adapters: {
      commandExists: () => true,
      guardPublish: async () => ({
        ok: false,
        findings: [{ check: 'gitleaks', surface: 'code', rule: 'aws-access-key' }],
        advisories: [], warnings: [],
      }),
      prepareAndPushBranch: async () => { calls.push('push'); },
      runCommand: async (bin, args) => { calls.push(`${bin} ${args.join(' ')}`); return { code: 0, stdout: '{}', stderr: '' }; },
    },
  }), /aws-access-key/);
  assert.ok(!calls.includes('push'), 'no branch push may occur after a guard refusal');
  assert.ok(!calls.some((c) => c.startsWith('gh ')), 'no gh call may occur after a guard refusal');
});

test('publish proceeds when the guard passes', async () => {
  let pushed = false;
  await publishRunToGitHub({
    runDirectory: fixtureRunDirectory(),
    adapters: {
      commandExists: () => true,
      guardPublish: async () => ({ ok: true, findings: [], advisories: [], warnings: [] }),
      prepareAndPushBranch: async () => { pushed = true; return 'abc123'; },
      runCommand: async () => ({ code: 0, stdout: '{"url":"https://example/pr/1"}', stderr: '' }),
    },
  });
  assert.equal(pushed, true);
});

test('a guard refusal never prints a secret value', async () => {
  await assert.rejects(() => publishRunToGitHub({
    runDirectory: fixtureRunDirectory(),
    adapters: {
      commandExists: () => true,
      guardPublish: async () => ({
        ok: false,
        findings: [{ check: 'gitleaks', surface: 'code', rule: 'aws-access-key' }],
        advisories: [], warnings: [],
      }),
      prepareAndPushBranch: async () => {},
      runCommand: async () => ({ code: 0, stdout: '{}', stderr: '' }),
    },
  }), (error) => !/AKIA/.test(error.message));
});
```

Use the file's existing fixture helpers for a completed run directory; if none exists with
that name, build one from the shape `readCompletedRun` consumes — `ccc-runfacts.json` with
both verdicts and sources present, plus `TASK.md`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/github-publisher.test.js`
Expected: FAIL — publish does not consult a guard, so the push happens.

- [ ] **Step 3: Write the implementation**

Add `guardPublish` to `src/publish-guard.js`, orchestrating: read the blocklist path from
`env.CCC_PUBLISH_BLOCKLIST`; write the assembled prose to a temporary file; run the blocklist
check, the scanners, and the contextual review; delete the temporary file in a `finally` so it
is removed on every path; and merge the results.

In `publishRunToGitHub`, after the existing verdict check and before `prepareAndPushBranch`:

```javascript
  const guard = adapters.guardPublish ?? guardPublish;
  const guardResult = await guard({
    runDirectory: completed.directory, content, env, adapters,
  });
  for (const warning of guardResult.warnings) console.warn(`publish guard: ${warning}`);
  for (const advisory of guardResult.advisories) {
    console.warn(`publish guard advisory: ${advisory.check} ${advisory.surface} ${advisory.rule}`);
  }
  if (!guardResult.ok) {
    const lines = guardResult.findings
      .map((finding) => `  ${finding.check} [${finding.surface}]: ${finding.rule}`)
      .join('\n');
    throw new Error(`publish refused by the confidentiality guard:\n${lines}`);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/github-publisher.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/publish-guard.js src/github-publisher.js test/github-publisher.test.js
git commit -m "feat: refuse publish when the confidentiality guard finds anything"
```

---

### Task 6: Document the new prerequisites

**Files:**
- Modify: `README.md` (the "Optional GitHub publishing" section, around line 273)

- [ ] **Step 1: Update the README**

Extend that section to state that `publish` additionally requires `gitleaks` on `PATH` and a
blocklist file named by `CCC_PUBLISH_BLOCKLIST`, that `trufflehog` is optional and advisory,
that a missing blocking dependency refuses rather than skipping, and that the blocklist file
belongs outside the repository.

- [ ] **Step 2: Verify the packaging validator still passes**

Run: `node install.mjs --dry-run`
Expected: exit 0, `PLUGIN_STATUS=PREPARED`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: publish guard prerequisites"
```

---

### Task 7: Full-suite verification

**Files:** none modified.

- [ ] **Step 1: Run the whole gate**

Run: `node --test`
Expected: PASS, with a higher total than before this plan (354 passing at `5c8b296`).

- [ ] **Step 2: Confirm the dependency invariant**

Run: `node -e "const p=require('./package.json');if(Object.keys(p.dependencies??{}).length||Object.keys(p.devDependencies??{}).length){console.error('FAIL: dependencies added');process.exit(1)}console.log('ok: zero dependencies')"`
Expected: `ok: zero dependencies`.
