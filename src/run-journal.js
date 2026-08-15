import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReportMarkdown } from './report.js';
import { reportEvent } from './events.js';

export const RUN_FACTS_FILENAME = 'ccc-runfacts.json';
export const EVENTS_FILENAME = 'events.jsonl';

const DEFAULT_PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolveRunFactsPath(inputPath) {
  const input = resolve(inputPath);
  const stat = statSync(input);
  if (!stat.isDirectory()) return input;

  const candidates = [
    join(input, RUN_FACTS_FILENAME),
    join(input, 'w', RUN_FACTS_FILENAME),
  ];
  const found = candidates.filter(existsSync);
  if (found.length === 1) return found[0];
  if (found.length > 1) {
    throw new Error(`run directory contains multiple ${RUN_FACTS_FILENAME} files: ${input}`);
  }
  throw new Error(`run directory does not contain ${RUN_FACTS_FILENAME}: ${input}`);
}

function parseEvents(eventsPath) {
  if (!existsSync(eventsPath)) return [];
  const events = [];
  const lines = readFileSync(eventsPath, 'utf8').split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].trim() === '') continue;
    try {
      events.push(JSON.parse(lines[index]));
    } catch (error) {
      throw new Error(`invalid JSON in ${eventsPath} at line ${index + 1}: ${error.message}`);
    }
  }
  return events;
}

