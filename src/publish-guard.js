import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { HARNESS_ARTIFACTS } from './artifacts.js';
import { commandExists, spawnCapture } from './spawn.js';
import { buildCursorArgs } from './verifier.js';
import { readEnv } from './env-compat.js';

export function assembleProseSurface(content) {
  const parts = [content.title ?? '', content.body ?? ''];
  for (const pass of content.passes ?? []) {
    if (typeof pass.findings === 'string') parts.push(pass.findings);
    if (typeof pass.artifact === 'string') parts.push(pass.artifact);
  }
  return parts.filter((part) => part !== '').join('\n\n');
}

export function checkBlocklist({ prose, codeText, blocklistPath, readFile }) {
  if (typeof blocklistPath !== 'string' || blocklistPath === '') {
    return {
      ok: false,
      findings: [{
        check: 'blocklist',
        surface: 'config',
        rule: 'URO_PUBLISH_BLOCKLIST is not set, so the blocklist check could not run',
      }],
    };
  }

  let raw;
  try {
    raw = readFile(blocklistPath);
  } catch (error) {
    return {
      ok: false,
      findings: [{
        check: 'blocklist',
        surface: 'config',
        rule: `blocklist could not be read: ${error.message}`,
      }],
    };
  }

  const terms = String(raw).split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  if (terms.length === 0) {
    return {
      ok: false,
      findings: [{
        check: 'blocklist',
        surface: 'config',
        rule: 'blocklist is empty, so the check would pass vacuously',
      }],
    };
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

function parseJsonRecords(text) {
  const value = String(text ?? '').trim();
  if (value === '') return { records: [], usable: true };

  try {
    const parsed = JSON.parse(value);
    if (parsed === null) return { records: [], usable: true };
    return { records: Array.isArray(parsed) ? parsed : [parsed], usable: true };
  } catch {
    const records = [];
    for (const line of value.split(/\r?\n/)) {
      if (line.trim() === '') continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed === null) continue;
        if (Array.isArray(parsed)) records.push(...parsed);
        else records.push(parsed);
      } catch {
        return { records: [], usable: false };
      }
    }
    return { records, usable: true };
  }
}

function gitleaksRule(record) {
  const rule = typeof record?.RuleID === 'string' && record.RuleID !== ''
    ? record.RuleID
    : 'unidentified gitleaks rule';
  const file = typeof record?.File === 'string' && record.File !== '' ? record.File : null;
  const line = Number.isInteger(record?.StartLine) ? record.StartLine : null;
  if (file && line !== null) return `${rule} at ${file}:${line}`;
  if (file) return `${rule} at ${file}`;
  return rule;
}

function trufflehogRule(record) {
  const detector = typeof record?.DetectorName === 'string' && record.DetectorName !== ''
    ? record.DetectorName
    : 'unidentified trufflehog detector';
  const filesystem = record?.SourceMetadata?.Data?.Filesystem
    ?? record?.SourceMetadata?.Filesystem
    ?? null;
  const file = typeof filesystem?.file === 'string' && filesystem.file !== ''
    ? filesystem.file
    : null;
  const line = Number.isInteger(filesystem?.line) ? filesystem.line : null;
  if (file && line !== null) return `${detector} at ${file}:${line}`;
  if (file) return `${detector} at ${file}`;
  return detector;
}

async function commandAvailable(commandExists, bin) {
  try {
    return await commandExists(bin);
  } catch {
    return false;
  }
}

