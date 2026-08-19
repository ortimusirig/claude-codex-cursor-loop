# Executor Execution Record Implementation Plan

> **For agentic workers:** This plan is executed by the c-cube-loop. Codex implements in an
> isolated worktree, the gate verifies by true exit code, and Cursor reviews read-only. The
> planner never implements.

**Goal:** Record the command lines, exit codes, output, error messages, and agent text that
the Codex stream already provides and `src/executor.js` currently discards, so a planner can
corroborate a mutation pin instead of trusting the executor's account of it.

**Architecture:** A new `src/execution-record.js` owns the encode/decode boundary for
potentially large text. `src/executor.js` calls it when reporting executor events.
`src/dashboard-view.js` calls it when displaying them. The encoding decision lives in one
module so no consumer inspects the marker itself.

**Tech Stack:** Node 24, `node:zlib` (built-in), `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-19-executor-execution-record-design.md`

## Global Constraints

- `package.json` gains no dependencies. `node:zlib` is a Node built-in; the zero-runtime-
  dependency invariant holds and `install.mjs` enforces it.
- No change to `EVENT_PAIRS`, `EVENT_STAGES`, or `EVENT_TYPES` in `src/events.js`.
  `createEvent` leaves `fields` free-form (verified at `src/events.js:130`), so added fields
  need no allowlist change.
- No existing test is deleted, skipped, or weakened.
- No test may depend on `process.cwd()`, the checkout location, or the run time.
- Recorded content never leaves the machine. `publish` must send no event content and the
  Obsidian journal must emit none; both are pinned by tests in Task 4.
- Threshold for plain vs. compressed storage: 2048 bytes. Ceiling: 262144 bytes after
  compression.

---

### Task 1: The encode/decode boundary

**Files:**
- Create: `src/execution-record.js`
- Test: `test/execution-record.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `encodeRecordedText(text)` → `{ text, encoding, truncated }` where `encoding` is
    `'plain'` or `'br+b64'` and `truncated` is a boolean.
  - `decodeRecordedText(field)` → `{ text, truncated }`, accepting the object shape above.
  - `RECORD_THRESHOLD_BYTES` = 2048, `RECORD_CEILING_BYTES` = 262144.

- [ ] **Step 1: Write the failing tests**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeRecordedText, decodeRecordedText,
  RECORD_THRESHOLD_BYTES, RECORD_CEILING_BYTES,
} from '../src/execution-record.js';

test('small text stays plain and greppable', () => {
  const encoded = encodeRecordedText('ok\n');
  assert.equal(encoded.encoding, 'plain');
  assert.equal(encoded.text, 'ok\n');
  assert.equal(encoded.truncated, false);
});

test('large text is compressed and round-trips byte-identically', () => {
  const big = 'x'.repeat(RECORD_THRESHOLD_BYTES + 1);
  const encoded = encodeRecordedText(big);
  assert.equal(encoded.encoding, 'br+b64');
  assert.notEqual(encoded.text, big, 'compressed form must differ from the raw text');
  assert.equal(decodeRecordedText(encoded).text, big);
});

test('the threshold produces observably different stored forms on each side', () => {
  const under = encodeRecordedText('a'.repeat(RECORD_THRESHOLD_BYTES - 1));
  const over = encodeRecordedText('a'.repeat(RECORD_THRESHOLD_BYTES + 1));
  assert.equal(under.encoding, 'plain');
  assert.equal(over.encoding, 'br+b64');
});

test('text beyond the ceiling is truncated and marked', () => {
  const huge = Array.from({ length: RECORD_CEILING_BYTES }, (_, i) => `line ${i}\n`).join('');
  const encoded = encodeRecordedText(huge);
  assert.equal(encoded.truncated, true);
  assert.ok(Buffer.byteLength(encoded.text, 'utf8') <= RECORD_CEILING_BYTES);
  assert.equal(decodeRecordedText(encoded).truncated, true);
});

test('decode tolerates a corrupt compressed payload instead of throwing', () => {
  const result = decodeRecordedText({ text: 'not-valid-base64-brotli', encoding: 'br+b64' });
  assert.equal(typeof result.text, 'string');
  assert.match(result.text, /could not be decoded/i);
});

test('decode passes plain text through unchanged', () => {
  assert.equal(decodeRecordedText({ text: 'hello', encoding: 'plain' }).text, 'hello');
});

test('absent or non-string input yields empty text rather than throwing', () => {
  assert.equal(decodeRecordedText(undefined).text, '');
  assert.equal(encodeRecordedText(undefined).text, '');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/execution-record.test.js`
