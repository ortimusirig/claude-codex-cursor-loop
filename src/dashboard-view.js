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
import {
  CAMPAIGN_EVENTS_FILENAME,
  readCampaignEventStream,
  readEventStream,
} from './event-stream.js';
import { addUsage, EMPTY_USAGE } from './usage.js';
import { renderCampaignGraphSvg } from './campaign-graph.js';
import {
  DEFAULT_EXECUTOR_TIMEOUT_MS,
  DEFAULT_GATE_TIMEOUT_MS,
  DEFAULT_VERIFIER_TIMEOUT_MS,
} from './timeouts.js';

export const DEFAULT_SESSION_THRESHOLD_HOURS = 2;
export const MAX_RENDERED_DIFF_BYTES = 128 * 1024;

const TASK_TITLE_MAX_LENGTH = 90;
const LIVE_STAGE_TIMEOUTS_MS = Object.freeze({
  executor: DEFAULT_EXECUTOR_TIMEOUT_MS,
  gate: DEFAULT_GATE_TIMEOUT_MS,
  verify: DEFAULT_VERIFIER_TIMEOUT_MS,
});

const LIVE_STAGES = Object.freeze([
  'unit', 'isolate', 'merge', 'executor', 'gate', 'diff', 'verify', 'report',
]);

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
    campaignId: null,
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
  const title = lines[index].trim();
  if (title.length <= TASK_TITLE_MAX_LENGTH) return title;
  return `${title.slice(0, TASK_TITLE_MAX_LENGTH - 1).trimEnd()}…`;
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
    campaignId: events.find((event) => typeof event.campaignId === 'string')?.campaignId ?? null,
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

function digestCampaignDirectory(directory) {
  try {
    const stream = readCampaignEventStream(directory);
    const byUnit = new Map();
    for (const event of stream.events) {
      if (event.stage !== 'unit' || typeof event.unitId !== 'string') continue;
      const previous = byUnit.get(event.unitId) ?? {
        campaignId: stream.campaignId,
        unitId: event.unitId,
        unitKind: event.unitKind ?? null,
        predecessorUnitIds: [],
      };
      const predecessors = Array.isArray(event.predecessorUnitIds)
        ? event.predecessorUnitIds
        : typeof event.predecessorUnitId === 'string' ? [event.predecessorUnitId] : [];
      byUnit.set(event.unitId, {
        ...previous,
        unitKind: event.unitKind ?? previous.unitKind,
        currentType: event.type,
        lastEventTs: event.ts ?? previous.lastEventTs ?? null,
        predecessorUnitIds: predecessors.length > 0 ? predecessors : previous.predecessorUnitIds,
      });
    }
    return {
      campaignId: stream.campaignId,
      directory: stream.directory,
      units: [...byUnit.values()],
      message: null,
    };
  } catch (error) {
    return {
      campaignId: basename(directory),
      directory,
      units: [],
      message: `Cannot read campaign event stream: ${error.message}`,
    };
  }
}

function isTerminalUnitType(type) {
  return type === 'finish' || type === 'not_dispatched' || type === 'skipped';
}

export function liveUnitFromRun(run) {
  const stalled = run.currentType === 'stalled';
  const timeoutMs = LIVE_STAGE_TIMEOUTS_MS[run.currentStage];
  const lastEventMs = validTimestamp(run.lastEventTs);
  const stale = !stalled
    && run.state !== 'waiting'
    && timeoutMs !== undefined
    && lastEventMs !== null
    && Date.now() - lastEventMs > timeoutMs;
  return {
    campaignId: run.campaignId,
    unitId: run.runId,
    unitKind: null,
    status: stalled ? 'stalled'
      : run.state === 'waiting' ? 'waiting-for-events'
        : stale ? 'stale' : 'active',
    statusText: stalled ? 'Stalled — watchdog reported no progress'
      : run.state === 'waiting' ? 'Waiting for events — not stalled'
        : stale ? 'Stale — no recent events' : 'Active',
    currentStage: run.currentStage,
    currentType: run.currentType,
    lastEventTs: run.lastEventTs,
    predecessorUnitIds: [],
    timeline: run.timeline,
  };
}