export async function runScanners({
  codeDirectory,
  proseFilePath,
  runCommand,
  commandExists,
}) {
  const findings = [];
  const advisories = [];
  const warnings = [];
  const surfaces = [
    ['code', codeDirectory],
    ['prose', proseFilePath],
  ];

  if (!await commandAvailable(commandExists, 'gitleaks')) {
    findings.push({
      check: 'gitleaks',
      surface: 'config',
      rule: 'gitleaks is unavailable, so credential scanning could not run',
    });
  } else {
    for (const [surface, target] of surfaces) {
      let result;
      try {
        result = await runCommand('gitleaks', [
          'dir', '--no-banner', '--no-color', '--redact=100',
          '--report-format', 'json', '--report-path', '-', target,
        ], { timeoutMs: 60_000 });
      } catch {
        findings.push({
          check: 'gitleaks',
          surface,
          rule: 'gitleaks could not run on this surface',
        });
        continue;
      }

      const parsed = parseJsonRecords(result?.stdout);
      if (!parsed.usable || (result?.code !== 0 && parsed.records.length === 0)) {
        findings.push({
          check: 'gitleaks',
          surface,
          rule: 'gitleaks did not return a usable scan result for this surface',
        });
        continue;
      }
      for (const record of parsed.records) {
        findings.push({ check: 'gitleaks', surface, rule: gitleaksRule(record) });
      }
    }
  }

  if (!await commandAvailable(commandExists, 'trufflehog')) {
    warnings.push('trufflehog is unavailable; advisory credential scanning was skipped');
  } else {
    for (const [surface, target] of surfaces) {
      let result;
      try {
        result = await runCommand('trufflehog', [
          '--json', '--no-update', '--no-verification', 'filesystem', target,
        ], { timeoutMs: 60_000 });
      } catch {
        warnings.push(`trufflehog could not run on the ${surface} surface`);
        continue;
      }

      const parsed = parseJsonRecords(result?.stdout);
      if (!parsed.usable || (result?.code !== 0 && parsed.records.length === 0)) {
        warnings.push(`trufflehog did not return a usable result for the ${surface} surface`);
        continue;
      }
      for (const record of parsed.records) {
        advisories.push({ check: 'trufflehog', surface, rule: trufflehogRule(record) });
      }
    }
  }

  return { ok: findings.length === 0, findings, advisories, warnings };
}

export async function runContextualReview({ proseFilePath, runVerifier }) {
  let result;
  try {
    result = await runVerifier(proseFilePath);
  } catch {
    return {
      ok: false,
      findings: [{
        check: 'contextual',
        surface: 'prose',
        rule: 'contextual review could not be launched',
      }],
    };
  }

  if (result?.code !== undefined && result.code !== 0) {
    return {
      ok: false,
      findings: [{
        check: 'contextual',
        surface: 'prose',
        rule: 'contextual review did not complete successfully',
      }],
    };
  }
  if (result?.verdict === 'CLEAN') return { ok: true, findings: [] };
  if (result?.verdict === 'CONFIDENTIAL') {
    return {
      ok: false,
      findings: [{
        check: 'contextual',
        surface: 'prose',
        rule: 'contextual review classified the prose as confidential',
      }],
    };
  }
  return {
    ok: false,
    findings: [{
      check: 'contextual',
      surface: 'prose',
      rule: 'contextual review returned no usable verdict',
    }],
  };
}

function readCodeSurface(directory) {
  const parts = [];
  const excludedRootFiles = new Set(HARNESS_ARTIFACTS);
  const visit = (current) => {
    const entries = readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
    for (const entry of entries) {
      const path = join(current, entry.name);
      const name = relative(directory, path).split('\\').join('/');
      if (name === '.git' || name.startsWith('.git/')) continue;
      if (!name.includes('/') && excludedRootFiles.has(name)) continue;
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        parts.push(name, readFileSync(path).toString('utf8'));
      } else if (entry.isSymbolicLink()) {
        // The link target is deliberately not followed, but its published path is still scanned.
        parts.push(name);
      }
    }
  };
  visit(directory);
  return parts.join('\n');
}

function finalContextualToken(text) {
  const line = String(text ?? '').split(/\r?\n/).findLast((item) => item.trim() !== '');
  if (line === undefined) return null;
  const token = line.trim().replace(/^[*_`]+|[*_`]+$/g, '');
  if (token === 'CLEAN' || token === 'CONFIDENTIAL') return token;
  return null;
}