Expected: FAIL — cannot find module `../src/execution-record.js`.

- [ ] **Step 3: Write the implementation**

```javascript
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';

export const RECORD_THRESHOLD_BYTES = 2048;
export const RECORD_CEILING_BYTES = 262144;

export function encodeRecordedText(value) {
  const text = typeof value === 'string' ? value : '';
  if (text === '') return { text: '', encoding: 'plain', truncated: false };
  if (Buffer.byteLength(text, 'utf8') < RECORD_THRESHOLD_BYTES) {
    return { text, encoding: 'plain', truncated: false };
  }
  let candidate = text;
  let truncated = false;
  let encoded = brotliCompressSync(Buffer.from(candidate, 'utf8')).toString('base64');
  while (Buffer.byteLength(encoded, 'utf8') > RECORD_CEILING_BYTES && candidate.length > 1) {
    candidate = candidate.slice(0, Math.floor(candidate.length / 2));
    truncated = true;
    encoded = brotliCompressSync(Buffer.from(candidate, 'utf8')).toString('base64');
  }
  return { text: encoded, encoding: 'br+b64', truncated };
}

export function decodeRecordedText(field) {
  if (field === null || typeof field !== 'object') return { text: '', truncated: false };
  const truncated = field.truncated === true;
  if (field.encoding !== 'br+b64') {
    return { text: typeof field.text === 'string' ? field.text : '', truncated };
  }
  try {
    const raw = brotliDecompressSync(Buffer.from(String(field.text), 'base64'));
    return { text: raw.toString('utf8'), truncated };
  } catch {
    return { text: '(recorded output could not be decoded)', truncated };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/execution-record.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/execution-record.js test/execution-record.test.js
git commit -m "feat: encode/decode boundary for recorded executor text"
```

---

### Task 2: Capture the discarded fields in the executor

**Files:**
- Modify: `src/executor.js:75-98` (the `observeLine` function)
- Test: `test/executor.test.js`

**Interfaces:**
- Consumes: `encodeRecordedText` from Task 1.
- Produces: executor events carrying `command`, `exitCode`, `output`, `outputEncoding`,
  `outputTruncated`, `errorMessage`, `text`, `textEncoding`, `textTruncated`.

- [ ] **Step 1: Write the failing tests**

Add to `test/executor.test.js`, following the file's existing fake-stream pattern. Each test
feeds NDJSON lines through the executor's line observer and asserts on reported events.

```javascript
test('a command_execution item records its command line and exit code', async () => {
  const events = await runFakeExecutorStream([
    { type: 'item.completed', item: {
      id: '1', type: 'command_execution',
      command: 'node --test', aggregated_output: 'ok\n', exit_code: 0, status: 'completed',
    } },
  ]);
  const recorded = events.find((event) => event.itemType === 'command_execution');
  assert.equal(recorded.command, 'node --test');
  assert.equal(recorded.exitCode, 0);
  assert.equal(recorded.output, 'ok\n');
  assert.equal(recorded.outputEncoding, 'plain');
});

test('a non-zero exit code is recorded', async () => {
  const events = await runFakeExecutorStream([
    { type: 'item.completed', item: {
      id: '2', type: 'command_execution',
      command: 'node --test', aggregated_output: 'fail\n', exit_code: 1, status: 'completed',
    } },
  ]);
  assert.equal(events.find((e) => e.itemType === 'command_execution').exitCode, 1);
});

test('an error item records its message', async () => {
  const events = await runFakeExecutorStream([
    { type: 'item.completed', item: { id: '3', type: 'error', message: 'rate limited' } },
  ]);
  assert.equal(events.find((e) => e.itemType === 'error').errorMessage, 'rate limited');
});

test('an agent_message item records its text', async () => {
  const events = await runFakeExecutorStream([
    { type: 'item.completed', item: { id: '4', type: 'agent_message', text: 'done' } },
  ]);
  const recorded = events.find((e) => e.itemType === 'agent_message');
  assert.equal(recorded.text, 'done');
  assert.equal(recorded.textEncoding, 'plain');
});

test('large command output is stored compressed', async () => {
  const big = 'y'.repeat(5000);
  const events = await runFakeExecutorStream([
    { type: 'item.completed', item: {
      id: '5', type: 'command_execution',
      command: 'noisy', aggregated_output: big, exit_code: 0, status: 'completed',
    } },
  ]);
  const recorded = events.find((e) => e.itemType === 'command_execution');
  assert.equal(recorded.outputEncoding, 'br+b64');
  assert.equal(decodeRecordedText({
    text: recorded.output, encoding: recorded.outputEncoding, truncated: recorded.outputTruncated,
  }).text, big);
});

test('file_change events still report their path unchanged', async () => {
  const events = await runFakeExecutorStream([
    { type: 'item.completed', item: {
      id: '6', type: 'file_change', status: 'completed',
      changes: [{ path: 'src/a.js', kind: 'modify' }],
    } },
  ]);
  assert.ok(events.some((event) => event.file === 'src/a.js'));
});

test('a mutation pin sequence is reconstructible in order', async () => {
  const events = await runFakeExecutorStream([
    { type: 'item.completed', item: { id: '7', type: 'file_change', status: 'completed',
      changes: [{ path: 'src/target.js', kind: 'modify' }] } },
    { type: 'item.completed', item: { id: '8', type: 'command_execution',
      command: 'node --test', aggregated_output: 'fail', exit_code: 1, status: 'completed' } },
    { type: 'item.completed', item: { id: '9', type: 'file_change', status: 'completed',
      changes: [{ path: 'src/target.js', kind: 'modify' }] } },
    { type: 'item.completed', item: { id: '10', type: 'command_execution',
      command: 'node --test', aggregated_output: 'pass', exit_code: 0, status: 'completed' } },
  ]);
  const shape = events
    .filter((e) => e.file !== undefined || e.exitCode !== undefined)
    .map((e) => (e.file !== undefined ? `file:${e.file}` : `exit:${e.exitCode}`));
  assert.deepEqual(shape, ['file:src/target.js', 'exit:1', 'file:src/target.js', 'exit:0']);
});
```

