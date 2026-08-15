import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRunJournalNote,
  generateRunJournal,
  generateRunJournalCampaign,
} from '../src/run-journal.js';

const projectRunsDir = fileURLToPath(new URL('../docs/runs/', import.meta.url));

const correctnessFindings = 'Correctness: the "cache key" is stale.\nUse the normalized path.';
const intentFindings = 'Intent: the "whole campaign" rebuild is absent.\nRegenerate every run.';

const fixtureFacts = {
  runId: '2026-08-15T05-58-52-775Z-journal-fixture',
  date: '2026-08-14T22:58:52.775-07:00',
  branch: 'ccc/journal: "quoted"',
  iterations: [{
    n: 1,
    changedFiles: ['src/run.js', 'docs/schema: "quoted".md'],
    lastMessage: 'Kept the loop unchanged.\nAdded the offline journal only.',
    gate: { passed: true, results: [] },
  }],
  gateStatus: 'passed',
  verdict: 'ISSUES',
  verdictSource: 'assistant',
  verifierFindings: correctnessFindings,
  verifierPlan: '# Correctness plan\n\nInspect the cache behavior.',
  intentVerifierFindings: intentFindings,
  intentVerdict: 'NO_BLOCKERS',
  intentVerdictSource: 'result',
  intentVerifierPlan: '# Intent plan\n\nCompare every requirement.',
  gateFailure: {
    bin: 'node',
    args: ['--test', 'test/cache.test.js'],
    code: 1,
    outputTail: '[stdout]\nexpected fresh cache\n[stderr]\nassertion failed',
  },
  limits: { gateRetries: 0, timeoutsMs: { executor: null, verifier: null, gate: null } },
  timeoutEvents: [],
  tokens: {
    executor: {
      inputTokens: 61, cachedInputTokens: 17, outputTokens: 13,
      reasoningOutputTokens: 5, cacheWriteTokens: 3,
    },
    verifier: {
      inputTokens: 40, cachedInputTokens: 11, outputTokens: 10,
      reasoningOutputTokens: 0, cacheWriteTokens: 2,
    },
    total: {
      inputTokens: 101, cachedInputTokens: 28, outputTokens: 23,
      reasoningOutputTokens: 5, cacheWriteTokens: 5,
    },
  },
  outcome: 'review-ready',
};

const fixtureEvents = [
  {
    ts: '2026-08-15T05:58:53.000Z',
    runId: fixtureFacts.runId,
    stage: 'executor',
    type: 'file_change',
    file: 'src/earlier-retry.js',
    attempt: 1,
  },
  {
    ts: '2026-08-15T05:58:54.000Z',
    runId: 'a-different-run',
    stage: 'executor',
    type: 'file_change',
    file: 'src/not-this-run.js',
  },
];

function parseScalar(raw) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return new Date(`${raw}T00:00:00.000Z`);
  return JSON.parse(raw);
}

// The generator deliberately emits a tiny YAML subset: JSON-quoted scalars, an unquoted
// ISO date, numbers/null, and a block list of quoted strings. Parsing that subset here
// exercises the actual serialization without introducing a test-only YAML dependency.
function parseFrontmatter(markdown) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  assert.ok(match, 'note must begin with closed YAML frontmatter');
  const parsed = {};
  const lines = match[1].split('\n');
  for (let index = 0; index < lines.length; index++) {
    const property = /^([A-Za-z][A-Za-z0-9]*):(?: (.*))?$/.exec(lines[index]);
    assert.ok(property, `invalid frontmatter line: ${lines[index]}`);
    const [, key, raw = ''] = property;
    if (raw !== '') {
      parsed[key] = parseScalar(raw);
      continue;
    }
    const values = [];
    while (lines[index + 1]?.startsWith('  - ')) {
      index++;
      values.push(parseScalar(lines[index].slice(4)));
    }
    parsed[key] = values;
  }
  return { parsed, raw: match[1], body: markdown.slice(match[0].length) };
}

test('frontmatter parses with every required property and Bases-compatible types', () => {
  const note = buildRunJournalNote(fixtureFacts, fixtureEvents);
  const { parsed } = parseFrontmatter(note);
  const required = [
    'runId', 'date', 'outcome', 'gateStatus', 'verdict', 'intentVerdict',
    'verdictSource', 'tokensTotal', 'branch', 'filesChanged',
  ];
  assert.deepEqual(Object.keys(parsed), required);
  assert.equal(typeof parsed.runId, 'string');
  assert.ok(parsed.date instanceof Date);
  assert.equal(parsed.date.toISOString(), '2026-08-14T00:00:00.000Z');
  for (const key of ['outcome', 'gateStatus', 'verdict', 'intentVerdict', 'verdictSource', 'branch']) {
    assert.equal(typeof parsed[key], 'string', `${key} must remain a string`);
  }
  assert.equal(typeof parsed.tokensTotal, 'number');
  assert.equal(parsed.tokensTotal, 124, 'cached and reasoning subsets must not be double-counted');
  assert.ok(Array.isArray(parsed.filesChanged));
  assert.deepEqual(parsed.filesChanged, [
    '[[src/run.js]]',
    '[[docs/schema: "quoted".md]]',
    '[[src/earlier-retry.js]]',
  ]);
});