export function readRunJournalInput(inputPath) {
  const factsPath = resolveRunFactsPath(inputPath);
  let facts;
  try {
    facts = JSON.parse(readFileSync(factsPath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${factsPath}: ${error.message}`);
  }
  if (!isObject(facts)) throw new TypeError(`${factsPath} must contain a JSON object`);
  if (typeof facts.runId !== 'string' || facts.runId === '') {
    throw new TypeError(`${factsPath} must contain a non-empty runId`);
  }
  if (!Array.isArray(facts.iterations)) {
    throw new TypeError(`${factsPath} must contain an iterations array`);
  }
  return {
    facts,
    factsPath,
    events: parseEvents(join(dirname(factsPath), EVENTS_FILENAME)),
  };
}

function normalizeTouchedFile(file) {
  if (typeof file !== 'string' || file.trim() === '') return null;
  if (/\r|\n/.test(file) || file.includes(']]')) {
    throw new TypeError(`changed file cannot be represented as an Obsidian wikilink: ${JSON.stringify(file)}`);
  }
  return file.replaceAll('\\', '/');
}

export function collectTouchedFiles(facts, events = []) {
  const files = [];
  const seen = new Set();
  const add = (candidate) => {
    const file = normalizeTouchedFile(candidate);
    if (file === null || seen.has(file)) return;
    seen.add(file);
    files.push(file);
  };

  for (const iteration of facts.iterations ?? []) {
    for (const file of iteration?.changedFiles ?? []) add(file);
  }
  for (const event of events) {
    if (event?.runId === facts.runId
      && event.stage === 'executor'
      && event.type === 'file_change') add(event.file);
  }
  return files;
}

function dateFor(facts) {
  const candidates = [facts.date, facts.runId];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const match = /^(\d{4}-\d{2}-\d{2})(?:T|$)/.exec(candidate);
    if (match) return match[1];
  }
  throw new TypeError('run facts must carry a YYYY-MM-DD date or a date-prefixed runId');
}

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function totalTokens(facts) {
  const recordedTotal = facts.tokens?.total;
  if (isObject(recordedTotal)) {
    return count(recordedTotal.inputTokens) + count(recordedTotal.outputTokens);
  }
  return count(facts.tokens?.executor?.inputTokens)
    + count(facts.tokens?.executor?.outputTokens)
    + count(facts.tokens?.verifier?.inputTokens)
    + count(facts.tokens?.verifier?.outputTokens);
}

function yamlScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') {
    return JSON.stringify(value).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new TypeError(`unsupported frontmatter value: ${typeof value}`);
}

function wikilink(file) {
  return `[[${file}]]`;
}

function frontmatterFor(facts, touchedFiles) {
  const lines = [
    '---',
    `runId: ${yamlScalar(facts.runId)}`,
    `date: ${dateFor(facts)}`,
    `outcome: ${yamlScalar(facts.outcome)}`,
    `gateStatus: ${yamlScalar(facts.gateStatus)}`,
    `verdict: ${yamlScalar(facts.verdict)}`,
    `intentVerdict: ${yamlScalar(facts.intentVerdict)}`,
    `verdictSource: ${yamlScalar(facts.verdictSource)}`,
    `tokensTotal: ${totalTokens(facts)}`,
    `branch: ${yamlScalar(facts.branch)}`,
  ];
  if (touchedFiles.length === 0) {
    lines.push('filesChanged: []');
  } else {
    lines.push('filesChanged:');
    for (const file of touchedFiles) lines.push(`  - ${yamlScalar(wikilink(file))}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

export function buildRunJournalNote(facts, events = []) {
  if (!isObject(facts)) throw new TypeError('run facts must be an object');
  if (typeof facts.runId !== 'string' || facts.runId === '') {
    throw new TypeError('run facts must contain a non-empty runId');
  }
  if (!Array.isArray(facts.iterations)) {
    throw new TypeError('run facts must contain an iterations array');
  }
  const touchedFiles = collectTouchedFiles(facts, events);
  const body = buildReportMarkdown(facts, {
    changedFiles: touchedFiles,
    formatChangedFile: wikilink,
    tokenStyle: 'table',
  });
  return `${frontmatterFor(facts, touchedFiles)}${body}`;
}

function notePathFor(projectRoot, runId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || runId === '.' || runId === '..') {
    throw new TypeError(`runId is not safe as a note filename: ${JSON.stringify(runId)}`);
  }
  const runsDir = resolve(projectRoot, 'docs', 'runs');
  const notePath = resolve(runsDir, `${runId}.md`);
  const fromRunsDir = relative(runsDir, notePath);
  if (fromRunsDir.startsWith('..') || isAbsolute(fromRunsDir)) {
    throw new Error(`refusing to write a run note outside ${runsDir}`);
  }
  return { notePath, runsDir };
}

function journalIdentity(facts, supplied) {
  if (supplied !== undefined) return supplied;
  if (typeof facts.campaignId !== 'string' || facts.campaignId === '') return undefined;
  return {
    campaignId: facts.campaignId,
    round: facts.round,
    unitId: facts.unitId ?? facts.runId,
    unitKind: facts.unitKind,
  };
}

function writeRunJournalInput({ facts, factsPath, events }, { reporter, identity } = {}) {
  const { notePath, runsDir } = notePathFor(DEFAULT_PROJECT_ROOT, facts.runId);
  const eventIdentity = journalIdentity(facts, identity);
  reportEvent(reporter, facts.runId, 'journal', 'start', { factsPath }, eventIdentity);
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(notePath, buildRunJournalNote(facts, events), 'utf8');
  reportEvent(reporter, facts.runId, 'journal', 'finish', {
    file: relative(DEFAULT_PROJECT_ROOT, notePath).replaceAll('\\', '/'),
    notePath,
  }, eventIdentity);
  return { factsPath, notePath, runId: facts.runId };
}

export function generateRunJournal(inputPath, options) {
  return writeRunJournalInput(readRunJournalInput(inputPath), options);
}

export function findRunFacts(scratchRoot) {
  const root = resolve(scratchRoot);
  if (!statSync(root).isDirectory()) throw new TypeError(`scratch root is not a directory: ${root}`);
  const found = [];
  const visit = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === RUN_FACTS_FILENAME) found.push(path);
    }
  };
  visit(root);
  return found;
}

export function generateRunJournalCampaign(scratchRoot, { reporter, reporterFactory } = {}) {
  const factsPaths = findRunFacts(scratchRoot);
  const inputs = factsPaths.map(readRunJournalInput);
  const runIds = new Set();
  for (const { facts } of inputs) {
    if (runIds.has(facts.runId)) {
      throw new Error(`scratch root contains duplicate runId: ${facts.runId}`);
    }
    runIds.add(facts.runId);
  }
  return inputs.map((input) => {
    let unitReporter = reporter;
    if (typeof reporterFactory === 'function') {
      try { unitReporter = reporterFactory(input.facts); } catch { unitReporter = undefined; }
    }
    return writeRunJournalInput(input, { reporter: unitReporter });
  });
}