function parseContextualVerdict(streamText) {
  let result = null;
  let assistant = null;
  let plan = null;
  for (const line of String(streamText ?? '').split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'result' && !event.is_error && typeof event.result === 'string') {
      result = event.result;
    }
    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      for (const part of event.message.content) {
        if (part?.type === 'text' && typeof part.text === 'string') assistant = part.text;
      }
    }
    const args = event.tool_call?.createPlanToolCall?.args;
    if (args && typeof args === 'object' && !Array.isArray(args)) {
      plan = [args.name, args.overview, args.plan]
        .filter((value) => typeof value === 'string')
        .join('\n');
    }
  }
  return finalContextualToken(result)
    ?? finalContextualToken(assistant)
    ?? finalContextualToken(plan);
}

async function runCursorContextualVerifier(proseFilePath, runCommand) {
  const proseName = basename(proseFilePath);
  const prompt = `Read ${proseName} and review it for credentials, personal data, customer identity, or non-public internal details. Do not repeat sensitive values. Make the final line exactly CLEAN or exactly CONFIDENTIAL.`;
  const result = await runCommand('agent', buildCursorArgs({ prompt }), {
    cwd: dirname(proseFilePath),
    timeoutMs: 60_000,
  });
  return {
    verdict: parseContextualVerdict(result?.stdout),
    text: '',
    code: result?.code,
  };
}

function emptyGuardResult() {
  return { ok: true, findings: [], advisories: [], warnings: [] };
}

export async function guardPublish({
  runDirectory,
  content,
  env = process.env,
  adapters = {},
}) {
  const result = emptyGuardResult();
  const prose = assembleProseSurface(content);
  const readFile = adapters.readFile ?? ((path) => readFileSync(path, 'utf8'));
  const writeFile = adapters.writeFile ?? writeFileSync;
  const removeFile = adapters.removeFile ?? rmSync;
  const baseRunCommand = adapters.runCommand ?? spawnCapture;
  const runCommand = (bin, args, options = {}) => baseRunCommand(bin, args, {
    ...options,
    env: options.env ?? env,
  });
  const hasCommand = adapters.commandExists
    ?? ((bin) => commandExists(bin, { env }));
  const codeReader = adapters.readCodeText ?? readCodeSurface;
  const proseFilePath = join(
    adapters.temporaryDirectory ?? tmpdir(),
    `ccc-publish-prose-${process.pid}-${(adapters.randomUUID ?? randomUUID)()}.txt`,
  );

  try {
    writeFile(proseFilePath, prose, { flag: 'wx', mode: 0o600 });

    let codeText = '';
    try {
      codeText = codeReader(runDirectory);
    } catch {
      result.findings.push({
        check: 'blocklist',
        surface: 'code',
        rule: 'the code surface could not be read for blocklist scanning',
      });
    }

    const blocklist = checkBlocklist({
      prose,
      codeText,
      blocklistPath: readEnv(env, 'PUBLISH_BLOCKLIST'),
      readFile,
    });
    result.findings.push(...blocklist.findings);

    const scanners = await runScanners({
      codeDirectory: runDirectory,
      proseFilePath,
      runCommand,
      commandExists: hasCommand,
    });
    result.findings.push(...scanners.findings);
    result.advisories.push(...scanners.advisories);
    result.warnings.push(...scanners.warnings);

    const verifier = adapters.runVerifier
      ?? ((path) => runCursorContextualVerifier(path, runCommand));
    const contextual = await runContextualReview({ proseFilePath, runVerifier: verifier });
    result.findings.push(...contextual.findings);
  } catch {
    result.findings.push({
      check: 'guard',
      surface: 'config',
      rule: 'the publish confidentiality guard could not complete',
    });
  } finally {
    try {
      removeFile(proseFilePath, { force: true });
    } catch {
      result.findings.push({
        check: 'guard',
        surface: 'config',
        rule: 'the temporary prose surface could not be removed',
      });
    }
  }

  result.ok = result.findings.length === 0;
  return result;
}