Note on the second `file_change` for the same path: `observeLine` currently deduplicates
paths with `seenFiles`, so a restore of an already-seen file reports no second event. The
implementation must still emit a `file_change` event when the same path changes again, or
this test cannot pass — deduplication may keep suppressing duplicate paths *within a single
item*, but not across separate items.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/executor.test.js`
Expected: FAIL — `recorded.command` is `undefined`, and the ordering test's shape is empty.

- [ ] **Step 3: Write the implementation**

In `src/executor.js`, import the encoder and extend the reporting branch:

```javascript
import { encodeRecordedText } from './execution-record.js';
```

Replace the `if (!reported)` block with reporting that carries the item's content:

```javascript
    if (!reported) {
      const itemType = typeof item.type === 'string' ? item.type : 'unknown';
      const fields = { itemType, attempt };
      if (itemType === 'command_execution') {
        if (typeof item.command === 'string') fields.command = item.command;
        if (Number.isInteger(item.exit_code)) fields.exitCode = item.exit_code;
        const output = encodeRecordedText(item.aggregated_output);
        if (output.text !== '') {
          fields.output = output.text;
          fields.outputEncoding = output.encoding;
          if (output.truncated) fields.outputTruncated = true;
        }
      }
      if (itemType === 'error' && typeof item.message === 'string') {
        fields.errorMessage = item.message;
      }
      if (itemType === 'agent_message') {
        const text = encodeRecordedText(item.text);
        if (text.text !== '') {
          fields.text = text.text;
          fields.textEncoding = text.encoding;
          if (text.truncated) fields.textTruncated = true;
        }
      }
      reportEvent(reporter, runId, 'executor', 'item_completed', fields);
    }
```

Change `seenFiles` deduplication so it applies per item rather than across the whole stream:
move `const seenFiles = new Set();` from the enclosing scope to the top of the
`item.type === 'file_change'` branch, so a later item touching the same path reports again.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/executor.test.js`
Expected: PASS, including the pre-existing tests in that file.

- [ ] **Step 5: Commit**

```bash
git add src/executor.js test/executor.test.js
git commit -m "feat: record executor commands, exit codes, output, errors, and agent text"
```

---

### Task 3: Render recorded output in the dashboard

**Files:**
- Modify: `src/dashboard-view.js` (the Detail timeline rendering)
- Test: `test/dashboard.test.js`

**Interfaces:**
- Consumes: `decodeRecordedText` from Task 1; the event fields from Task 2.
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

