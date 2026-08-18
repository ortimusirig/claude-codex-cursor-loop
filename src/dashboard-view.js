import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { CCC_DASHBOARD_MARKER } from './dashboard-config.js';
import { CAMPAIGN_EVENTS_FILENAME, readEventStream } from './event-stream.js';
import { addUsage, EMPTY_USAGE } from './usage.js';

export const DEFAULT_SESSION_THRESHOLD_HOURS = 2;
export const MAX_RENDERED_DIFF_BYTES = 128 * 1024;

const TASK_TITLE_MAX_LENGTH = 70;
const TASK_TITLE_MIN_PUNCTUATION_LENGTH = 20;

function emptyUsage() {
  return { ...EMPTY_USAGE };
}

function emptyDiff() {
  return {
    path: null,
    text: '',
    byteCount: 0,
    renderedByteCount: 0,
    capped: false,
    message: 'CHANGES.diff is not available yet.',
  };
}

function emptyRun(directory, overrides = {}) {
  const run = {
    directory,
    worktreeDirectory: basename(directory).toLowerCase() === 'w'
      ? directory
      : join(directory, 'w'),
    eventsPath: null,
    runId: basename(directory),
    title: null,
    projectPath: null,
    correctsRunId: null,
    state: 'waiting',
    message: 'Waiting for the event stream to appear.',
    startTs: null,
    endTs: null,
    currentStage: null,
    currentType: null,
    lastEventTs: null,
    timeline: [],
    verifiers: { correctness: null, intent: null },
    files: [],
    filesChanged: [],
    gateCommands: [],
    gateResult: 'pending',
    tokens: {
      executor: emptyUsage(),
      correctness: emptyUsage(),
      intent: emptyUsage(),
    },
    stalls: [],
    executorRationale: null,
    diff: emptyDiff(),
    ...overrides,
  };
  return addTriageFacts(run);
}

function readRunFacts(eventsPath) {
  if (eventsPath === null) return null;
  const factsPath = join(dirname(eventsPath), 'ccc-runfacts.json');
  if (!existsSync(factsPath)) return null;
  try {
    const facts = JSON.parse(readFileSync(factsPath, { encoding: 'utf8', flag: 'r' }));
    return facts && typeof facts === 'object' && !Array.isArray(facts) ? facts : null;
  } catch {
    // Facts can be observed between truncate and the completed write. Retain the
    // event-derived state and pick up the complete document on the next poll.
    return null;
  }
}

function consistencyStatus(value) {
  if (typeof value === 'string') return value;
  return value?.status ?? null;
}

function enrichFromFacts(verifiers, facts) {
  if (facts === null) return { verifiers, executorRationale: null };
  const iteration = Array.isArray(facts.iterations) ? facts.iterations.at(-1) : null;
  const completed = {
    correctness: {
      verdict: iteration?.verifier?.verdict ?? facts.verdict ?? null,
      verdictSource: iteration?.verifier?.verdictSource ?? facts.verdictSource ?? null,
      verdictConsistency: consistencyStatus(iteration?.verifier?.verdictConsistency)
        ?? consistencyStatus(facts.verifierConsistency),
      findings: facts.verifierFindings ?? iteration?.verifier?.findings ?? null,
    },
    intent: {
      verdict: iteration?.intentVerifier?.verdict ?? facts.intentVerdict ?? null,
      verdictSource: iteration?.intentVerifier?.verdictSource
        ?? facts.intentVerdictSource
        ?? null,
      verdictConsistency: consistencyStatus(iteration?.intentVerifier?.verdictConsistency)
        ?? consistencyStatus(facts.intentVerifierConsistency),
      findings: facts.intentVerifierFindings ?? iteration?.intentVerifier?.findings ?? null,
    },
  };
  for (const pass of ['correctness', 'intent']) {
    if (verifiers[pass] !== null || completed[pass].verdict !== null
      || completed[pass].findings !== null) {
      completed[pass] = { ...(verifiers[pass] ?? {}), ...completed[pass] };
    } else {
      completed[pass] = null;
    }
  }
  return {
    verifiers: completed,
    executorRationale: iteration?.lastMessage ?? null,
  };
}

function readDiffPreview(worktreeDirectory, maxBytes = MAX_RENDERED_DIFF_BYTES) {
  const path = join(worktreeDirectory, 'CHANGES.diff');
  let byteCount;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return emptyDiff();
    byteCount = stat.size;
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyDiff();
    return { ...emptyDiff(), path, message: `Cannot read CHANGES.diff: ${error.message}` };
  }

  const wanted = Math.min(byteCount, maxBytes);
  const buffer = Buffer.alloc(wanted);
  let descriptor;
  let offset = 0;
  try {
    descriptor = openSync(path, 'r');
    while (offset < wanted) {
      const count = readSync(descriptor, buffer, offset, wanted - offset, offset);
      if (count === 0) break;
      offset += count;
    }
  } catch (error) {
    return { ...emptyDiff(), path, byteCount, message: `Cannot read CHANGES.diff: ${error.message}` };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return {
    path,
    text: buffer.subarray(0, offset).toString('utf8'),
    byteCount,
    renderedByteCount: offset,
    capped: byteCount > offset,
    message: null,
  };
}