function buildLiveUnits(runs, campaigns) {
  const units = new Map();
  for (const campaign of campaigns) {
    for (const unit of campaign.units) {
      if (isTerminalUnitType(unit.currentType)) continue;
      const key = `${unit.campaignId ?? ''}/${unit.unitId}`;
      const waiting = unit.currentType === 'waiting';
      units.set(key, {
        ...unit,
        status: waiting ? 'waiting-predecessor' : 'active',
        statusText: waiting
          ? `Waiting on predecessor: ${unit.predecessorUnitIds.join(', ') || 'unknown'}`
          : 'Active',
        currentStage: 'unit',
        timeline: [],
      });
    }
  }
  for (const run of runs) {
    if (run.state === 'finished' || run.state === 'error') continue;
    const key = `${run.campaignId ?? ''}/${run.runId}`;
    const existing = units.get(key);
    const fromRun = liveUnitFromRun(run);
    if (existing?.status === 'waiting-predecessor') continue;
    units.set(key, { ...existing, ...fromRun });
  }
  return [...units.values()].sort((left, right) => (
    (validTimestamp(right.lastEventTs) ?? -1) - (validTimestamp(left.lastEventTs) ?? -1)
      || right.unitId.localeCompare(left.unitId)
  ));
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

export function buildDashboardSnapshot({ runDirectory, scratchRoot } = {}) {
  if (Boolean(runDirectory) === Boolean(scratchRoot)) {
    throw new TypeError('dashboard requires exactly one of runDirectory or scratchRoot');
  }
  const observedAt = new Date().toISOString();
  if (runDirectory) {
    const sourcePath = resolve(runDirectory);
    const runs = [digestRunDirectory(sourcePath)];
    return {
      mode: 'run', sourcePath, observedAt, message: null, campaigns: [], runs,
      liveUnits: buildLiveUnits(runs, []),
    };
  }

  const sourcePath = resolve(scratchRoot);
  let entries;
  try {
    const stat = statSync(sourcePath);
    if (!stat.isDirectory()) {
      return {
        mode: 'scratch', sourcePath, observedAt,
        message: `Scratch root is not a directory: ${sourcePath}`,
        campaigns: [], runs: [], liveUnits: [],
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
        campaigns: [], runs: [], liveUnits: [],
      };
    }
    return {
      mode: 'scratch', sourcePath, observedAt,
      message: `Cannot read scratch root: ${error.message}`,
      campaigns: [], runs: [], liveUnits: [],
    };
  }

  const campaigns = [];
  const runs = [];
  for (const entry of entries) {
    const directory = join(sourcePath, entry.name);
    const campaignPath = join(directory, CAMPAIGN_EVENTS_FILENAME);
    const hasCampaignStream = existsSync(campaignPath);
    const hasRunStream = existsSync(join(directory, 'events.jsonl'))
      || existsSync(join(directory, 'w', 'events.jsonl'));
    if (hasCampaignStream) campaigns.push(digestCampaignDirectory(directory));
    if (!hasCampaignStream || hasRunStream) runs.push(digestRunDirectory(directory));
  }
  const campaignMessages = campaigns.map((campaign) => campaign.message).filter(Boolean);
  return {
    mode: 'scratch',
    sourcePath,
    observedAt,
    message: runs.length === 0
      ? campaignMessages[0] ?? 'No run directories found yet.'
      : campaignMessages[0] ?? null,
    campaigns,
    runs,
    liveUnits: buildLiveUnits(runs, campaigns),
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

function renderTriageState(presentation) {
  return `<span class="result ${escapeHtml(presentation.kind)}" data-result-kind="${escapeHtml(presentation.kind)}">`
    + `${escapeHtml(presentation.text)}</span>`;
}

function renderPassRow(run, attentionOnly) {
  const hidden = attentionOnly && !run.needsAttention ? ' hidden' : '';
  const files = run.filesChanged.length === 0 ? '0 files'
    : `${run.filesChanged.length} ${run.filesChanged.length === 1 ? 'file' : 'files'}`;
  const shortId = `<code title="${escapeHtml(run.runId)}">${escapeHtml(shortRunId(run.runId))}</code>`;
  const identity = typeof run.title === 'string' && run.title.length > 0
    ? `<span class="pass-identity"><b>${escapeHtml(run.title)}</b><small>${shortId}</small></span>`
    : shortId;
  return `<tr class="pass-row${run.needsAttention ? ' attention' : ' clean'}" data-run-id="${escapeHtml(run.runId)}"`
    + ` data-needs-attention="${run.needsAttention}"${hidden}>`
    + `<td><button class="pass-detail" type="button" data-detail-run="${escapeHtml(run.runId)}">`
    + `${escapeHtml(shortTime(run.startTs))}</button></td>`
    + `<td>${identity}</td>`
    + `<td>${renderTriageState(run.triage.gate)}</td>`
    + `<td>${renderTriageState(run.triage.correctness)}</td>`
    + `<td>${renderTriageState(run.triage.intent)}</td>`
    + `<td title="${escapeHtml(run.filesChanged.join(', '))}">${escapeHtml(files)}</td></tr>`;
}

function renderSessions(runs, thresholdHours, attentionOnly) {
  const sessions = inferSessions(runs, thresholdHours);
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
      + `<summary><span><b>${escapeHtml(headline)}</b>`
      + `<small>${escapeHtml(fullTime(session.startTs))} · ${escapeHtml(formatDuration(session.durationMs))}</small></span>`
      + `<span>${session.passCount} ${session.passCount === 1 ? 'pass' : 'passes'}</span>`
      + `<strong>${session.attentionCount} need${session.attentionCount === 1 ? 's' : ''} attention</strong></summary>`
      + '<div class="pass-table-wrap"><table class="passes"><thead><tr><th>Time</th><th>Pass</th>'
      + '<th>Gate</th><th>Correctness</th><th>Intent</th><th>Files changed</th></tr></thead><tbody>'
      + session.runs.map((run) => renderPassRow(run, attentionOnly)).join('')
      + '</tbody></table></div></details>';
  }).join('');
}

export function renderSessionList(
  runs,
  thresholdHours = DEFAULT_SESSION_THRESHOLD_HOURS,
  attentionOnly = true,
) {
  return renderSessions(runs, thresholdHours, attentionOnly);
}

function renderTriage(snapshot) {
  return '<section id="triage-view" class="view-panel" data-view-panel="triage">'
    + '<div class="controls"><label class="toggle"><input id="attention-only" type="checkbox" checked> Show needs-attention passes only</label></div>'
    + `<div id="sessions">${renderSessions(snapshot.runs, DEFAULT_SESSION_THRESHOLD_HOURS, true)}</div></section>`;
}

function renderStageBar(unit) {
  const currentIndex = LIVE_STAGES.indexOf(unit.currentStage);
  const finished = new Set(unit.timeline
    .filter((event) => event.type === 'finish')
    .map((event) => event.stage));
  return `<ol class="stage-bar" aria-label="Stage bar for ${escapeHtml(unit.unitId)}">${LIVE_STAGES.map((stage, index) => {
    const kind = stage === unit.currentStage ? 'current'
      : finished.has(stage) || (currentIndex >= 0 && index < currentIndex) ? 'done' : 'pending';
    return `<li class="${kind}"><span>${escapeHtml(stage)}</span></li>`;
  }).join('')}</ol>`;
}

function renderLive(snapshot) {
  const rows = snapshot.liveUnits.length === 0
    ? '<section class="empty">No units are currently in flight.</section>'
    : snapshot.liveUnits.map((unit) => {
      const age = unit.lastEventTs === null ? 'no events yet'
        : formatDuration(Date.now() - Date.parse(unit.lastEventTs));
      return `<article class="live-unit ${escapeHtml(unit.status)}" data-unit-id="${escapeHtml(unit.unitId)}">`
        + `<header><div><b>${escapeHtml(unit.unitId)}</b><small>${escapeHtml(unit.unitKind ?? '')}</small></div>`
        + `<strong>${escapeHtml(unit.statusText)}</strong></header>`
        + `<div class="current"><span>Current stage</span><strong>${escapeHtml(unit.currentStage ?? 'not started')}</strong>`
        + `<small>${escapeHtml(unit.currentType ?? '')}</small><span>Last event</span>`
        + `<strong class="age" data-last-event-ts="${escapeHtml(unit.lastEventTs ?? '')}">${escapeHtml(age)}</strong></div>`
        + renderStageBar(unit) + '</article>';
    }).join('');
  return `<section id="live-view" class="view-panel" data-view-panel="live" hidden>${rows}</section>`;
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

export function renderUnifiedDiff(diff) {
  if (diff.message !== null) return `<p class="notice">${escapeHtml(diff.message)}</p>`;
  const capNotice = diff.capped
    ? `<p class="diff-capped"><strong>Diff rendering capped.</strong> Showing ${diff.renderedByteCount.toLocaleString('en-US')} of ${diff.byteCount.toLocaleString('en-US')} bytes. Open the worktree in VS Code for the complete diff.</p>`
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
    + `<button type="button" data-copy-command="${escapeHtml(vscodeCommand)}">Copy command</button></div></section>`
    + '<section><h3>Unified diff</h3>' + renderUnifiedDiff(run.diff) + '</section>'
    + '<section><h3>Token usage by seat</h3><dl class="tokens">'
    + `<dt>Executor</dt><dd>${escapeHtml(usageText(run.tokens.executor))}</dd>`
    + `<dt>Correctness</dt><dd>${escapeHtml(usageText(run.tokens.correctness))}</dd>`
    + `<dt>Intent</dt><dd>${escapeHtml(usageText(run.tokens.intent))}</dd></dl></section>`
    + `<section><h3>Files as landed</h3>${files}</section>`
    + `<section><h3>Gate commands</h3>${gates}</section>`
    + `<section><h3>Stalls</h3>${stalls}</section>`
    + `<section><h3>Full stage timeline</h3>${renderTimeline(run.timeline)}</section></article>`;
}

function renderLogEventRow(row) {
  const event = row.event ?? row;
  const pair = `${event.stage ?? 'unknown'}/${event.type ?? 'unknown'}`;
  return '<li class="log-row" data-log-run-id="' + escapeHtml(row.runId ?? '') + '">'
    + `<time>${escapeHtml(fullTime(event.ts))}</time>`
    + `<code class="log-run">${escapeHtml(row.runId ?? 'unknown run')}</code>`
    + `<b>${escapeHtml(pair)}</b><span>${escapeHtml(row.detail ?? '')}</span>`
    + '<details class="raw-event"><summary>Raw record</summary>'
    + `<pre>${escapeHtml(JSON.stringify(event, null, 2))}</pre></details></li>`;
}

export function renderLogRows(rows, { problemsOnly = false } = {}) {
  if (rows.length === 0) {
    return problemsOnly
      ? '<section class="empty">No records need investigation. Turn off problems only to see the clean stream.</section>'
      : '<section class="empty">No event records are available yet.</section>';
  }
  const rendered = rows.map((row) => {
    if (row.kind !== 'group') return renderLogEventRow(row);
    const noun = row.count === 1 ? 'event' : 'events';
    return '<li class="log-collapse"><details data-collapsed-count="' + row.count + '">'
      + `<summary><strong>${row.count} ${escapeHtml(row.groupType)} ${noun}</strong> collapsed — expand to show every record</summary>`
      + `<ol class="log-list nested">${row.rows.map(renderLogEventRow).join('')}</ol>`
      + '</details></li>';
  }).join('');
  return `<ol class="log-list">${rendered}</ol>`;
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

function renderLogs(snapshot) {
  const options = snapshot.runs.map((run) => (
    `<option value="${escapeHtml(run.runId)}">${escapeHtml(run.runId)}</option>`
  )).join('');
  return '<section id="logs-view" class="view-panel" data-view-panel="logs" hidden>'
    + '<div class="logs-picker"><label>Run <select id="logs-pass">'
    + `<option value="all">All runs</option>${options}</select></label>`
    + '<label class="toggle"><input id="problems-only" type="checkbox"> Problems only</label>'
    + '<small>Raw records are fetched on demand. Executor item completions stay available in expandable groups.</small></div>'
    + '<div id="logs-body"><section class="empty">Open Logs to load the event stream.</section></div></section>';
}

export function renderCampaignGraph(graph) {
  if (graph.message) return `<section class="empty">${escapeHtml(graph.message)}</section>`;
  const svg = renderCampaignGraphSvg(graph);
  return '<div class="graph-key" aria-label="Graph state legend">'
    + '<span class="not-dispatched">Not yet dispatched</span><span class="waiting">Waiting</span>'
    + '<span class="running">Running</span><span class="finished">Finished</span>'
    + '<span class="skipped">Skipped</span><strong>Double border = MERGE</strong></div>'
    + `<div class="graph-frame">${svg}</div>`;
}

function renderGraph(snapshot) {
  if (snapshot.mode === 'run') {
    return '<section id="graph-view" class="view-panel" data-view-panel="graph" hidden>'
      + '<section class="empty">A single-run dashboard has no campaign topology to display.</section></section>';
  }
  const campaigns = Array.isArray(snapshot.campaigns) ? snapshot.campaigns : [];
  if (campaigns.length === 0) {
    return '<section id="graph-view" class="view-panel" data-view-panel="graph" hidden>'
      + '<section class="empty">No campaigns are available in this scratch root yet.</section></section>';
  }
  const options = campaigns.map((campaign, index) => (
    `<option value="${escapeHtml(campaign.campaignId)}"${index === 0 ? ' selected' : ''}>`
      + `${escapeHtml(campaign.campaignId)}</option>`
  )).join('');
  const picker = campaigns.length > 1
    ? '<div class="graph-picker"><label>Campaign <select id="graph-campaign">'
      + `${options}</select></label><small>Choose one campaign topology.</small></div>`
    : `<input id="graph-campaign" type="hidden" value="${escapeHtml(campaigns[0].campaignId)}">`;
  return '<section id="graph-view" class="view-panel" data-view-panel="graph" hidden>'
    + picker
    + '<div id="graph-body"><section class="empty">Open Graph to load the campaign topology.</section></div>'
    + '</section>';
}

export function renderDashboardContent(snapshot) {
  const message = snapshot.message ? `<section class="empty source-message">${escapeHtml(snapshot.message)}</section>` : '';
  return `${message}<nav class="view-tabs" aria-label="Dashboard views">`
    + '<button type="button" data-view="triage" aria-pressed="true">Triage</button>'
    + '<button type="button" data-view="live" aria-pressed="false">Live</button>'
    + '<button type="button" data-view="detail" aria-pressed="false">Detail</button>'
    + '<button type="button" data-view="logs" aria-pressed="false">Logs</button>'
    + '<button type="button" data-view="graph" aria-pressed="false">Graph</button></nav>'
    + renderTriage(snapshot) + renderLive(snapshot) + renderDetail(snapshot)
    + renderLogs(snapshot) + renderGraph(snapshot);
}

export function snapshotForClient(snapshot) {
  return {
    mode: snapshot.mode,
    sourcePath: snapshot.sourcePath,
    observedAt: snapshot.observedAt,
    message: snapshot.message,
    liveUnits: snapshot.liveUnits,
    runs: snapshot.runs.map((run) => ({
      runId: run.runId,
      title: run.title,
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
const state={snapshot:JSON.parse(document.getElementById('initial-dashboard-data').textContent),view:'triage',attentionOnly:true,detailRunId:null,logsRunId:'all',logsProblemsOnly:false,graphCampaignId:null};
function esc(value){return String(value==null?'':value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;')}
function duration(ms){ms=Math.max(0,Math.floor(ms));if(ms<1000)return ms+' ms';const s=Math.floor(ms/1000);if(s<60)return s+'s';const m=Math.floor(s/60);if(m<60)return m+'m '+(s%60)+'s';return Math.floor(m/60)+'h '+(m%60)+'m'}
function timeMs(value){const parsed=typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(parsed)?parsed:null}
function shortTime(value){const parsed=timeMs(value);return parsed===null?'--:--:--':new Date(parsed).toISOString().slice(11,19)}
function fullTime(value){const parsed=timeMs(value);return parsed===null?'time unknown':new Date(parsed).toISOString().replace('T',' ').replace('Z',' UTC')}
function shortId(value){return value.length<=18?value:value.slice(0,10)+'…'+value.slice(-7)}
function sessions(runs,hours){const indexed=runs.map(function(run,index){return{run:run,index:index,time:timeMs(run.startTs)}});indexed.sort(function(a,b){if(a.time===null&&b.time===null)return a.index-b.index;if(a.time===null)return 1;if(b.time===null)return-1;return b.time-a.time||b.run.runId.localeCompare(a.run.runId)});const groups=[];let current=null;const gap=hours*3600000;indexed.forEach(function(item){if(current===null||item.time===null||current.last===null||current.last-item.time>gap){current={runs:[],last:item.time};groups.push(current)}current.runs.push(item.run);current.last=item.time});return groups.map(function(group){const starts=group.runs.map(function(run){return timeMs(run.startTs)}).filter(function(value){return value!==null});const ends=group.runs.map(function(run){return timeMs(run.endTs)}).filter(function(value){return value!==null});const start=starts.length?Math.min.apply(null,starts):null;const end=ends.length?Math.max.apply(null,ends):start;return{runs:group.runs,startTs:start===null?null:new Date(start).toISOString(),durationMs:start===null||end===null?null:Math.max(0,end-start),attentionCount:group.runs.filter(function(run){return run.needsAttention}).length}})}
function resultCell(result){return'<span class="result '+esc(result.kind)+'" data-result-kind="'+esc(result.kind)+'">'+esc(result.text)+'</span>'}
function passRow(run){const hidden=state.attentionOnly&&!run.needsAttention?' hidden':'';const count=run.filesChanged.length;const files=count+' '+(count===1?'file':'files');const short='<code title="'+esc(run.runId)+'">'+esc(shortId(run.runId))+'</code>';const identity=run.title?'<span class="pass-identity"><b>'+esc(run.title)+'</b><small>'+short+'</small></span>':short;return'<tr class="pass-row '+(run.needsAttention?'attention':'clean')+'" data-client-run-id="'+esc(run.runId)+'" data-needs-attention="'+run.needsAttention+'"'+hidden+'><td><button class="pass-detail" type="button" data-detail-run="'+esc(run.runId)+'">'+esc(shortTime(run.startTs))+'</button></td><td>'+identity+'</td><td>'+resultCell(run.triage.gate)+'</td><td>'+resultCell(run.triage.correctness)+'</td><td>'+resultCell(run.triage.intent)+'</td><td title="'+esc(run.filesChanged.join(', '))+'">'+esc(files)+'</td></tr>'}
function renderSessions(){const target=document.getElementById('sessions');if(!target)return;const groups=sessions(state.snapshot.runs,DEFAULT_SESSION_GAP_HOURS);if(!groups.length){target.innerHTML='<section class="empty">No passes to group into sessions.</section>';return}const allFiltered=state.attentionOnly&&groups.every(function(group){return group.attentionCount===0});const message=allFiltered?'<section class="empty filter-empty">No passes need attention. Turn off the filter to see clean passes.</section>':'';target.innerHTML=message+groups.map(function(group){const hidden=state.attentionOnly&&group.attentionCount===0?' hidden':'';const title=group.runs[0]&&group.runs[0].title||null;const different=title===null?0:group.runs.slice(1).filter(function(run){return run.title!=null&&run.title!==title}).length;const headline=title===null?fullTime(group.startTs):title+(different>0?' +'+different+' more':'');return'<details class="session" data-attention-count="'+group.attentionCount+'"'+hidden+'><summary><span><b>'+esc(headline)+'</b><small>'+esc(fullTime(group.startTs))+' · '+esc(duration(group.durationMs))+'</small></span><span>'+group.runs.length+' '+(group.runs.length===1?'pass':'passes')+'</span><strong>'+group.attentionCount+' need'+(group.attentionCount===1?'s':'')+' attention</strong></summary><div class="pass-table-wrap"><table class="passes"><thead><tr><th>Time</th><th>Pass</th><th>Gate</th><th>Correctness</th><th>Intent</th><th>Files changed</th></tr></thead><tbody>'+group.runs.map(passRow).join('')+'</tbody></table></div></details>'}).join('')}
function stageBar(unit){const stages=['unit','isolate','merge','executor','gate','diff','verify','report'];const current=stages.indexOf(unit.currentStage);const finished=new Set(unit.timeline.filter(function(event){return event.type==='finish'}).map(function(event){return event.stage}));return'<ol class="stage-bar" aria-label="Stage bar for '+esc(unit.unitId)+'">'+stages.map(function(stage,index){const kind=stage===unit.currentStage?'current':finished.has(stage)||(current>=0&&index<current)?'done':'pending';return'<li class="'+kind+'"><span>'+esc(stage)+'</span></li>'}).join('')+'</ol>'}
function renderLive(){const target=document.getElementById('live-view');if(!target)return;if(!state.snapshot.liveUnits.length){target.innerHTML='<section class="empty">No units are currently in flight.</section>';return}target.innerHTML=state.snapshot.liveUnits.map(function(unit){const age=unit.lastEventTs===null?'no events yet':duration(Date.now()-Date.parse(unit.lastEventTs));return'<article class="live-unit '+esc(unit.status)+'" data-unit-id="'+esc(unit.unitId)+'"><header><div><b>'+esc(unit.unitId)+'</b><small>'+esc(unit.unitKind||'')+'</small></div><strong>'+esc(unit.statusText)+'</strong></header><div class="current"><span>Current stage</span><strong>'+esc(unit.currentStage||'not started')+'</strong><small>'+esc(unit.currentType||'')+'</small><span>Last event</span><strong class="age" data-last-event-ts="'+esc(unit.lastEventTs||'')+'">'+esc(age)+'</strong></div>'+stageBar(unit)+'</article>'}).join('')}
function refreshAges(){document.querySelectorAll('[data-last-event-ts]').forEach(function(el){const ts=Date.parse(el.dataset.lastEventTs);if(Number.isFinite(ts))el.textContent=duration(Date.now()-ts)})}
function switchView(view){state.view=view;document.querySelectorAll('[data-view-panel]').forEach(function(panel){panel.hidden=panel.dataset.viewPanel!==view});document.querySelectorAll('[data-view]').forEach(function(button){button.setAttribute('aria-pressed',String(button.dataset.view===view))});if(view==='detail')refreshDetail();if(view==='logs')refreshLogs();if(view==='graph')refreshGraph()}
async function refreshDetail(){const target=document.getElementById('detail-body');const select=document.getElementById('detail-pass');if(!target||!select||!select.value){if(target)target.innerHTML='<section class="empty">Select a pass to inspect its details.</section>';return}state.detailRunId=select.value;target.setAttribute('aria-busy','true');try{const response=await fetch('/detail?runId='+encodeURIComponent(state.detailRunId),{cache:'no-store'});target.innerHTML=response.ok?await response.text():'<section class="empty">That pass is no longer available.</section>'}catch(error){target.innerHTML='<section class="empty">Could not load pass detail: '+esc(error.message)+'</section>'}finally{target.removeAttribute('aria-busy');refreshAges()}}
function syncDetailOptions(){const select=document.getElementById('detail-pass');if(!select)return;const wanted=state.detailRunId;select.innerHTML=state.snapshot.runs.map(function(run){return'<option value="'+esc(run.runId)+'">'+esc(run.runId)+'</option>'}).join('');if(wanted&&state.snapshot.runs.some(function(run){return run.runId===wanted}))select.value=wanted;state.detailRunId=select.value||null}
async function refreshLogs(){const target=document.getElementById('logs-body');const select=document.getElementById('logs-pass');if(!target||!select)return;state.logsRunId=select.value||'all';const filter=document.getElementById('problems-only');state.logsProblemsOnly=Boolean(filter&&filter.checked);target.setAttribute('aria-busy','true');try{const query='?runId='+encodeURIComponent(state.logsRunId)+'&problemsOnly='+state.logsProblemsOnly;const response=await fetch('/logs'+query,{cache:'no-store'});target.innerHTML=response.ok?await response.text():'<section class="empty">That pass is no longer available.</section>'}catch(error){target.innerHTML='<section class="empty">Could not load logs: '+esc(error.message)+'</section>'}finally{target.removeAttribute('aria-busy')}}
function syncLogOptions(){const select=document.getElementById('logs-pass');if(!select)return;const wanted=state.logsRunId;select.innerHTML='<option value="all">All runs</option>'+state.snapshot.runs.map(function(run){return'<option value="'+esc(run.runId)+'">'+esc(run.runId)+'</option>'}).join('');if(wanted==='all'||state.snapshot.runs.some(function(run){return run.runId===wanted}))select.value=wanted;else state.logsRunId=select.value='all'}
async function refreshGraph(){const target=document.getElementById('graph-body');const select=document.getElementById('graph-campaign');if(!target||!select||!select.value)return;state.graphCampaignId=select.value;target.setAttribute('aria-busy','true');try{const response=await fetch('/graph?campaignId='+encodeURIComponent(state.graphCampaignId),{cache:'no-store'});target.innerHTML=response.ok?await response.text():'<section class="empty">That campaign is no longer available.</section>'}catch(error){target.innerHTML='<section class="empty">Could not load campaign graph: '+esc(error.message)+'</section>'}finally{target.removeAttribute('aria-busy')}}
function bind(){const attention=document.getElementById('attention-only');if(attention)attention.addEventListener('change',function(){state.attentionOnly=attention.checked;renderSessions()});root.addEventListener('click',function(event){const viewButton=event.target.closest('[data-view]');if(viewButton){switchView(viewButton.dataset.view);return}const detailButton=event.target.closest('[data-detail-run]');if(detailButton){const select=document.getElementById('detail-pass');state.detailRunId=detailButton.dataset.detailRun;if(select)select.value=state.detailRunId;switchView('detail');return}const copyButton=event.target.closest('[data-copy-command]');if(copyButton&&navigator.clipboard){navigator.clipboard.writeText(copyButton.dataset.copyCommand).then(function(){copyButton.textContent='Copied'}).catch(function(){copyButton.textContent='Select and copy the command'})}});root.addEventListener('change',function(event){if(event.target.id==='detail-pass'){state.detailRunId=event.target.value;refreshDetail()}if(event.target.id==='logs-pass'||event.target.id==='problems-only')refreshLogs();if(event.target.id==='graph-campaign')refreshGraph()})}
bind();
const stream=new EventSource('/events');
stream.addEventListener('snapshot',function(event){state.snapshot=JSON.parse(event.data).snapshot;renderSessions();renderLive();syncDetailOptions();syncLogOptions();if(state.view==='detail')refreshDetail();if(state.view==='logs')refreshLogs();if(state.view==='graph')refreshGraph();connection.textContent='Live';refreshAges()});
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
:root{color-scheme:light dark;--bg:#f4f5f2;--card:#fff;--ink:#18201d;--muted:#65716b;--line:#d9dedb;--ok:#197047;--warn:#9c5a08;--bad:#a32828;--stale:#6b4fb3;--soft:#eef1ef;--add:#e7f6ed;--remove:#fdeaea}
@media(prefers-color-scheme:dark){:root{--bg:#111513;--card:#19201d;--ink:#edf2ef;--muted:#a5b0aa;--line:#35403a;--soft:#222b27;--ok:#6ed39e;--warn:#f0ae59;--bad:#ff8b8b;--stale:#c2a7ff;--add:#183c2a;--remove:#472121}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,sans-serif}body>header{padding:1rem 1.25rem;border-bottom:1px solid var(--line);display:flex;gap:1rem;align-items:end;justify-content:space-between}h1{font-size:1.15rem;margin:0}body>header p{margin:.15rem 0 0;color:var(--muted);word-break:break-all}.connection{white-space:nowrap;color:var(--ok)}main{display:flex;flex-direction:column;gap:1rem;padding:1rem;min-height:calc(100vh - 70px);max-width:1500px;margin:0 auto;width:100%}button,select,input{font:inherit}.view-tabs{display:flex;gap:.4rem;border-bottom:1px solid var(--line)}.view-tabs button{border:0;border-bottom:3px solid transparent;background:transparent;color:var(--muted);padding:.55rem .9rem;cursor:pointer}.view-tabs button[aria-pressed="true"]{color:var(--ink);border-color:var(--ink);font-weight:700}.controls,.detail-picker,.logs-picker,.graph-picker{background:var(--card);border:1px solid var(--line);border-radius:7px;padding:.75rem;display:flex;align-items:center;gap:.7rem 1.2rem;flex-wrap:wrap}.controls small,.detail-picker small,.logs-picker small,.graph-picker small{color:var(--muted);flex:1}.toggle{white-space:nowrap}.empty,.notice{padding:.7rem;background:var(--soft);border-radius:5px}.source-message{margin-bottom:0}.session{background:var(--card);border:1px solid var(--line);border-radius:7px;margin:.7rem 0;overflow:hidden}.session>summary{cursor:pointer;display:grid;grid-template-columns:minmax(220px,1fr) auto auto;align-items:center;gap:1rem;padding:.8rem 1rem}.session>summary span:first-child{display:flex;flex-direction:column}.session>summary small{color:var(--muted)}.session>summary strong{color:var(--bad)}.pass-table-wrap{overflow-x:auto;border-top:1px solid var(--line)}.passes{width:100%;border-collapse:collapse;min-width:950px}.passes th,.passes td{text-align:left;padding:.55rem .7rem;border-bottom:1px solid var(--line);vertical-align:top}.passes th{color:var(--muted);font-size:.72rem;text-transform:uppercase;letter-spacing:.04em}.pass-detail{border:0;background:transparent;color:inherit;text-decoration:underline;cursor:pointer;padding:0}.pass-identity{display:flex;flex-direction:column}.pass-identity small{color:var(--muted)}.result{display:inline-block;font-size:.78rem;font-weight:650}.result.clean{color:var(--ok)}.result.issues{color:var(--bad)}.result.unknown{color:var(--warn)}.result.pending{color:var(--muted)}.live-unit,.run-card{background:var(--card);border:1px solid var(--line);border-top:4px solid var(--warn);border-radius:7px;padding:1rem;margin:.7rem 0}.live-unit.stalled{border-top-color:var(--bad)}.live-unit.stale{border-top-color:var(--stale)}.live-unit.waiting-predecessor{border-top-color:var(--warn)}.live-unit>header,.run-card>header{display:flex;justify-content:space-between;gap:.8rem}.live-unit header div{display:flex;gap:.6rem}.live-unit header small{color:var(--muted)}.live-unit header>strong{font-size:.8rem}.live-unit.stale header>strong{color:var(--stale)}.run-card.finished{border-top-color:var(--ok)}.run-card.error{border-top-color:var(--bad)}.run-card h2{font-size:1rem;margin:0;overflow-wrap:anywhere}.run-card header p{font-size:.72rem;color:var(--muted);margin:.2rem 0;overflow-wrap:anywhere}.state{border:1px solid currentColor;border-radius:999px;padding:.15rem .55rem;height:max-content;font-size:.75rem}.state.finished{color:var(--ok)}.state.error{color:var(--bad)}.state.running{color:var(--warn)}.current{display:grid;grid-template-columns:auto 1fr;gap:.2rem .65rem;background:var(--soft);padding:.7rem;margin:.8rem 0;border-radius:5px}.current span{color:var(--muted)}.current small{grid-column:2;color:var(--muted)}.stage-bar{display:grid;grid-template-columns:repeat(8,1fr);list-style:none;margin:.7rem 0 0;padding:0;gap:3px}.stage-bar li{height:.55rem;background:var(--line);position:relative}.stage-bar li.done{background:var(--ok)}.stage-bar li.current{background:var(--warn)}.stage-bar span{position:absolute;top:.65rem;font-size:.62rem;color:var(--muted);left:0}.stage-bar{margin-bottom:1.2rem}.run-card section{margin-top:1rem}h3{font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 .45rem}.verifier{display:grid;grid-template-columns:1fr auto;gap:.1rem .6rem;border-left:3px solid var(--line);padding:.45rem .6rem;margin:.35rem 0;background:var(--soft)}.verifier span,.verifier em{font-size:.75rem;color:var(--muted)}.verifier em{grid-column:1/-1}.verifier.fail-safe{border-color:var(--warn)}.verifier.reviewer:has(strong:first-of-type){border-color:var(--line)}.verifier-findings{grid-column:1/-1;margin-top:.35rem}.verifier-findings h4{font-size:.75rem;margin:.15rem 0}.verifier-findings pre,.prose,.command{margin:.2rem 0;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--card);border:1px solid var(--line);border-radius:4px;padding:.55rem;font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace}.command{white-space:pre;overflow:auto;flex:1}.copy-row{display:flex;align-items:start;gap:.5rem}.copy-row button{margin-top:.2rem}.tokens{display:grid;grid-template-columns:auto 1fr;gap:.25rem .6rem;margin:0}.tokens dt{font-weight:650}.tokens dd{margin:0;color:var(--muted);font-variant-numeric:tabular-nums}.rows,.stalls{list-style:none;margin:0;padding:0}.rows li,.stalls li{display:flex;justify-content:space-between;gap:.7rem;border-top:1px solid var(--line);padding:.35rem 0}.rows code{overflow-wrap:anywhere}.rows span{white-space:nowrap;color:var(--muted)}.exit-ok{color:var(--ok)!important}.exit-fail{color:var(--bad)!important}.stalls li{justify-content:flex-start;color:var(--bad)}.timeline{list-style:none;margin:0;padding:0;max-height:280px;overflow:auto}.timeline li{display:grid;grid-template-columns:4.8rem 5.5rem 1fr;gap:.35rem;border-left:2px solid var(--line);padding:.25rem .5rem}.timeline time,.timeline span,.timeline small{color:var(--muted)}.timeline small{grid-column:2/-1}.log-list{list-style:none;margin:.7rem 0;padding:0;background:var(--card);border:1px solid var(--line);border-radius:7px;overflow:hidden}.log-list.nested{margin:.55rem 0 0;border-radius:4px}.log-row{display:grid;grid-template-columns:12rem minmax(9rem,auto) minmax(10rem,auto) 1fr;gap:.25rem .7rem;padding:.55rem .7rem;border-top:1px solid var(--line);align-items:start}.log-row:first-child{border-top:0}.log-row time,.log-row span{color:var(--muted)}.log-run{overflow-wrap:anywhere}.raw-event{grid-column:1/-1}.raw-event summary,.log-collapse summary{cursor:pointer}.raw-event pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--soft);padding:.55rem;font:12px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}.log-collapse{padding:.55rem .7rem;border-top:1px solid var(--line)}.diff-capped{padding:.6rem;background:var(--soft);border-left:3px solid var(--warn)}.diff{margin:.35rem 0;max-height:65vh;overflow:auto;border:1px solid var(--line);background:var(--card);font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}.diff-line{display:block;min-height:1.5em;padding:0 .5rem;white-space:pre}.diff-add{background:var(--add);color:var(--ok)}.diff-remove{background:var(--remove);color:var(--bad)}.diff-hunk{color:var(--warn)}.graph-key{display:flex;gap:.45rem;align-items:center;flex-wrap:wrap;margin:.7rem 0}.graph-key span,.graph-key strong{border:1px solid var(--line);border-radius:999px;padding:.2rem .55rem;font-size:.75rem}.graph-key .waiting,.graph-key .running{border-color:var(--warn)}.graph-key .finished{border-color:var(--ok)}.graph-key .skipped{border-color:var(--bad)}.graph-frame{overflow:auto;background:var(--card);border:1px solid var(--line);border-radius:7px;min-height:240px}.campaign-graph{display:block;min-width:100%;height:auto}.graph-edge{fill:none;stroke:var(--muted);stroke-width:2;marker-end:url(#graph-arrow)}#graph-arrow path{fill:var(--muted)}.graph-node rect{fill:var(--card);stroke:var(--line);stroke-width:2}.graph-node.state-waiting rect,.graph-node.state-running rect{stroke:var(--warn)}.graph-node.state-finished rect{stroke:var(--ok)}.graph-node.state-skipped rect{stroke:var(--bad)}.graph-node.merge-unit>rect:first-of-type{stroke:var(--bad);stroke-width:4}.graph-node .merge-outline{fill:none;stroke:var(--bad);stroke-width:1.5}.graph-node-title{font-weight:700;font-size:13px;fill:var(--ink)}.graph-node-line{font-size:11px;fill:var(--muted)}
@media(max-width:700px){body>header{align-items:start;flex-direction:column}main{padding:.5rem}.session>summary{grid-template-columns:1fr}.controls,.logs-picker,.graph-picker{align-items:start;flex-direction:column}.stage-bar span{display:none}.stage-bar{margin-bottom:0}.log-row{grid-template-columns:1fr}.raw-event{grid-column:1}}
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