```javascript
test('Detail renders a recorded command line and exit code', () => {
  const run = displayRunWithEvents([
    { stage: 'executor', type: 'item_completed', itemType: 'command_execution',
      command: 'node --test', exitCode: 1, output: 'boom', outputEncoding: 'plain' },
  ]);
  const html = renderRunDetail(run);
  assert.match(html, /node --test/);
  assert.match(html, /exit 1/);
  assert.match(html, /boom/);
});

test('Detail decodes compressed output rather than showing base64', () => {
  const big = 'z'.repeat(5000);
  const encoded = encodeRecordedText(big);
  const run = displayRunWithEvents([
    { stage: 'executor', type: 'item_completed', itemType: 'command_execution',
      command: 'noisy', exitCode: 0, output: encoded.text, outputEncoding: encoded.encoding },
  ]);
  const html = renderRunDetail(run);
  assert.ok(!html.includes(encoded.text), 'raw base64 must never be rendered');
  assert.match(html, /zzzz/);
});

test('Detail shows a recorded error message', () => {
  const run = displayRunWithEvents([
    { stage: 'executor', type: 'item_completed', itemType: 'error',
      errorMessage: 'rate limited' },
  ]);
  assert.match(renderRunDetail(run), /rate limited/);
});

test('a corrupt encoded payload degrades to a message instead of throwing', () => {
  const run = displayRunWithEvents([
    { stage: 'executor', type: 'item_completed', itemType: 'command_execution',
      command: 'x', exitCode: 0, output: 'garbage', outputEncoding: 'br+b64' },
  ]);
  assert.doesNotThrow(() => renderRunDetail(run));
  assert.match(renderRunDetail(run), /could not be decoded/i);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/dashboard.test.js`
Expected: FAIL — the command line and exit code are absent from the rendered HTML.

- [ ] **Step 3: Write the implementation**

Import `decodeRecordedText` in `src/dashboard-view.js`. Where the Detail view renders the
stage timeline, extend an executor entry so that a `command_execution` shows its command and
`exit N`, an `error` shows its `errorMessage`, and recorded output renders decoded inside a
collapsed `<details>` — matching the collapsed pattern already used for the plan and the
verifier reports. Escape all rendered values with the existing `escapeHtml`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/dashboard.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard-view.js test/dashboard.test.js
git commit -m "feat: render recorded executor commands, output, and errors in Detail"
```

---

### Task 4: Pin locality so recorded content cannot start leaving the machine

**Files:**
- Test: `test/github-publisher.test.js`
- Test: `test/run-journal.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks; asserts existing behavior.
- Produces: nothing.

- [ ] **Step 1: Write the failing tests**

```javascript
// test/github-publisher.test.js
test('the pull request body carries no recorded event content', () => {
  const facts = completedFactsFixture();
  const content = buildPullRequestContent({ facts, task: '# Task\n\nTitle: example\n' });
  assert.ok(!content.body.includes('aggregated_output'));
  assert.ok(!content.body.includes('outputEncoding'));
  assert.ok(!/exit \d+ · recorded/.test(content.body));
});

// test/run-journal.test.js
test('the journal note carries no recorded event content', () => {
  const note = buildJournalNote({
    facts: completedFactsFixture(),
    events: [{
      stage: 'executor', type: 'item_completed', itemType: 'command_execution',
      command: 'secret-command --token abc', exitCode: 0,
      output: 'sensitive output', outputEncoding: 'plain',
    }],
  });
  assert.ok(!note.includes('secret-command'));
  assert.ok(!note.includes('sensitive output'));
});
```

Use each test file's existing fixture helpers; if a helper with the referenced name does not
exist, construct the fixture inline from the shapes those modules already consume.

- [ ] **Step 2: Run the tests to verify they pass immediately**

Run: `node --test test/github-publisher.test.js test/run-journal.test.js`
Expected: PASS on first run. These pin behavior that is already correct — `publish` reads
only `ccc-runfacts.json`, `TASK.md`, and its own note, and the journal parses events solely
to collect touched file paths.

A test that passes immediately is not proof by itself. Verify it can fail: temporarily add
`content.body += JSON.stringify(events)` to the publisher, confirm the first test fails,
then revert. Record both counts.

- [ ] **Step 3: Commit**

```bash
git add test/github-publisher.test.js test/run-journal.test.js
git commit -m "test: pin that recorded event content never reaches publish or the journal"
```

---

### Task 5: Full-suite verification

**Files:** none modified.

- [ ] **Step 1: Run the whole gate**

Run: `node --test`
Expected: PASS, with a higher total than before this plan (the suite was 354 passing at
`5c8b296`).

- [ ] **Step 2: Run the packaging validator**

Run: `node install.mjs --dry-run`
Expected: exit 0, `PLUGIN_STATUS=PREPARED`.

- [ ] **Step 3: Confirm the dependency invariant**

Run: `node -e "const p=require('./package.json');if(Object.keys(p.dependencies??{}).length||Object.keys(p.devDependencies??{}).length){console.error('FAIL: dependencies added');process.exit(1)}console.log('ok: zero dependencies')"`
Expected: `ok: zero dependencies`.