function validTimestamp(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function verdictPresentation(verifier) {
  if (verifier === null) return { kind: 'pending', text: 'Pending — unknown' };
  if (verifier.verdictSource === 'none') {
    return {
      kind: 'unknown',
      text: 'No verdict — unknown (ISSUES is a fail-safe, not a finding)',
    };
  }
  if (verifier.verdict === 'ISSUES') {
    return { kind: 'issues', text: 'ISSUES — reviewer found a problem' };
  }
  if (verifier.verdict === 'NO_BLOCKERS') {
    return { kind: 'clean', text: 'NO_BLOCKERS — fine' };
  }
  return { kind: 'pending', text: `${verifier.verdict ?? 'Pending'} — unknown` };
}

export function runNeedsAttention(run) {
  return run?.gateResult === 'failed'
    || ['correctness', 'intent'].some((pass) => (
      run?.verifiers?.[pass]?.verdict === 'ISSUES'
      || run?.verifiers?.[pass]?.verdictSource === 'none'
    ));
}

function addTriageFacts(run) {
  const triage = {
    gate: run.gateResult === 'passed'
      ? { kind: 'clean', text: 'Passed — fine' }
      : run.gateResult === 'failed'
        ? { kind: 'issues', text: 'Failed — needs attention' }
        : { kind: 'pending', text: 'Pending — not complete' },
    correctness: verdictPresentation(run.verifiers.correctness),
    intent: verdictPresentation(run.verifiers.intent),
  };
  return { ...run, triage, needsAttention: runNeedsAttention(run) };
}

function firstTimestamp(events) {
  for (const event of events) {
    if (validTimestamp(event?.ts) !== null) return event.ts;
  }
  return null;
}

function lastTimestamp(events) {
  for (let index = events.length - 1; index >= 0; index--) {
    if (validTimestamp(events[index]?.ts) !== null) return events[index].ts;
  }
  return null;
}

export function extractTaskTitle(text) {
  if (typeof text !== 'string') return null;
  const lines = text.split(/\r?\n/);
  let index = lines[0] === '# Task' ? 1 : 0;
  while (index < lines.length && lines[index].trim() === '') index += 1;
  if (index === lines.length) return null;

  const explicitTitle = /^Title:\s*(.+)$/.exec(lines[index]);
  const candidate = explicitTitle ? explicitTitle[1] : lines[index];
  const title = candidate
    .replaceAll('`', '')
    .replace(/^#+(?:\s*Task\s*[:—-])?\s+/, '')
    .trim();
  if (title === '') return null;
  if (title.length <= TASK_TITLE_MAX_LENGTH) return title;

  const contentLimit = TASK_TITLE_MAX_LENGTH - 1;
  for (let punctuationIndex = contentLimit - 1;
    punctuationIndex >= TASK_TITLE_MIN_PUNCTUATION_LENGTH - 1;
    punctuationIndex--) {
    if (/[.:;—]/.test(title[punctuationIndex])) {
      return `${title.slice(0, punctuationIndex + 1).trimEnd()}…`;
    }
  }

  let wordBoundary = contentLimit;
  while (wordBoundary > 0 && !/\s/.test(title[wordBoundary])) wordBoundary -= 1;
  const truncated = wordBoundary > 0
    ? title.slice(0, wordBoundary).trimEnd()
    : title.slice(0, contentLimit).trimEnd();
  return `${truncated}…`;
}

function readTaskTitle(directory) {
  const taskPath = existsSync(join(directory, 'TASK.md'))
    ? join(directory, 'TASK.md')
    : join(directory, 'w', 'TASK.md');
  try {
    return extractTaskTitle(readFileSync(taskPath, { encoding: 'utf8', flag: 'r' }));
  } catch {
    return null;
  }
}

function digestRunDirectory(runDirectory) {
  const directory = resolve(runDirectory);
  const title = readTaskTitle(directory);
  let stream;
  try {
    stream = readEventStream(directory, { allowMissing: true });
  } catch (error) {
    return emptyRun(directory, {
      title,
      state: 'error',
      message: `Cannot read event stream: ${error.message}`,
    });
  }

  if (!stream.directoryExists) {
    return emptyRun(directory, {
      runId: stream.runId,
      title,
      message: `Run directory does not exist yet: ${directory}`,
    });
  }
  if (stream.eventsPath === null) {
    return emptyRun(directory, {
      runId: stream.runId,
      title,
      message: `Run directory exists; waiting for events.jsonl: ${directory}`,
    });
  }

  const events = stream.events.filter((event) => event?.runId === stream.runId);
  const tokens = {
    executor: emptyUsage(),
    correctness: emptyUsage(),
    intent: emptyUsage(),
  };
  const verifiers = { correctness: null, intent: null };
  const files = [];
  const gateCommands = [];
  const stalls = [];
  let gateResult = 'pending';

  for (const event of events) {
    if (event.stage === 'executor' && event.type === 'finish') {
      tokens.executor = addUsage(tokens.executor, event.tokens);
    }
    if (event.stage === 'verify' && event.type === 'finish'
      && (event.pass === 'correctness' || event.pass === 'intent')) {
      tokens[event.pass] = addUsage(tokens[event.pass], event.tokens);
      verifiers[event.pass] = {
        verdict: event.verdict ?? null,
        verdictSource: event.source ?? event.verdictSource ?? null,
        verdictConsistency: consistencyStatus(event.verdictConsistency),
        findings: null,
        code: event.code ?? null,
        timedOut: event.timedOut === true,
        ts: event.ts ?? null,
      };
    }
    if (event.stage === 'executor' && event.type === 'file_change'
      && typeof event.file === 'string') {
      files.push({ file: event.file, attempt: event.attempt ?? null, ts: event.ts ?? null });
    }
    if (event.stage === 'gate' && event.type === 'gate_command') {
      gateCommands.push({
        bin: event.bin ?? '',
        args: Array.isArray(event.args) ? event.args : [],
        code: event.code ?? null,
        attempt: event.attempt ?? null,
        timedOut: event.timedOut === true,
        ts: event.ts ?? null,
      });
    }
    if (event.stage === 'gate' && event.type === 'finish') {
      gateResult = event.verdict === 'passed' ? 'passed'
        : event.verdict === 'failed' ? 'failed' : gateResult;
    }
    if (event.type === 'stalled') stalls.push(event);
  }

  const facts = readRunFacts(stream.eventsPath);
  const completedDetails = enrichFromFacts(verifiers, facts);
  if (gateResult === 'pending' && (facts?.gateStatus === 'passed' || facts?.gateStatus === 'failed')) {
    gateResult = facts.gateStatus;
  }
  if (gateResult === 'pending' && gateCommands.some((command) => (
    command.timedOut || (command.code !== null && command.code !== 0)
  ))) {
    gateResult = 'failed';
  }
  const lastEvent = events.at(-1) ?? null;
  const finished = events.some((event) => event.stage === 'report' && event.type === 'finish');
  const worktreeDirectory = dirname(stream.eventsPath);
  return addTriageFacts({
    directory,
    worktreeDirectory,
    eventsPath: stream.eventsPath,
    runId: stream.runId,
    title,
    projectPath: events.find((event) => event.stage === 'isolate' && event.type === 'start'
      && typeof event.source === 'string')?.source ?? null,
    correctsRunId: events.find((event) => event.stage === 'isolate' && event.type === 'start'
      && typeof event.correctsRunId === 'string')?.correctsRunId ?? null,
    state: finished ? 'finished' : events.length > 0 ? 'running' : 'waiting',
    message: events.length > 0 ? null : 'Event stream is empty; waiting for the first event.',
    startTs: firstTimestamp(events),
    endTs: lastTimestamp(events),
    currentStage: lastEvent?.stage ?? null,
    currentType: lastEvent?.type ?? null,
    lastEventTs: lastEvent?.ts ?? null,
    timeline: events.map((event) => ({
      ts: event.ts ?? null,
      stage: event.stage ?? 'unknown',
      type: event.type ?? 'unknown',
      attempt: event.attempt ?? null,
      pass: event.pass ?? null,
      verdict: event.verdict ?? null,
    })),
    verifiers: completedDetails.verifiers,
    files,
    filesChanged: [...new Set(files.map((file) => file.file))],
    gateCommands,
    gateResult,
    tokens,
    stalls,
    executorRationale: completedDetails.executorRationale,
    diff: readDiffPreview(worktreeDirectory),
  });
}

export function inferSessions(runs, thresholdHours = DEFAULT_SESSION_THRESHOLD_HOURS) {
  if (!Number.isFinite(thresholdHours) || thresholdHours < 0) {
    throw new TypeError('session threshold must be a non-negative number of hours');
  }
  const indexed = runs.map((run, index) => ({ run, index, time: validTimestamp(run.startTs) }));
  indexed.sort((left, right) => {
    if (left.time === null && right.time === null) return left.index - right.index;
    if (left.time === null) return 1;
    if (right.time === null) return -1;
    return right.time - left.time || right.run.runId.localeCompare(left.run.runId);
  });
  const thresholdMs = thresholdHours * 60 * 60 * 1000;
  const sessions = [];
  let current = null;
  for (const item of indexed) {
    const separate = current === null
      || item.time === null
      || current.lastStartMs === null
      || current.lastStartMs - item.time > thresholdMs;
    if (separate) {
      current = { runs: [], lastStartMs: item.time };
      sessions.push(current);
    }
    current.runs.push(item.run);
    current.lastStartMs = item.time;
  }
  return sessions.map((session, index) => {
    const starts = session.runs.map((run) => validTimestamp(run.startTs)).filter((time) => time !== null);
    const ends = session.runs.map((run) => validTimestamp(run.endTs)).filter((time) => time !== null);
    const startMs = starts.length > 0 ? Math.min(...starts) : null;
    const endMs = ends.length > 0 ? Math.max(...ends) : startMs;
    return {
      id: `session-${index + 1}-${session.runs[0]?.runId ?? 'empty'}`,
      startTs: startMs === null ? null : new Date(startMs).toISOString(),
      endTs: endMs === null ? null : new Date(endMs).toISOString(),
      durationMs: startMs === null || endMs === null ? null : Math.max(0, endMs - startMs),
      passCount: session.runs.length,
      attentionCount: session.runs.filter((run) => run.needsAttention ?? runNeedsAttention(run)).length,
      runs: session.runs,
    };
  });
}

export function groupRunsByProject(runs) {
  const byPath = new Map();
  runs.forEach((run, index) => {
    const projectPath = typeof run.projectPath === 'string' ? run.projectPath : null;
    const group = byPath.get(projectPath) ?? {
      projectPath,
      name: projectPath === null ? 'Unknown project' : basename(projectPath),
      runs: [],
      latestStartMs: null,
      firstIndex: index,
      attentionCount: 0,
    };
    const startMs = validTimestamp(run.startTs);
    group.runs.push(run);
    if (startMs !== null && (group.latestStartMs === null || startMs > group.latestStartMs)) {
      group.latestStartMs = startMs;
    }
    if (run.needsAttention ?? runNeedsAttention(run)) group.attentionCount += 1;
    byPath.set(projectPath, group);
  });
  return [...byPath.values()].sort((left, right) => {
    if (left.latestStartMs === null && right.latestStartMs === null) {
      return left.firstIndex - right.firstIndex;
    }
    if (left.latestStartMs === null) return 1;
    if (right.latestStartMs === null) return -1;
    return right.latestStartMs - left.latestStartMs || left.firstIndex - right.firstIndex;
  });
}

export function buildDashboardSnapshot({ runDirectory, scratchRoot } = {}) {
  if (Boolean(runDirectory) === Boolean(scratchRoot)) {
    throw new TypeError('dashboard requires exactly one of runDirectory or scratchRoot');
  }
  const observedAt = new Date().toISOString();
  if (runDirectory) {
    const sourcePath = resolve(runDirectory);
    const runs = [digestRunDirectory(sourcePath)];
    return { mode: 'run', sourcePath, observedAt, message: null, runs };
  }

  const sourcePath = resolve(scratchRoot);
  let entries;
  try {
    const stat = statSync(sourcePath);
    if (!stat.isDirectory()) {
      return {
        mode: 'scratch', sourcePath, observedAt,
        message: `Scratch root is not a directory: ${sourcePath}`,
        runs: [],
      };
    }
    entries = readdirSync(sourcePath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => right.name.localeCompare(left.name));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        mode: 'scratch', sourcePath, observedAt,
        message: `Scratch root does not exist yet: ${sourcePath}`,
        runs: [],
      };
    }
    return {
      mode: 'scratch', sourcePath, observedAt,
      message: `Cannot read scratch root: ${error.message}`,
      runs: [],
    };
  }

  const runs = [];
  for (const entry of entries) {
    const directory = join(sourcePath, entry.name);
    const campaignPath = join(directory, CAMPAIGN_EVENTS_FILENAME);
    const hasCampaignStream = existsSync(campaignPath);
    const hasRunStream = existsSync(join(directory, 'events.jsonl'))
      || existsSync(join(directory, 'w', 'events.jsonl'));
    if (!hasCampaignStream || hasRunStream) runs.push(digestRunDirectory(directory));
  }
  return {
    mode: 'scratch',
    sourcePath,
    observedAt,
    message: runs.length === 0 ? 'No run directories found yet.' : null,
    runs,
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return 'unknown';
  const safe = Math.max(0, Math.floor(ms));
  if (safe < 1000) return `${safe} ms`;
  const seconds = Math.floor(safe / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function shortTime(ts) {
  const parsed = validTimestamp(ts);
  return parsed === null ? '--:--:--' : new Date(parsed).toISOString().slice(11, 19);
}

function fullTime(ts) {
  const parsed = validTimestamp(ts);
  return parsed === null ? 'time unknown' : new Date(parsed).toISOString().replace('T', ' ').replace('Z', ' UTC');
}

function shortRunId(runId) {
  if (runId.length <= 18) return runId;
  return `${runId.slice(0, 10)}…${runId.slice(-7)}`;
}

function attempt(value) {
  return value === null || value === undefined ? '' : ` · attempt ${escapeHtml(value)}`;
}

function usageText(usage) {
  return `in ${usage.inputTokens} · cached ${usage.cachedInputTokens} · out ${usage.outputTokens}`
    + ` · reasoning ${usage.reasoningOutputTokens} · cache write ${usage.cacheWriteTokens}`;
}

function triageExplanation(checkType, kind, text) {
  if (checkType === 'gate') {
    if (kind === 'clean' && text === 'Passed — fine') {
      return 'All automated checks completed successfully.';
    }
    if (kind === 'issues' && text === 'Failed — needs attention') {
      return 'One or more automated checks failed, so this pass needs attention.';
    }
    if (kind === 'pending' && text === 'Pending — not complete') {
      return 'The automated checks have not finished yet.';
    }
  }

  if (checkType === 'correctness') {
    if (kind === 'pending' && text === 'Pending — unknown') {
      return 'The code-quality review has not run yet, so whether the code has defects is unknown.';
    }
    if (kind === 'unknown' && text === 'No verdict — unknown (ISSUES is a fail-safe, not a finding)') {
      return 'The code-quality review did not return a usable result; ISSUES is shown as a precaution, not because a defect was found.';
    }
    if (kind === 'issues' && text === 'ISSUES — reviewer found a problem') {
      return 'The code-quality review found a possible defect in the code.';
    }
    if (kind === 'clean' && text === 'NO_BLOCKERS — fine') {
      return 'The code-quality review did not find defects that would block this pass.';
    }
    if (kind === 'pending' && text.endsWith(' — unknown')) {
      return `The code-quality review returned "${text}", which the dashboard does not recognize, so whether the code has defects is unknown.`;
    }
  }

  if (checkType === 'intent') {
    if (kind === 'pending' && text === 'Pending — unknown') {
      return 'The task-intent review has not run yet, so it is unknown whether the changes meet TASK.md and whether new assertions would catch broken behavior.';
    }
    if (kind === 'unknown' && text === 'No verdict — unknown (ISSUES is a fail-safe, not a finding)') {
      return 'The task-intent review did not return a usable result; ISSUES is shown as a precaution, not because a mismatch with TASK.md or a weak assertion was found.';
    }
    if (kind === 'issues' && text === 'ISSUES — reviewer found a problem') {
      return 'The task-intent review found that the changes may not meet TASK.md or that new assertions may not catch broken behavior.';
    }
    if (kind === 'clean' && text === 'NO_BLOCKERS — fine') {
      return 'The task-intent review found no problem with whether the changes meet TASK.md or whether new assertions would catch broken behavior.';
    }
    if (kind === 'pending' && text.endsWith(' — unknown')) {
      return `The task-intent review returned "${text}", which the dashboard does not recognize, so it is unknown whether the changes meet TASK.md and whether new assertions would catch broken behavior.`;
    }
  }

  throw new Error(`Unknown triage presentation: ${checkType}/${kind}/${text}`);
}

function renderTriageState(checkType, presentation) {
  const explanation = triageExplanation(checkType, presentation.kind, presentation.text);
  return `<span class="result ${escapeHtml(presentation.kind)}" data-result-kind="${escapeHtml(presentation.kind)}"`
    + ` title="${escapeHtml(explanation)}">${escapeHtml(presentation.text)}</span>`;
}

function orderCorrectionRows(sessionRuns, allRunsById) {
  const sessionById = new Map(sessionRuns.map((run) => [run.runId, run]));
  const parentById = new Map();
  for (const run of sessionRuns) {
    if (typeof run.correctsRunId === 'string'
      && allRunsById.has(run.correctsRunId)
      && sessionById.has(run.correctsRunId)) {
      parentById.set(run.runId, run.correctsRunId);
    }
  }

  const cycleRunIds = new Set();
  for (const run of sessionRuns) {
    const path = [];
    const positionById = new Map();
    let currentRunId = run.runId;
    for (let steps = 0; steps <= sessionRuns.length && parentById.has(currentRunId); steps++) {
      const cycleStart = positionById.get(currentRunId);
      if (cycleStart !== undefined) {
        for (const cycleRunId of path.slice(cycleStart)) cycleRunIds.add(cycleRunId);
        break;
      }
      positionById.set(currentRunId, path.length);
      path.push(currentRunId);
      currentRunId = parentById.get(currentRunId);
    }
  }

  const childrenById = new Map();
  const nestedRunIds = new Set();
  for (const run of sessionRuns) {
    const parentRunId = parentById.get(run.runId);
    if (parentRunId === undefined || cycleRunIds.has(run.runId)) continue;
    const children = childrenById.get(parentRunId) ?? [];
    children.push(run);
    childrenById.set(parentRunId, children);
    nestedRunIds.add(run.runId);
  }

  const ordered = [];
  const emitted = new Set();
  const emitTree = (root) => {
    const stack = [{ run: root, depth: 0 }];
    while (stack.length > 0) {
      const item = stack.pop();
      if (emitted.has(item.run.runId)) continue;
      emitted.add(item.run.runId);
      ordered.push(item);
      const children = childrenById.get(item.run.runId) ?? [];
      for (let index = children.length - 1; index >= 0; index--) {
        stack.push({ run: children[index], depth: item.depth + 1 });
      }
    }
  };
  for (const run of sessionRuns) {
    if (!nestedRunIds.has(run.runId)) emitTree(run);
  }
  for (const run of sessionRuns) {
    if (!emitted.has(run.runId)) ordered.push({ run, depth: 0 });
  }
  return ordered;
}

function renderPassRow(run, attentionOnly, correctionDepth = 0) {
  const hidden = attentionOnly && !run.needsAttention ? ' hidden' : '';
  const files = run.filesChanged.length === 0 ? '0 files'
    : `${run.filesChanged.length} ${run.filesChanged.length === 1 ? 'file' : 'files'}`;
  const shortId = `<code title="${escapeHtml(run.runId)}">${escapeHtml(shortRunId(run.runId))}</code>`;
  const correction = typeof run.correctsRunId === 'string'
    ? `<small class="correction-note">corrects <code title="${escapeHtml(run.correctsRunId)}">`
      + `${escapeHtml(shortRunId(run.correctsRunId))}</code></small>`
    : '';
  const identity = typeof run.title === 'string' && run.title.length > 0
    ? `<span class="pass-identity"><b title="${escapeHtml(run.title)}">${escapeHtml(run.title)}</b>`
      + `<small>${shortId}</small>${correction}</span>`
    : correction ? `<span class="pass-identity">${shortId}${correction}</span>` : shortId;
  return `<tr class="pass-row${run.needsAttention ? ' attention' : ' clean'}" data-run-id="${escapeHtml(run.runId)}"`
    + ` data-correction-depth="${correctionDepth}" data-needs-attention="${run.needsAttention}"`
    + ` style="--correction-depth:${correctionDepth}"${hidden}>`
    + `<td><button class="pass-detail" type="button" data-detail-run="${escapeHtml(run.runId)}">`
    + `${escapeHtml(shortTime(run.startTs))}</button></td>`
    + `<td>${identity}</td>`
    + `<td>${renderTriageState('gate', run.triage.gate)}</td>`
    + `<td>${renderTriageState('correctness', run.triage.correctness)}</td>`
    + `<td>${renderTriageState('intent', run.triage.intent)}</td>`
    + `<td title="${escapeHtml(run.filesChanged.join(', '))}">${escapeHtml(files)}</td></tr>`;
}

function renderSessions(runs, thresholdHours, attentionOnly, allRuns = runs) {
  const sessions = inferSessions(runs, thresholdHours);
  const allRunsById = new Map(allRuns.map((run) => [run.runId, run]));
  if (sessions.length === 0) return '<section class="empty">No passes to group into sessions.</section>';
  const allFiltered = attentionOnly && sessions.every((session) => session.attentionCount === 0);
  const filterMessage = allFiltered
    ? '<section class="empty filter-empty">No passes need attention. Turn off the filter to see clean passes.</section>'
    : '';
  return filterMessage + sessions.map((session) => {
    const hidden = attentionOnly && session.attentionCount === 0 ? ' hidden' : '';
    const headlineTitle = session.runs[0]?.title ?? null;
    const differentTitleCount = headlineTitle === null ? 0 : session.runs.slice(1)
      .filter((run) => run.title !== null && run.title !== undefined && run.title !== headlineTitle)
      .length;
    const headline = headlineTitle === null
      ? fullTime(session.startTs)
      : `${headlineTitle}${differentTitleCount > 0 ? ` +${differentTitleCount} more` : ''}`;
    return `<details class="session" data-attention-count="${session.attentionCount}"${hidden}>`
      + `<summary><span><b${headlineTitle === null ? '' : ` title="${escapeHtml(headline)}"`}>`
      + `${escapeHtml(headline)}</b>`
      + `<small>${escapeHtml(fullTime(session.startTs))} · ${escapeHtml(formatDuration(session.durationMs))}</small></span>`
      + `<span>${session.passCount} ${session.passCount === 1 ? 'pass' : 'passes'}</span>`
      + `<strong>${session.attentionCount} need${session.attentionCount === 1 ? 's' : ''} attention</strong></summary>`
      + '<div class="pass-table-wrap"><table class="passes"><thead><tr><th>Time</th><th>Pass</th>'
      + '<th>Gate</th><th>Correctness</th><th>Intent</th><th>Files changed</th></tr></thead><tbody>'
      + orderCorrectionRows(session.runs, allRunsById)
        .map(({ run, depth }) => renderPassRow(run, attentionOnly, depth)).join('')
      + '</tbody></table></div></details>';
  }).join('');
}

function renderProjects(runs, thresholdHours, attentionOnly) {
  const projects = groupRunsByProject(runs);
  if (projects.length <= 1) return renderSessions(runs, thresholdHours, attentionOnly, runs);
  const allFiltered = attentionOnly && projects.every((project) => project.attentionCount === 0);
  const filterMessage = allFiltered
    ? '<section class="empty filter-empty">No passes need attention. Turn off the filter to see clean passes.</section>'
    : '';
  return filterMessage + projects.map((project) => {
    const hidden = attentionOnly && project.attentionCount === 0 ? ' hidden' : '';
    const subtitle = project.projectPath ?? 'Unknown project';
    return `<details class="project" data-project-path="${escapeHtml(project.projectPath ?? '')}"`
      + ` data-attention-count="${project.attentionCount}"${hidden}>`
      + `<summary><span><b>${escapeHtml(project.name)}</b><small>${escapeHtml(subtitle)}</small></span>`
      + `<span>${project.runs.length} ${project.runs.length === 1 ? 'pass' : 'passes'}</span>`
      + `<strong>${project.attentionCount} need${project.attentionCount === 1 ? 's' : ''} attention</strong></summary>`
      + `<div class="project-sessions">${renderSessions(project.runs, thresholdHours, attentionOnly, runs)}</div></details>`;
  }).join('');
}

export function renderSessionList(
  runs,
  thresholdHours = DEFAULT_SESSION_THRESHOLD_HOURS,
  attentionOnly = true,
) {
  return renderSessions(runs, thresholdHours, attentionOnly);
}

export function renderProjectList(
  runs,
  thresholdHours = DEFAULT_SESSION_THRESHOLD_HOURS,
  attentionOnly = true,
) {
  return renderProjects(runs, thresholdHours, attentionOnly);
}

function renderTriage(snapshot) {
  return '<section id="triage-view" class="view-panel" data-view-panel="triage">'
    + '<div class="controls"><label class="toggle"><input id="attention-only" type="checkbox" checked> Show needs-attention passes only</label></div>'
    + `<div id="sessions">${renderProjects(snapshot.runs, DEFAULT_SESSION_THRESHOLD_HOURS, true)}</div></section>`;
}

function renderVerifier(name, verifier) {
  if (verifier === null) {
    return `<div class="verifier pending"><b>${escapeHtml(name)}</b><span>Pending — unknown</span></div>`;
  }
  const source = verifier.verdictSource ?? 'unknown';
  const consistency = verifier.verdictConsistency ?? 'not recorded';
  const findings = verifier.findings ?? '(findings are recorded when the run report completes)';
  const findingsHeading = source === 'none'
    ? `${name} retained output (not authoritative reviewer findings)`
    : `${name} findings`;
  const detail = `<div class="verifier-findings"><h4>${escapeHtml(findingsHeading)}</h4>`
    + `<pre>${escapeHtml(findings)}</pre></div>`;
  if (source === 'none') {
    return '<div class="verifier fail-safe" data-verdict-kind="fail-safe">'
      + `<b>${escapeHtml(name)}</b><strong>No verdict — unknown</strong>`
      + `<span>Recorded fail-safe value: ${escapeHtml(verifier.verdict ?? 'ISSUES')}</span>`
      + '<span>verdictSource: none</span>'
      + `<span>Consistency: ${escapeHtml(consistency)}</span>`
      + '<em>No verdict marker found — ISSUES is a fail-safe, not a reviewer finding.</em>'
      + `${detail}</div>`;
  }
  const finding = verifier.verdict === 'ISSUES'
    ? 'Reviewer reported ISSUES — a real problem'
    : verifier.verdict === 'NO_BLOCKERS' ? 'NO_BLOCKERS — fine' : 'Reviewer verdict';
  return '<div class="verifier reviewer" data-verdict-kind="reviewer">'
    + `<b>${escapeHtml(name)}</b><strong>${escapeHtml(verifier.verdict ?? 'unknown')}</strong>`
    + `<span>verdictSource: ${escapeHtml(source)}</span>`
    + `<span>Consistency: ${escapeHtml(consistency)}</span><em>${finding}</em>${detail}</div>`;
}

function renderTimeline(timeline) {
  if (timeline.length === 0) return '<p class="muted">No stages emitted yet.</p>';
  return `<ol class="timeline">${timeline.map((event) => {
    const details = [
      event.pass ? `pass ${escapeHtml(event.pass)}` : '',
      event.verdict ? `verdict ${escapeHtml(event.verdict)}` : '',
      event.attempt === null ? '' : `attempt ${escapeHtml(event.attempt)}`,
    ].filter(Boolean).join(' · ');
    return `<li><time>${escapeHtml(shortTime(event.ts))}</time>`
      + `<b>${escapeHtml(event.stage)}</b><span>${escapeHtml(event.type)}</span>`
      + (details ? `<small>${details}</small>` : '') + '</li>';
  }).join('')}</ol>`;
}

function vscodeFileHref(path) {
  return `vscode://file/${encodeURIComponent(path)}`;
}

function renderVsCodeLink(href) {
  return `<a href="${escapeHtml(href)}">Open in VS Code</a>`;
}

export function renderUnifiedDiff(diff, openInVsCodeHref = null) {
  if (diff.message !== null) return `<p class="notice">${escapeHtml(diff.message)}</p>`;
  const completeDiffHref = openInVsCodeHref
    ?? (typeof diff.path === 'string' ? vscodeFileHref(diff.path) : null);
  const capNotice = diff.capped
    ? `<p class="diff-capped"><strong>Diff rendering capped.</strong> Showing ${diff.renderedByteCount.toLocaleString('en-US')} of ${diff.byteCount.toLocaleString('en-US')} bytes. ${completeDiffHref === null ? 'Open CHANGES.diff in VS Code' : renderVsCodeLink(completeDiffHref)} for the complete diff.</p>`
    : `<p class="muted">${diff.byteCount.toLocaleString('en-US')} bytes.</p>`;
  const lines = diff.text.split(/(?<=\n)/).map((line) => {
    const bare = line.endsWith('\n') ? line.slice(0, -1) : line;
    const kind = bare.startsWith('+') && !bare.startsWith('+++') ? 'diff-add'
      : bare.startsWith('-') && !bare.startsWith('---') ? 'diff-remove'
        : bare.startsWith('@@') ? 'diff-hunk' : 'diff-context';
    const label = kind === 'diff-add' ? 'added' : kind === 'diff-remove' ? 'removed' : 'context';
    return `<span class="diff-line ${kind}" data-diff-line="${label}">${escapeHtml(bare || ' ')}</span>`;
  }).join('');
  return `${capNotice}<pre class="diff" aria-label="Unified diff">${lines}</pre>`;
}

export function renderRunDetail(run) {
  if (!run) return '<section class="empty">Select a pass to inspect its details.</section>';
  const age = run.lastEventTs === null ? 'no events yet'
    : formatDuration(Date.now() - Date.parse(run.lastEventTs));
  const stateLabel = run.state === 'finished' ? 'Finished' : run.state === 'running'
    ? 'Live' : run.state === 'error' ? 'Read error' : 'Waiting';
  const files = run.files.length === 0 ? '<p class="muted">No files reported.</p>'
    : `<ul class="rows">${run.files.map((file) => `<li><code>${escapeHtml(file.file)}</code>`
      + `<span>attempt ${escapeHtml(file.attempt ?? '?')}</span></li>`).join('')}</ul>`;
  const gates = run.gateCommands.length === 0 ? '<p class="muted">No gate commands reported.</p>'
    : `<ul class="rows">${run.gateCommands.map((command) => {
      const line = [command.bin, ...command.args].filter(Boolean).join(' ');
      const exitClass = command.code === 0 ? 'exit-ok' : 'exit-fail';
      return `<li><code>${escapeHtml(line)}</code><span class="${exitClass}">exit `
        + `${escapeHtml(command.code ?? '?')}${attempt(command.attempt)}`
        + `${command.timedOut ? ' · timed out' : ''}</span></li>`;
    }).join('')}</ul>`;
  const stalls = run.stalls.length === 0 ? '<p class="muted">No stalls.</p>'
    : `<ul class="stalls">${run.stalls.map((stall) => {
      const last = stall.lastEvent ?? {};
      return `<li><strong>STALL</strong><span>${escapeHtml(formatDuration(stall.gapMs))}`
        + ` after ${escapeHtml(last.stage ?? 'unknown')}/${escapeHtml(last.type ?? 'unknown')}</span></li>`;
    }).join('')}</ul>`;
  const rationale = run.executorRationale
    ?? '(executor rationale is recorded when the run report completes)';
  const vscodeCommand = `code "${run.worktreeDirectory.replaceAll('"', '\\"')}"`;
  const diffPath = join(run.worktreeDirectory, 'CHANGES.diff');
  let vscodeTarget = run.worktreeDirectory;
  try {
    if (statSync(diffPath).isFile()) vscodeTarget = diffPath;
  } catch {
    // No diff is expected for no-op and error runs; open the worktree instead.
  }
  const openInVsCodeHref = vscodeFileHref(vscodeTarget);

  return `<article class="run-card ${escapeHtml(run.state)}">`
    + `<header><div><h2>${escapeHtml(run.runId)}</h2><p title="${escapeHtml(run.directory)}">`
    + `${escapeHtml(run.directory)}</p></div><span class="state ${escapeHtml(run.state)}">${stateLabel}</span></header>`
    + (run.message ? `<p class="notice">${escapeHtml(run.message)}</p>` : '')
    + `<div class="current"><span>Current stage</span><strong>${escapeHtml(run.currentStage ?? 'not started')}</strong>`
    + `<small>${escapeHtml(run.currentType ?? '')}</small><span>Last event</span>`
    + `<strong class="age" data-last-event-ts="${escapeHtml(run.lastEventTs ?? '')}">${escapeHtml(age)}</strong></div>`
    + '<section><h3>Verifier seats</h3>'
    + renderVerifier('Correctness pass', run.verifiers.correctness)
    + renderVerifier('Intent pass', run.verifiers.intent) + '</section>'
    + `<section><h3>Executor rationale</h3><pre class="prose">${escapeHtml(rationale)}</pre></section>`
    + '<section><h3>Open the worktree in VS Code</h3>'
    + `<div class="copy-row"><pre class="command"><code>${escapeHtml(vscodeCommand)}</code></pre>`
    + `<button type="button" data-copy-command="${escapeHtml(vscodeCommand)}">Copy command</button></div>`
    + `<p>${renderVsCodeLink(openInVsCodeHref)}</p></section>`
    + '<section><h3>Unified diff</h3>' + renderUnifiedDiff(run.diff, openInVsCodeHref) + '</section>'
    + '<section><h3>Token usage by seat</h3><dl class="tokens">'
    + `<dt>Executor</dt><dd>${escapeHtml(usageText(run.tokens.executor))}</dd>`
    + `<dt>Correctness</dt><dd>${escapeHtml(usageText(run.tokens.correctness))}</dd>`
    + `<dt>Intent</dt><dd>${escapeHtml(usageText(run.tokens.intent))}</dd></dl></section>`
    + `<section><h3>Files as landed</h3>${files}</section>`
    + `<section><h3>Gate commands</h3>${gates}</section>`
    + `<section><h3>Stalls</h3>${stalls}</section>`
    + `<section><h3>Full stage timeline</h3>${renderTimeline(run.timeline)}</section></article>`;
}

function renderDetail(snapshot) {
  const selected = snapshot.runs[0] ?? null;
  const options = snapshot.runs.map((run, index) => (
    `<option value="${escapeHtml(run.runId)}"${index === 0 ? ' selected' : ''}>${escapeHtml(run.runId)}</option>`
  )).join('');
  return '<section id="detail-view" class="view-panel" data-view-panel="detail" hidden>'
    + '<div class="detail-picker"><label>Pass <select id="detail-pass">'
    + `${options}</select></label><small>One pass is rendered at a time.</small></div>`
    + `<div id="detail-body">${renderRunDetail(selected)}</div></section>`;
}

export function renderDashboardContent(snapshot) {
  const message = snapshot.message ? `<section class="empty source-message">${escapeHtml(snapshot.message)}</section>` : '';
  return `${message}<nav class="view-tabs" aria-label="Dashboard views">`
    + '<button type="button" data-view="triage" aria-pressed="true">Triage</button>'
    + '<button type="button" data-view="detail" aria-pressed="false">Detail</button>'
    + '</nav>'
    + renderTriage(snapshot) + renderDetail(snapshot);
}

export function snapshotForClient(snapshot) {
  return {
    mode: snapshot.mode,
    sourcePath: snapshot.sourcePath,
    observedAt: snapshot.observedAt,
    message: snapshot.message,
    runs: snapshot.runs.map((run) => ({
      runId: run.runId,
      title: run.title,
      projectPath: run.projectPath,
      correctsRunId: run.correctsRunId,
      state: run.state,
      message: run.message,
      startTs: run.startTs,
      endTs: run.endTs,
      currentStage: run.currentStage,
      currentType: run.currentType,
      lastEventTs: run.lastEventTs,
      timeline: run.timeline,
      files: run.files.map((file) => ({
        ...file,
        attemptText: `attempt ${file.attempt ?? '?'}`,
      })),
      filesChanged: run.filesChanged,
      triage: run.triage,
      needsAttention: run.needsAttention,
    })),
  };
}

function jsonForInlineScript(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

function clientScript() {
  return String.raw`
const connection=document.getElementById('connection');
const root=document.getElementById('runs');
const DEFAULT_SESSION_GAP_HOURS=${DEFAULT_SESSION_THRESHOLD_HOURS};
const state={snapshot:JSON.parse(document.getElementById('initial-dashboard-data').textContent),view:'triage',attentionOnly:true,detailRunId:null};
function esc(value){return String(value==null?'':value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;')}
function duration(ms){ms=Math.max(0,Math.floor(ms));if(ms<1000)return ms+' ms';const s=Math.floor(ms/1000);if(s<60)return s+'s';const m=Math.floor(s/60);if(m<60)return m+'m '+(s%60)+'s';return Math.floor(m/60)+'h '+(m%60)+'m'}
function timeMs(value){const parsed=typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(parsed)?parsed:null}
function shortTime(value){const parsed=timeMs(value);return parsed===null?'--:--:--':new Date(parsed).toISOString().slice(11,19)}
function fullTime(value){const parsed=timeMs(value);return parsed===null?'time unknown':new Date(parsed).toISOString().replace('T',' ').replace('Z',' UTC')}
function shortId(value){return value.length<=18?value:value.slice(0,10)+'…'+value.slice(-7)}
function sessions(runs,hours){const indexed=runs.map(function(run,index){return{run:run,index:index,time:timeMs(run.startTs)}});indexed.sort(function(a,b){if(a.time===null&&b.time===null)return a.index-b.index;if(a.time===null)return 1;if(b.time===null)return-1;return b.time-a.time||b.run.runId.localeCompare(a.run.runId)});const groups=[];let current=null;const gap=hours*3600000;indexed.forEach(function(item){if(current===null||item.time===null||current.last===null||current.last-item.time>gap){current={runs:[],last:item.time};groups.push(current)}current.runs.push(item.run);current.last=item.time});return groups.map(function(group){const starts=group.runs.map(function(run){return timeMs(run.startTs)}).filter(function(value){return value!==null});const ends=group.runs.map(function(run){return timeMs(run.endTs)}).filter(function(value){return value!==null});const start=starts.length?Math.min.apply(null,starts):null;const end=ends.length?Math.max.apply(null,ends):start;return{runs:group.runs,startTs:start===null?null:new Date(start).toISOString(),durationMs:start===null||end===null?null:Math.max(0,end-start),attentionCount:group.runs.filter(function(run){return run.needsAttention}).length}})}
function projectName(value){if(value===null)return'Unknown project';const parts=value.split(/[\\/]/).filter(Boolean);return parts.length?parts[parts.length-1]:value}
function projects(runs){const byPath=new Map();runs.forEach(function(run,index){const path=typeof run.projectPath==='string'?run.projectPath:null;const group=byPath.get(path)||{projectPath:path,name:projectName(path),runs:[],latestStartMs:null,firstIndex:index,attentionCount:0};const start=timeMs(run.startTs);group.runs.push(run);if(start!==null&&(group.latestStartMs===null||start>group.latestStartMs))group.latestStartMs=start;if(run.needsAttention)group.attentionCount+=1;byPath.set(path,group)});return Array.from(byPath.values()).sort(function(a,b){if(a.latestStartMs===null&&b.latestStartMs===null)return a.firstIndex-b.firstIndex;if(a.latestStartMs===null)return 1;if(b.latestStartMs===null)return-1;return b.latestStartMs-a.latestStartMs||a.firstIndex-b.firstIndex})}
function triageExplanation(checkType,kind,text){if(checkType==='gate'){if(kind==='clean'&&text==='Passed — fine')return'All automated checks completed successfully.';if(kind==='issues'&&text==='Failed — needs attention')return'One or more automated checks failed, so this pass needs attention.';if(kind==='pending'&&text==='Pending — not complete')return'The automated checks have not finished yet.'}if(checkType==='correctness'){if(kind==='pending'&&text==='Pending — unknown')return'The code-quality review has not run yet, so whether the code has defects is unknown.';if(kind==='unknown'&&text==='No verdict — unknown (ISSUES is a fail-safe, not a finding)')return'The code-quality review did not return a usable result; ISSUES is shown as a precaution, not because a defect was found.';if(kind==='issues'&&text==='ISSUES — reviewer found a problem')return'The code-quality review found a possible defect in the code.';if(kind==='clean'&&text==='NO_BLOCKERS — fine')return'The code-quality review did not find defects that would block this pass.';if(kind==='pending'&&text.endsWith(' — unknown'))return'The code-quality review returned "'+text+'", which the dashboard does not recognize, so whether the code has defects is unknown.'}if(checkType==='intent'){if(kind==='pending'&&text==='Pending — unknown')return'The task-intent review has not run yet, so it is unknown whether the changes meet TASK.md and whether new assertions would catch broken behavior.';if(kind==='unknown'&&text==='No verdict — unknown (ISSUES is a fail-safe, not a finding)')return'The task-intent review did not return a usable result; ISSUES is shown as a precaution, not because a mismatch with TASK.md or a weak assertion was found.';if(kind==='issues'&&text==='ISSUES — reviewer found a problem')return'The task-intent review found that the changes may not meet TASK.md or that new assertions may not catch broken behavior.';if(kind==='clean'&&text==='NO_BLOCKERS — fine')return'The task-intent review found no problem with whether the changes meet TASK.md or whether new assertions would catch broken behavior.';if(kind==='pending'&&text.endsWith(' — unknown'))return'The task-intent review returned "'+text+'", which the dashboard does not recognize, so it is unknown whether the changes meet TASK.md and whether new assertions would catch broken behavior.'}throw new Error('Unknown triage presentation: '+checkType+'/'+kind+'/'+text)}
function resultCell(checkType,result){const explanation=triageExplanation(checkType,result.kind,result.text);return'<span class="result '+esc(result.kind)+'" data-result-kind="'+esc(result.kind)+'" title="'+esc(explanation)+'">'+esc(result.text)+'</span>'}
function correctionRows(sessionRuns,allRuns){const allById=new Map((allRuns||sessionRuns).map(function(run){return[run.runId,run]}));const sessionById=new Map(sessionRuns.map(function(run){return[run.runId,run]}));const parentById=new Map();sessionRuns.forEach(function(run){if(typeof run.correctsRunId==='string'&&allById.has(run.correctsRunId)&&sessionById.has(run.correctsRunId))parentById.set(run.runId,run.correctsRunId)});const cycles=new Set();sessionRuns.forEach(function(run){const path=[];const positions=new Map();let current=run.runId;for(let steps=0;steps<=sessionRuns.length&&parentById.has(current);steps++){if(positions.has(current)){path.slice(positions.get(current)).forEach(function(id){cycles.add(id)});break}positions.set(current,path.length);path.push(current);current=parentById.get(current)}});const children=new Map();const nested=new Set();sessionRuns.forEach(function(run){const parent=parentById.get(run.runId);if(parent===undefined||cycles.has(run.runId))return;const rows=children.get(parent)||[];rows.push(run);children.set(parent,rows);nested.add(run.runId)});const ordered=[];const emitted=new Set();function emit(rootRun){const stack=[{run:rootRun,depth:0}];while(stack.length){const item=stack.pop();if(emitted.has(item.run.runId))continue;emitted.add(item.run.runId);ordered.push(item);const childRows=children.get(item.run.runId)||[];for(let index=childRows.length-1;index>=0;index--)stack.push({run:childRows[index],depth:item.depth+1})}}sessionRuns.forEach(function(run){if(!nested.has(run.runId))emit(run)});sessionRuns.forEach(function(run){if(!emitted.has(run.runId))ordered.push({run:run,depth:0})});return ordered}
function passRow(item){const run=item.run||item;const depth=item.depth||0;const hidden=state.attentionOnly&&!run.needsAttention?' hidden':'';const count=run.filesChanged.length;const files=count+' '+(count===1?'file':'files');const short='<code title="'+esc(run.runId)+'">'+esc(shortId(run.runId))+'</code>';const correction=typeof run.correctsRunId==='string'?'<small class="correction-note">corrects <code title="'+esc(run.correctsRunId)+'">'+esc(shortId(run.correctsRunId))+'</code></small>':'';const identity=run.title?'<span class="pass-identity"><b title="'+esc(run.title)+'">'+esc(run.title)+'</b><small>'+short+'</small>'+correction+'</span>':correction?'<span class="pass-identity">'+short+correction+'</span>':short;return'<tr class="pass-row '+(run.needsAttention?'attention':'clean')+'" data-client-run-id="'+esc(run.runId)+'" data-correction-depth="'+depth+'" data-needs-attention="'+run.needsAttention+'" style="--correction-depth:'+depth+'"'+hidden+'><td><button class="pass-detail" type="button" data-detail-run="'+esc(run.runId)+'">'+esc(shortTime(run.startTs))+'</button></td><td>'+identity+'</td><td>'+resultCell('gate',run.triage.gate)+'</td><td>'+resultCell('correctness',run.triage.correctness)+'</td><td>'+resultCell('intent',run.triage.intent)+'</td><td title="'+esc(run.filesChanged.join(', '))+'">'+esc(files)+'</td></tr>'}
function renderSessionGroups(runs,allRuns){const groups=sessions(runs,DEFAULT_SESSION_GAP_HOURS);if(!groups.length)return'<section class="empty">No passes to group into sessions.</section>';const allFiltered=state.attentionOnly&&groups.every(function(group){return group.attentionCount===0});const message=allFiltered?'<section class="empty filter-empty">No passes need attention. Turn off the filter to see clean passes.</section>':'';return message+groups.map(function(group){const hidden=state.attentionOnly&&group.attentionCount===0?' hidden':'';const title=group.runs[0]&&group.runs[0].title||null;const different=title===null?0:group.runs.slice(1).filter(function(run){return run.title!=null&&run.title!==title}).length;const headline=title===null?fullTime(group.startTs):title+(different>0?' +'+different+' more':'');return'<details class="session" data-attention-count="'+group.attentionCount+'"'+hidden+'><summary><span><b'+(title===null?'':' title="'+esc(headline)+'"')+'>'+esc(headline)+'</b><small>'+esc(fullTime(group.startTs))+' · '+esc(duration(group.durationMs))+'</small></span><span>'+group.runs.length+' '+(group.runs.length===1?'pass':'passes')+'</span><strong>'+group.attentionCount+' need'+(group.attentionCount===1?'s':'')+' attention</strong></summary><div class="pass-table-wrap"><table class="passes"><thead><tr><th>Time</th><th>Pass</th><th>Gate</th><th>Correctness</th><th>Intent</th><th>Files changed</th></tr></thead><tbody>'+correctionRows(group.runs,allRuns||runs).map(passRow).join('')+'</tbody></table></div></details>'}).join('')}
function renderSessions(){const target=document.getElementById('sessions');if(!target)return;const groups=projects(state.snapshot.runs);if(groups.length<=1){target.innerHTML=renderSessionGroups(state.snapshot.runs,state.snapshot.runs);return}const allFiltered=state.attentionOnly&&groups.every(function(group){return group.attentionCount===0});const message=allFiltered?'<section class="empty filter-empty">No passes need attention. Turn off the filter to see clean passes.</section>':'';target.innerHTML=message+groups.map(function(group){const hidden=state.attentionOnly&&group.attentionCount===0?' hidden':'';const subtitle=group.projectPath===null?'Unknown project':group.projectPath;return'<details class="project" data-project-path="'+esc(group.projectPath===null?'':group.projectPath)+'" data-attention-count="'+group.attentionCount+'"'+hidden+'><summary><span><b>'+esc(group.name)+'</b><small>'+esc(subtitle)+'</small></span><span>'+group.runs.length+' '+(group.runs.length===1?'pass':'passes')+'</span><strong>'+group.attentionCount+' need'+(group.attentionCount===1?'s':'')+' attention</strong></summary><div class="project-sessions">'+renderSessionGroups(group.runs,state.snapshot.runs)+'</div></details>'}).join('')}
function refreshAges(){document.querySelectorAll('[data-last-event-ts]').forEach(function(el){const ts=Date.parse(el.dataset.lastEventTs);if(Number.isFinite(ts))el.textContent=duration(Date.now()-ts)})}
function switchView(view){state.view=view;document.querySelectorAll('[data-view-panel]').forEach(function(panel){panel.hidden=panel.dataset.viewPanel!==view});document.querySelectorAll('[data-view]').forEach(function(button){button.setAttribute('aria-pressed',String(button.dataset.view===view))});if(view==='detail')refreshDetail()}
async function refreshDetail(){const target=document.getElementById('detail-body');const select=document.getElementById('detail-pass');if(!target||!select||!select.value){if(target)target.innerHTML='<section class="empty">Select a pass to inspect its details.</section>';return}state.detailRunId=select.value;target.setAttribute('aria-busy','true');try{const response=await fetch('/detail?runId='+encodeURIComponent(state.detailRunId),{cache:'no-store'});target.innerHTML=response.ok?await response.text():'<section class="empty">That pass is no longer available.</section>'}catch(error){target.innerHTML='<section class="empty">Could not load pass detail: '+esc(error.message)+'</section>'}finally{target.removeAttribute('aria-busy');refreshAges()}}
function syncDetailOptions(){const select=document.getElementById('detail-pass');if(!select)return;const wanted=state.detailRunId;select.innerHTML=state.snapshot.runs.map(function(run){return'<option value="'+esc(run.runId)+'">'+esc(run.runId)+'</option>'}).join('');if(wanted&&state.snapshot.runs.some(function(run){return run.runId===wanted}))select.value=wanted;state.detailRunId=select.value||null}
function bind(){const attention=document.getElementById('attention-only');if(attention)attention.addEventListener('change',function(){state.attentionOnly=attention.checked;renderSessions()});root.addEventListener('click',function(event){const viewButton=event.target.closest('[data-view]');if(viewButton){switchView(viewButton.dataset.view);return}const detailButton=event.target.closest('[data-detail-run]');if(detailButton){const select=document.getElementById('detail-pass');state.detailRunId=detailButton.dataset.detailRun;if(select)select.value=state.detailRunId;switchView('detail');return}const copyButton=event.target.closest('[data-copy-command]');if(copyButton&&navigator.clipboard){navigator.clipboard.writeText(copyButton.dataset.copyCommand).then(function(){copyButton.textContent='Copied'}).catch(function(){copyButton.textContent='Select and copy the command'})}});root.addEventListener('change',function(event){if(event.target.id==='detail-pass'){state.detailRunId=event.target.value;refreshDetail()}})}
bind();
const stream=new EventSource('/events');
stream.addEventListener('snapshot',function(event){state.snapshot=JSON.parse(event.data).snapshot;renderSessions();syncDetailOptions();if(state.view==='detail')refreshDetail();connection.textContent='Live';refreshAges()});
stream.onopen=function(){connection.textContent='Live'};
stream.onerror=function(){connection.textContent='Reconnecting…'};
setInterval(refreshAges,1000);refreshAges();
`;
}

export function renderDashboardPage(snapshot) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CCC run dashboard</title>
<style>
:root{color-scheme:light dark;--bg:#f4f5f2;--card:#fff;--ink:#18201d;--muted:#65716b;--line:#d9dedb;--ok:#197047;--warn:#9c5a08;--bad:#a32828;--soft:#eef1ef;--add:#e7f6ed;--remove:#fdeaea}
@media(prefers-color-scheme:dark){:root{--bg:#111513;--card:#19201d;--ink:#edf2ef;--muted:#a5b0aa;--line:#35403a;--soft:#222b27;--ok:#6ed39e;--warn:#f0ae59;--bad:#ff8b8b;--add:#183c2a;--remove:#472121}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,sans-serif}
body>header{padding:1rem 1.25rem;border-bottom:1px solid var(--line);display:flex;gap:1rem;align-items:end;justify-content:space-between}
h1{font-size:1.15rem;margin:0}
body>header p{margin:.15rem 0 0;color:var(--muted);word-break:break-all}
.connection{white-space:nowrap;color:var(--ok)}
main{display:flex;flex-direction:column;gap:1rem;padding:1rem;min-height:calc(100vh - 70px);max-width:1500px;margin:0 auto;width:100%}
button,select,input{font:inherit}
.view-tabs{display:flex;gap:.4rem;border-bottom:1px solid var(--line)}
.view-tabs button{border:0;border-bottom:3px solid transparent;background:transparent;color:var(--muted);padding:.55rem .9rem;cursor:pointer}
.view-tabs button[aria-pressed="true"]{color:var(--ink);border-color:var(--ink);font-weight:700}
.controls,.detail-picker{background:var(--card);border:1px solid var(--line);border-radius:7px;padding:.75rem;display:flex;align-items:center;gap:.7rem 1.2rem;flex-wrap:wrap}
.controls small,.detail-picker small{color:var(--muted);flex:1}
.toggle{white-space:nowrap}
.empty,.notice{padding:.7rem;background:var(--soft);border-radius:5px}
.source-message{margin-bottom:0}
.project,.session{background:var(--card);border:1px solid var(--line);border-radius:7px;margin:.7rem 0;overflow:hidden}
.project>summary,.session>summary{cursor:pointer;display:grid;grid-template-columns:minmax(220px,1fr) auto auto;align-items:center;gap:1rem;padding:.8rem 1rem}
.project>summary span:first-child,.session>summary span:first-child{display:flex;flex-direction:column}
.project>summary small,.session>summary small{color:var(--muted)}
.project>summary strong,.session>summary strong{color:var(--bad)}
.project-sessions{border-top:1px solid var(--line);padding:0 .7rem .05rem}
.pass-table-wrap{overflow-x:auto;border-top:1px solid var(--line)}
.passes{width:100%;border-collapse:collapse;min-width:950px}
.passes th,.passes td{text-align:left;padding:.55rem .7rem;border-bottom:1px solid var(--line);vertical-align:top}
.passes th{color:var(--muted);font-size:.72rem;text-transform:uppercase;letter-spacing:.04em}
.pass-detail{border:0;background:transparent;color:inherit;text-decoration:underline;cursor:pointer;padding:0}
.pass-row>td:nth-child(2){padding-left:calc(.7rem + var(--correction-depth)*1.25rem)}
.pass-identity{display:flex;flex-direction:column}
.pass-identity small{color:var(--muted)}
.correction-note{font-weight:600}
.result{display:inline-block;font-size:.78rem;font-weight:650}
.result.clean{color:var(--ok)}
.result.issues{color:var(--bad)}
.result.unknown{color:var(--warn)}
.result.pending{color:var(--muted)}
.run-card{background:var(--card);border:1px solid var(--line);border-top:4px solid var(--warn);border-radius:7px;padding:1rem;margin:.7rem 0}
.run-card>header{display:flex;justify-content:space-between;gap:.8rem}
.run-card.finished{border-top-color:var(--ok)}
.run-card.error{border-top-color:var(--bad)}
.run-card h2{font-size:1rem;margin:0;overflow-wrap:anywhere}
.run-card header p{font-size:.72rem;color:var(--muted);margin:.2rem 0;overflow-wrap:anywhere}
.state{border:1px solid currentColor;border-radius:999px;padding:.15rem .55rem;height:max-content;font-size:.75rem}
.state.finished{color:var(--ok)}
.state.error{color:var(--bad)}
.state.running{color:var(--warn)}
.current{display:grid;grid-template-columns:auto 1fr;gap:.2rem .65rem;background:var(--soft);padding:.7rem;margin:.8rem 0;border-radius:5px}
.current span{color:var(--muted)}
.current small{grid-column:2;color:var(--muted)}
.run-card section{margin-top:1rem}
h3{font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 .45rem}
.verifier{display:grid;grid-template-columns:1fr auto;gap:.1rem .6rem;border-left:3px solid var(--line);padding:.45rem .6rem;margin:.35rem 0;background:var(--soft)}
.verifier span,.verifier em{font-size:.75rem;color:var(--muted)}
.verifier em{grid-column:1/-1}
.verifier.fail-safe{border-color:var(--warn)}
.verifier.reviewer:has(strong:first-of-type){border-color:var(--line)}
.verifier-findings{grid-column:1/-1;margin-top:.35rem}
.verifier-findings h4{font-size:.75rem;margin:.15rem 0}
.verifier-findings pre,.prose,.command{margin:.2rem 0;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--card);border:1px solid var(--line);border-radius:4px;padding:.55rem;font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace}
.command{white-space:pre;overflow:auto;flex:1}
.copy-row{display:flex;align-items:start;gap:.5rem}
.copy-row button{margin-top:.2rem}
.tokens{display:grid;grid-template-columns:auto 1fr;gap:.25rem .6rem;margin:0}
.tokens dt{font-weight:650}
.tokens dd{margin:0;color:var(--muted);font-variant-numeric:tabular-nums}
.rows,.stalls{list-style:none;margin:0;padding:0}
.rows li,.stalls li{display:flex;justify-content:space-between;gap:.7rem;border-top:1px solid var(--line);padding:.35rem 0}
.rows code{overflow-wrap:anywhere}
.rows span{white-space:nowrap;color:var(--muted)}
.exit-ok{color:var(--ok)!important}
.exit-fail{color:var(--bad)!important}
.stalls li{justify-content:flex-start;color:var(--bad)}
.timeline{list-style:none;margin:0;padding:0;max-height:280px;overflow:auto}
.timeline li{display:grid;grid-template-columns:4.8rem 5.5rem 1fr;gap:.35rem;border-left:2px solid var(--line);padding:.25rem .5rem}
.timeline time,.timeline span,.timeline small{color:var(--muted)}
.timeline small{grid-column:2/-1}
.diff-capped{padding:.6rem;background:var(--soft);border-left:3px solid var(--warn)}
.diff{margin:.35rem 0;max-height:65vh;overflow:auto;border:1px solid var(--line);background:var(--card);font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}
.diff-line{display:block;min-height:1.5em;padding:0 .5rem;white-space:pre}
.diff-add{background:var(--add);color:var(--ok)}
.diff-remove{background:var(--remove);color:var(--bad)}
.diff-hunk{color:var(--warn)}
@media(max-width:700px){body>header{align-items:start;flex-direction:column}main{padding:.5rem}.project>summary,.session>summary{grid-template-columns:1fr}.controls{align-items:start;flex-direction:column}}
</style>
</head>
<body>
<header><div><h1>${CCC_DASHBOARD_MARKER}</h1><p>${escapeHtml(snapshot.sourcePath)}</p></div><span id="connection" class="connection">Connecting…</span></header>
<main id="runs">${renderDashboardContent(snapshot)}</main>
<script id="initial-dashboard-data" type="application/json">${jsonForInlineScript(snapshotForClient(snapshot))}</script>
<script>${clientScript()}</script>
</body>
</html>`;
}
