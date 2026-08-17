import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BATCH_CAMPAIGN_FLAGS,
  BATCH_FLAG_DEFINITIONS,
  BATCH_INVOCATION_FLAGS,
  parseArgs,
} from '../src/args.js';
import { loadCampaignFile } from '../src/campaign-file.js';
import { CAMPAIGN_SHAPES } from '../src/campaign-validation.js';

const TEST_TEMP_PREFIX = fileURLToPath(new URL('../.campaign-file-test-', import.meta.url));

function makeFixture() {
  const root = mkdtempSync(TEST_TEMP_PREFIX);
  mkdirSync(join(root, 'tasks'));
  mkdirSync(join(root, 'target'));
  writeFileSync(join(root, 'tasks', 'a.md'), 'task a\n');
  writeFileSync(join(root, 'tasks', 'b.md'), 'task b\n');
  writeFileSync(join(root, 'tasks', 'c.md'), 'task c\n');
  writeFileSync(join(root, 'gate.json'), '[]\n');
  return root;
}

function writeCampaign(root, name, document) {
  const path = join(root, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
  return path;
}

function baseDocument(units = [
  { id: 'A', task: 'tasks/a.md', unitKind: 'node' },
  { id: 'B', task: 'tasks/b.md', unitKind: 'node', dependsOn: 'A' },
]) {
  return { target: 'target', gate: 'gate.json', units };
}

test('a declared graph and positional flags normalize identically, while one changed edge does not', () => {
  const root = makeFixture();
  try {
    const document = {
      target: 'target',
      gate: 'gate.json',
      gateRetries: 1,
      concurrency: 3,
      tokenBudget: 9000,
      executorModel: 'executor-X',
      executorEffort: 'medium',
      verifierModel: 'verifier-Y',
      units: [
        { id: 'A', task: 'tasks/a.md', unitKind: 'node' },
        { id: 'B', task: 'tasks/b.md', unitKind: 'node' },
        { id: 'C', task: 'tasks/c.md', unitKind: 'node', dependsOn: ['A', 'B'] },
      ],
    };
    const declared = loadCampaignFile(writeCampaign(root, 'equivalent', document));
    const positional = parseArgs([
      'batch',
      '--task', join(root, 'tasks', 'a.md'), '--unit-id', 'A',
      '--task', join(root, 'tasks', 'b.md'), '--unit-id', 'B',
      '--task', join(root, 'tasks', 'c.md'), '--unit-id', 'C',
      '--depends-on', 'C=A', '--depends-on', 'C=B',
      '--unit-kind', 'node', '--target', join(root, 'target'), '--gate', join(root, 'gate.json'),
      '--gate-retries', '1', '--concurrency', '3', '--token-budget', '9000',
      '--executor-model', 'executor-X', '--executor-effort', 'medium',
      '--verifier-model', 'verifier-Y',
    ]);
    const { command: _command, ...positionalCampaign } = positional;
    assert.deepEqual(declared, positionalCampaign);
    const singleEdgeArray = structuredClone(document);
    singleEdgeArray.units[1].dependsOn = ['A'];
    const normalizedSingleEdge = loadCampaignFile(
      writeCampaign(root, 'single-edge-array', singleEdgeArray),
    );
    assert.equal(normalizedSingleEdge.tasks[1].dependsOn, 'A',
      'a one-element dependency array must normalize like one positional edge');

    const changed = structuredClone(document);
    changed.units[2].dependsOn = ['B'];
    const changedDeclaration = loadCampaignFile(writeCampaign(root, 'changed-edge', changed));
    assert.notDeepEqual(changedDeclaration, declared,
      'positive control: the comparison must observe a changed dependency edge');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('target, gate, and task paths resolve from the campaign directory, not cwd', () => {
  const root = makeFixture();
  const declarationDirectory = join(root, 'nested', 'declaration');
  const unique = `only-next-to-campaign-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(join(declarationDirectory, unique), { recursive: true });
    mkdirSync(join(declarationDirectory, unique, 'target'));
    writeFileSync(join(declarationDirectory, unique, 'task.md'), 'portable task\n');
    writeFileSync(join(declarationDirectory, unique, 'gate.json'), '[]\n');
    const file = writeCampaign(declarationDirectory, 'portable', {
      target: `${unique}/target`,
      gate: `${unique}/gate.json`,
      units: [{ id: 'portable-unit', task: `${unique}/task.md`, unitKind: 'node' }],
    });
    const loaded = loadCampaignFile(file);

    assert.deepEqual({ target: loaded.target, gate: loaded.gate, task: loaded.tasks[0].task }, {
      target: join(declarationDirectory, unique, 'target'),
      gate: join(declarationDirectory, unique, 'gate.json'),
      task: join(declarationDirectory, unique, 'task.md'),
    });
    for (const relativeEntry of [
      `${unique}/target`, `${unique}/gate.json`, `${unique}/task.md`,
    ]) {
      assert.equal(existsSync(resolve(process.cwd(), relativeEntry)), false,
        `positive control: ${relativeEntry} must not also be reachable from cwd`);
    }
    assert.notEqual(resolve(process.cwd()), resolve(declarationDirectory),
      'positive control: the test must execute outside the campaign directory');

    const absoluteDocument = {
      target: loaded.target,
      gate: loaded.gate,
      units: [{ id: 'absolute-unit', task: loaded.tasks[0].task, unitKind: 'node' }],
    };
    const absolute = loadCampaignFile(
      writeCampaign(declarationDirectory, 'absolute-paths', absoluteDocument),
    );
    assert.equal(absolute.target, absoluteDocument.target);
    assert.equal(absolute.gate, absoluteDocument.gate);
    assert.equal(absolute.tasks[0].task, absoluteDocument.units[0].task);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unit and graph validation rejects for the named reason, with a near-identical valid control', () => {
  const root = makeFixture();
  try {
    const cases = [
      {
        name: 'duplicate-id',
        invalid: baseDocument([
          { id: 'A', task: 'tasks/a.md', unitKind: 'node' },
          { id: 'A', task: 'tasks/b.md', unitKind: 'node' },
        ]),
        valid: baseDocument(),
        pattern: /duplicate.*A/i,
      },
      {
        name: 'unknown-parent',
        invalid: baseDocument([
          { id: 'A', task: 'tasks/a.md', unitKind: 'node' },
          { id: 'B', task: 'tasks/b.md', unitKind: 'node', dependsOn: 'MISSING' },
        ]),
        valid: baseDocument(),
        pattern: /B.*unknown.*MISSING/i,
      },
      {
        name: 'cycle',
        invalid: baseDocument([
          { id: 'A', task: 'tasks/a.md', unitKind: 'node', dependsOn: 'B' },
          { id: 'B', task: 'tasks/b.md', unitKind: 'node', dependsOn: 'A' },
        ]),
        valid: baseDocument(),
        pattern: /cycle.*A.*B|cycle.*B.*A/i,
      },
      {
        name: 'missing-id',
        invalid: baseDocument([{ task: 'tasks/a.md', unitKind: 'node' }]),
        valid: baseDocument([{ id: 'A', task: 'tasks/a.md', unitKind: 'node' }]),
        pattern: /unit.*missing id.*declare.*id/i,
      },
      {
        name: 'missing-task',
        invalid: baseDocument([{ id: 'A', unitKind: 'node' }]),
        valid: baseDocument([{ id: 'A', task: 'tasks/a.md', unitKind: 'node' }]),
        pattern: /unit "A".*task/i,
      },
      {
        name: 'missing-task-path',
        invalid: baseDocument([{ id: 'A', task: 'tasks/not-there.md', unitKind: 'node' }]),
        valid: baseDocument([{ id: 'A', task: 'tasks/a.md', unitKind: 'node' }]),
        pattern: /unit "A".*task file does not exist/i,
      },
      {
        name: 'unknown-unit-key',
        invalid: baseDocument([
          { id: 'A', task: 'tasks/a.md', unitKind: 'node' },
          { id: 'B', task: 'tasks/b.md', unitKind: 'node', dependson: 'A' },
        ]),
        valid: baseDocument(),
        pattern: /unit "B".*unknown key "dependson"/i,
      },
      {
        name: 'candidate-dependency',
        invalid: baseDocument([
          { id: 'A', task: 'tasks/a.md', perspective: 'minimal-change' },
          { id: 'B', task: 'tasks/b.md', perspective: 'test-first', dependsOn: 'A' },
        ]),
        valid: baseDocument([
          { id: 'A', task: 'tasks/a.md', perspective: 'minimal-change' },
          { id: 'B', task: 'tasks/b.md', perspective: 'test-first' },
        ]),
        pattern: /candidate "B".*cannot declare dependencies.*alternatives/i,
      },
      {
        name: 'candidate-missing-perspective',
        invalid: baseDocument([
          { id: 'A', task: 'tasks/a.md', perspective: 'minimal-change' },
          { id: 'B', task: 'tasks/b.md' },
        ]),
        valid: baseDocument([
          { id: 'A', task: 'tasks/a.md', perspective: 'minimal-change' },
          { id: 'B', task: 'tasks/b.md', perspective: 'test-first' },
        ]),
        pattern: /candidate "B".*declare a perspective/i,
      },
      {
        name: 'candidate-duplicate-perspective',
        invalid: baseDocument([
          { id: 'A', task: 'tasks/a.md', perspective: 'minimal-change' },
          { id: 'B', task: 'tasks/b.md', perspective: 'MINIMAL-CHANGE' },
        ]),
        valid: baseDocument([
          { id: 'A', task: 'tasks/a.md', perspective: 'minimal-change' },
          { id: 'B', task: 'tasks/b.md', perspective: 'test-first' },
        ]),
        pattern: /duplicate candidate perspective.*A.*B/i,
      },
    ];

    for (const validation of cases) {
      const invalidFile = writeCampaign(root, `invalid-${validation.name}`, validation.invalid);
      const validFile = writeCampaign(root, `valid-${validation.name}`, validation.valid);
      assert.throws(() => loadCampaignFile(invalidFile), validation.pattern, validation.name);
      assert.doesNotThrow(() => loadCampaignFile(validFile),
        `${validation.name} needs a near-identical valid positive control`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unknown top-level and misspelled dependency keys discriminate from correct keys', () => {
  const root = makeFixture();
  try {
    assert.throws(() => loadCampaignFile(writeCampaign(root, 'unknown-top', {
      ...baseDocument(), concurency: 2,
    })), /campaign file.*unknown key "concurency"/i);
    assert.doesNotThrow(() => loadCampaignFile(writeCampaign(root, 'known-top', {
      ...baseDocument(), concurrency: 2,
    })));

    assert.throws(() => loadCampaignFile(writeCampaign(root, 'wrong-edge-key', baseDocument([
      { id: 'A', task: 'tasks/a.md', unitKind: 'node' },
      { id: 'B', task: 'tasks/b.md', unitKind: 'node', dependson: 'A' },
    ]))), /unit "B".*dependson/i);
    const correct = loadCampaignFile(writeCampaign(root, 'right-edge-key', baseDocument()));
    assert.equal(correct.tasks[1].dependsOn, 'A');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the parser-owned batch flag registry completely enforces campaign precedence', () => {
  const root = makeFixture();
  try {
    const file = writeCampaign(root, 'flags', baseDocument([
      { id: 'A', task: 'tasks/a.md', unitKind: 'node' },
    ]));
    const realFlags = Object.keys(BATCH_FLAG_DEFINITIONS);
    assert.ok(realFlags.length > 0, 'positive control: the real flag enumeration is non-empty');
    assert.deepEqual(new Set([
      ...BATCH_CAMPAIGN_FLAGS, ...BATCH_INVOCATION_FLAGS, 'campaign',
    ]), new Set(realFlags));

    for (const flag of BATCH_CAMPAIGN_FLAGS) {
      assert.throws(() => parseArgs([
        'batch', '--campaign', file, `--${flag}`, flag === 'executor-effort' ? 'medium' : 'x',
      ]), new RegExp(`--${flag}.*--campaign`, 'i'), `${flag} must conflict`);
    }
    for (const flag of BATCH_INVOCATION_FLAGS) {
      const definition = BATCH_FLAG_DEFINITIONS[flag];
      const argv = ['batch', '--campaign', file, `--${flag}`];
      if (definition.type === 'string') argv.push(flag === 'port' ? '0' : 'x');
      assert.doesNotThrow(() => parseArgs(argv), `${flag} must compose with --campaign`);
    }
    assert.throws(() => parseArgs([
      'batch', '--campaign', file, '--fabricated-campaign-flag', 'x',
    ]), /fabricated-campaign-flag/i,
    'positive control: a fabricated flag must not be silently classified or accepted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('campaign files express every campaignShape the engine can emit', () => {
  const root = makeFixture();
  try {
    const declarations = {
      'task-set': baseDocument(),
      'candidate-set': baseDocument([
        { id: 'A', task: 'tasks/a.md', perspective: 'minimal-change' },
        { id: 'B', task: 'tasks/b.md', perspective: 'test-first' },
      ]),
      'iterative-candidate-set': {
        ...baseDocument([
          { id: 'A', task: 'tasks/a.md', perspective: 'minimal-change', round: 1 },
          { id: 'B', task: 'tasks/b.md', perspective: 'minimal-change', round: 2 },
        ]),
        rounds: 2,
      },
    };
    assert.deepEqual(new Set(Object.keys(declarations)), new Set(CAMPAIGN_SHAPES),
      'the fixtures must fail when the engine adds a campaign shape');
    const observed = [];
    for (const shape of CAMPAIGN_SHAPES) {
      const loaded = loadCampaignFile(writeCampaign(root, `shape-${shape}`, declarations[shape]));
      const actual = loaded.maxRounds > 1
        ? 'iterative-candidate-set'
        : loaded.candidateSet ? 'candidate-set' : 'task-set';
      observed.push(actual);
    }
    assert.deepEqual(observed, CAMPAIGN_SHAPES);
    assert.ok(observed.every((shape) => typeof shape === 'string' && shape.length > 0));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the campaign loader stays independent of execution, verification, and dashboards', () => {
  const sourcePath = fileURLToPath(new URL('../src/campaign-file.js', import.meta.url));
  const source = readFileSync(sourcePath, 'utf8');
  assert.doesNotMatch(source, /from ['"].*(?:executor|verifier|dashboard)/i);
  assert.ok(isAbsolute(sourcePath), 'positive control: the inspected source path is concrete');
});
