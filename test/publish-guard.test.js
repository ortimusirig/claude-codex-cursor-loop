import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assembleProseSurface,
  checkBlocklist,
  guardPublish,
  runContextualReview,
  runScanners,
} from '../src/publish-guard.js';

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
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].rule, 'Cintas');
  assert.ok(!JSON.stringify(result.findings).includes('secret context'));
});

const present = () => true;

test('a gitleaks finding blocks and names its surface', async () => {
  const runCommand = async (bin) => (bin === 'gitleaks'
    ? { code: 1, stdout: '[{"RuleID":"aws-access-key","File":"src/a.js","StartLine":3}]', stderr: '' }
    : { code: 0, stdout: '', stderr: '' });
  const result = await runScanners({
    codeDirectory: '/w', proseFilePath: '/tmp/p', runCommand, commandExists: present,
  });
  assert.equal(result.findings[0]?.surface, 'code');
  assert.equal(result.ok, false);
  assert.equal(result.findings[0].check, 'gitleaks');
  assert.match(result.findings[0].rule, /aws-access-key/);
});

test('scanner reports never retain detected secret values', async () => {
  const credential = 'AKIAEXAMPLESECRET';
  const runCommand = async (bin) => (bin === 'gitleaks'
    ? {
        code: 1,
        stdout: JSON.stringify([{
          RuleID: 'aws-access-key', File: 'src/a.js', StartLine: 3,
          Secret: credential, Match: `credential=${credential}`,
        }]),
        stderr: '',
      }
    : {
        code: 183,
        stdout: `${JSON.stringify({
          DetectorName: 'AWS',
          SourceMetadata: { Data: { Filesystem: { file: 'src/a.js', line: 3 } } },
          Raw: credential,
        })}\n`,
        stderr: '',
      });
  const result = await runScanners({
    codeDirectory: '/w', proseFilePath: '/tmp/p', runCommand, commandExists: present,
  });
  assert.equal(result.ok, false);
  const gitleaksFinding = result.findings.find(({ check }) => check === 'gitleaks');
  assert.ok(gitleaksFinding);
  assert.match(gitleaksFinding.rule, /aws-access-key/);
  assert.ok(!JSON.stringify(result).includes(credential));
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
    assert.ok(call.args.includes('--no-update'),
      'trufflehog must not contact its update service');
    assert.ok(call.args.includes('--no-verification'),
      'trufflehog must not call providers to verify detected credentials');
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
  assert.ok(targets.some((target) => target.includes('/w')), 'code surface must be scanned');
  assert.ok(targets.some((target) => target.includes('/tmp/p')),
    'prose surface must be scanned');
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
  assert.ok(result.warnings.some((warning) => /trufflehog/i.test(warning)));
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

test('a null gitleaks report is treated as a clean report', async () => {
  const result = await runScanners({
    codeDirectory: '/w', proseFilePath: '/tmp/p',
    runCommand: async (bin) => ({
      code: 0,
      stdout: bin === 'gitleaks' ? 'null' : '',
      stderr: '',
    }),
    commandExists: present,
  });
  assert.equal(result.ok, true);
  assert.equal(result.findings.length, 0);
});

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

async function runGuardFixture(t, { codeText, contextualVerdict = 'CLEAN' }) {
  const root = mkdtempSync(join(tmpdir(), 'ccc-publish-guard-test-'));
  const runDirectory = join(root, 'run');
  const blocklistPath = join(root, 'blocklist.txt');
  mkdirSync(runDirectory);
  writeFileSync(join(runDirectory, 'change.js'), codeText);
  writeFileSync(blocklistPath, 'Cintas\n');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let proseFilePath;

  const result = await guardPublish({
    runDirectory,
    content,
    env: { URO_PUBLISH_BLOCKLIST: blocklistPath },
    adapters: {
      temporaryDirectory: root,
      randomUUID: () => 'fixed',
      commandExists: () => true,
      runCommand: async (bin) => (bin === 'gitleaks'
        ? { code: 0, stdout: '[]', stderr: '' }
        : { code: 0, stdout: '', stderr: '' }),
      runVerifier: async (path) => {
        proseFilePath = path;
        assert.match(readFileSync(path, 'utf8'), /Title line/);
        return { verdict: contextualVerdict, text: '', code: 0 };
      },
    },
  });
  return { result, proseFilePath };
}

test('guard orchestration removes the temporary prose file after passing', async (t) => {
  const { result, proseFilePath } = await runGuardFixture(t, { codeText: 'const safe = true;' });
  assert.equal(result.ok, true);
  assert.equal(existsSync(proseFilePath), false);
});

test('guard orchestration removes the temporary prose file after refusing', async (t) => {
  const { result, proseFilePath } = await runGuardFixture(t, {
    codeText: 'const customer = "Cintas";',
  });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((finding) => (
    finding.check === 'blocklist' && finding.surface === 'code'
  )));
  assert.equal(existsSync(proseFilePath), false);
});

test('guard orchestration removes a partially written prose file after a write failure', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-publish-guard-write-test-'));
  const runDirectory = join(root, 'run');
  mkdirSync(runDirectory);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const proseFilePath = join(root, `ccc-publish-prose-${process.pid}-partial.txt`);

  const result = await guardPublish({
    runDirectory,
    content,
    env: {},
    adapters: {
      temporaryDirectory: root,
      randomUUID: () => 'partial',
      writeFile: (path, prose) => {
        writeFileSync(path, prose);
        throw new Error('simulated write failure');
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(existsSync(proseFilePath), false);
});