test('colon, double quote, and newline findings cannot corrupt frontmatter or body', () => {
  const { raw, body } = parseFrontmatter(buildRunJournalNote(fixtureFacts, fixtureEvents));
  assert.doesNotMatch(raw, /cache key|whole campaign|Regenerate every run/);
  assert.ok(body.includes(correctnessFindings), 'correctness findings must survive verbatim');
  assert.ok(body.includes(intentFindings), 'different intent findings must survive verbatim');
  assert.match(raw, /^branch: "ccc\/journal: \\"quoted\\""$/m,
    'frontmatter strings with YAML punctuation must be JSON-quoted');
});

test('every touched file is a body wikilink and unrelated events are ignored', () => {
  const { body } = parseFrontmatter(buildRunJournalNote(fixtureFacts, fixtureEvents));
  assert.match(body, /^- \[\[src\/run[.]js\]\]$/m);
  assert.match(body, /^- \[\[docs\/schema: "quoted"[.]md\]\]$/m);
  assert.match(body, /^- \[\[src\/earlier-retry[.]js\]\]$/m);
  assert.doesNotMatch(body, /not-this-run/);
});

test('gate failures are conditional and both verifier passes remain distinguishable', () => {
  const withGate = buildRunJournalNote(fixtureFacts, fixtureEvents);
  assert.match(withGate, /## Gate failure/);
  assert.match(withGate, /node --test test\/cache[.]test[.]js/);
  assert.match(withGate, /expected fresh cache/);
  assert.match(withGate, /## Verifier findings\nCorrectness:/);
  assert.match(withGate, /## Intent verifier findings\nIntent:/);
  assert.notEqual(correctnessFindings, intentFindings, 'positive control: pass fixtures must differ');
  assert.ok(withGate.indexOf(correctnessFindings) < withGate.indexOf(intentFindings));

  const withoutGate = buildRunJournalNote({ ...fixtureFacts, gateFailure: null }, fixtureEvents);
  assert.doesNotMatch(withoutGate, /## Gate failure/);
  assert.match(withoutGate, /## Tokens\n\| Seat \| Input \| Cached input/);
});

test('writing the same run twice is byte-identical and accepts run directory or facts path', () => {
  const root = mkdtempSync(join(tmpdir(), 'run-journal-'));
  const facts = {
    ...fixtureFacts,
    runId: `2026-08-15T05-58-52-775Z-rewrite-${process.pid}`,
  };
  const events = fixtureEvents.map((event) => ({ ...event, runId: facts.runId }));
  const scratchRun = join(root, 'scratch', facts.runId);
  const runWorkDir = join(scratchRun, 'w');
  mkdirSync(runWorkDir, { recursive: true });
  const factsPath = join(runWorkDir, 'ccc-runfacts.json');
  const expectedNotePath = join(projectRunsDir, `${facts.runId}.md`);
  writeFileSync(factsPath, JSON.stringify(facts, null, 2));
  writeFileSync(join(runWorkDir, 'events.jsonl'),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);

  try {
    const first = generateRunJournal(scratchRun);
    const firstBytes = readFileSync(first.notePath);
    const second = generateRunJournal(factsPath);
    const secondBytes = readFileSync(second.notePath);
    assert.deepEqual(secondBytes, firstBytes);
    assert.equal(dirname(second.notePath), projectRunsDir.replace(/[\\/]$/, ''));
    assert.equal(second.notePath, expectedNotePath);
  } finally {
    rmSync(expectedNotePath, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('campaign mode recursively regenerates every discovered run', () => {
  const root = mkdtempSync(join(tmpdir(), 'run-journal-campaign-'));
  const scratchRoot = join(root, 'scratch');
  const suffix = process.pid;
  const runs = [
    { ...fixtureFacts, runId: `2026-08-14T01-00-00-000Z-first-${suffix}`, date: undefined },
    { ...fixtureFacts, runId: `2026-08-15T01-00-00-000Z-second-${suffix}`, date: undefined },
  ];
  for (const facts of runs) {
    const workDir = join(scratchRoot, facts.runId, 'w');
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, 'ccc-runfacts.json'), JSON.stringify(facts));
  }

  try {
    const generated = generateRunJournalCampaign(scratchRoot);
    assert.deepEqual(generated.map((entry) => entry.runId), runs.map((facts) => facts.runId));
    for (const facts of runs) {
      const note = readFileSync(join(projectRunsDir, `${facts.runId}.md`), 'utf8');
      assert.match(note, new RegExp(`^runId: ${JSON.stringify(facts.runId)}$`, 'm'));
      assert.match(note, new RegExp(`^date: ${facts.runId.slice(0, 10)}$`, 'm'));
    }
  } finally {
    for (const facts of runs) rmSync(join(projectRunsDir, `${facts.runId}.md`), { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
