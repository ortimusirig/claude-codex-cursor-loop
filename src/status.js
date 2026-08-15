import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  CAMPAIGN_EVENTS_FILENAME,
  EVENTS_FILENAME,
  parsePartialEventStream,
  readCampaignEventStream,
  readEventStream,
} from './event-stream.js';
import { addUsage, EMPTY_USAGE } from './usage.js';

// Preserve the status module's public parser surface while both status and dashboard use
// the same implementation.
export { CAMPAIGN_EVENTS_FILENAME, EVENTS_FILENAME, parsePartialEventStream };

function runIdsIn(events) {
  return [...new Set(events
    .map((event) => event?.runId)
    .filter((runId) => typeof runId === 'string' && runId !== ''))];
}

export function digestEvents(events, now = Date.now(), requestedRunId = null) {
  const runIds = runIdsIn(events);
  const runId = requestedRunId ?? (runIds.length === 1 ? runIds[0] : null);
  if (runId === null && runIds.length > 1) {
    throw new Error(`a runId is required to digest mixed ${EVENTS_FILENAME}`);
  }
  const runEvents = events.filter((event) => event?.runId === runId);
  const files = [];
  const seenFiles = new Set();
  const gateCommands = [];
  const stalls = [];
  let tokens = EMPTY_USAGE;
  for (const event of runEvents) {
    if (event?.type === 'file_change' && typeof event.file === 'string'
      && !seenFiles.has(event.file)) {
      seenFiles.add(event.file);
      files.push(event.file);
    }
    if (event?.type === 'gate_command') {
      gateCommands.push({ bin: event.bin, args: event.args, code: event.code });
    }
    if (event?.type === 'stalled') stalls.push(event);
    if (event?.tokens) tokens = addUsage(tokens, event.tokens);
  }
  const lastEvent = runEvents.at(-1) ?? null;
  const timestamp = Date.parse(lastEvent?.ts);
  const gapMs = Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : null;
  return {
    runId,
    runIds,
    otherRunIds: runIds.filter((candidate) => candidate !== runId),
    currentStage: lastEvent?.stage ?? null,
    currentType: lastEvent?.type ?? null,
    lastEvent,
    gapMs,
    files,
    gateCommands,
    tokens,
    stalls,
  };
}

export function readRunStatus(runDirectory, { now = Date.now() } = {}) {
  const { eventsPath, events, runId } = readEventStream(runDirectory);
  return { eventsPath, ...digestEvents(events, now, runId) };
}

function unitState(event, previous) {
  if (event.stage !== 'unit') return previous;
  if (event.type === 'start') return 'in-flight';
  if (event.type === 'finish') return 'finished';
  if (event.type === 'waiting') return 'waiting';
  if (event.type === 'released') return 'ready';
  if (event.type === 'skipped') return 'skipped';
  if (event.type === 'not_dispatched') return 'not-dispatched';
  return previous;
}

export function digestCampaignEvents(events, now = Date.now(), requestedCampaignId = null) {
  const campaignIds = [...new Set(events
    .map((event) => event?.campaignId)
    .filter((campaignId) => typeof campaignId === 'string' && campaignId !== ''))];
  const campaignId = requestedCampaignId ?? (campaignIds.length === 1 ? campaignIds[0] : null);
  if (campaignId === null && campaignIds.length > 1) {
    throw new Error(`a campaignId is required to digest mixed ${CAMPAIGN_EVENTS_FILENAME}`);
  }
  const campaignEvents = events.filter((event) => event?.campaignId === campaignId);
  const units = new Map();
  const rounds = new Map();
  let synthesis = null;
  for (const event of campaignEvents) {
    if (Number.isSafeInteger(event.round)) {
      const value = rounds.get(event.round) ?? {
        round: event.round,
        state: 'observed',
        outcome: null,
      };
      if (event.stage === 'round' && event.type === 'start') value.state = 'running';
      if (event.stage === 'round' && event.type === 'finish') {
        value.state = 'finished';
        value.outcome = event.outcome ?? null;
      }
      rounds.set(event.round, value);
    }
    if (event.stage === 'planner' && event.type === 'synthesis') synthesis = event;
    if (typeof event.unitId !== 'string' || event.unitId === '') continue;
    const unit = units.get(event.unitId) ?? {
      unitId: event.unitId,
      unitKind: event.unitKind ?? null,
      round: event.round ?? null,
      state: 'observed',
      outcome: null,
      perspective: null,
      reviewsComplete: null,
      currentStage: null,
      currentType: null,
      lastEvent: null,
    };
    unit.unitKind ??= event.unitKind ?? null;
    unit.round ??= event.round ?? null;
    unit.state = unitState(event, unit.state);
    if (event.stage === 'unit' && event.type === 'finish') unit.outcome = event.outcome ?? null;
    if (event.stage === 'planner' && event.type === 'candidate_generated') {
      unit.perspective = event.perspective ?? null;
    }
    if (event.stage === 'planner' && event.type === 'review_received') {
      unit.reviewsComplete = event.complete === true;
    }
    unit.currentStage = event.stage ?? null;
    unit.currentType = event.type ?? null;
    unit.lastEvent = event;
    units.set(event.unitId, unit);
  }
  const lastEvent = campaignEvents.at(-1) ?? null;
  const timestamp = Date.parse(lastEvent?.ts);
  return {
    mode: 'campaign',
    campaignId,
    campaignIds,
    currentStage: lastEvent?.stage ?? null,
    currentType: lastEvent?.type ?? null,
    lastEvent,
    gapMs: Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : null,
    rounds: [...rounds.values()].sort((left, right) => left.round - right.round),
    units: [...units.values()],
    synthesis,
  };
}

export function readCampaignStatus(campaignDirectory, { now = Date.now() } = {}) {
  const { eventsPath, events, campaignId } = readCampaignEventStream(campaignDirectory);
  return { eventsPath, ...digestCampaignEvents(events, now, campaignId) };
}

export function readStatus(directory, options) {
  const resolved = resolve(directory);
  return existsSync(join(resolved, CAMPAIGN_EVENTS_FILENAME))
    ? readCampaignStatus(resolved, options)
    : { mode: 'run', ...readRunStatus(resolved, options) };
}

function duration(ms) {
  if (ms === null) return 'unknown';
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function commandLine(command) {
  return [command.bin, ...(Array.isArray(command.args) ? command.args : [])]
    .filter((part) => part !== undefined)
    .join(' ');
}

export function formatRunStatus(status) {
  const lines = [
    `Run: ${status.runId ?? '(unknown)'}`,
    `Current stage: ${status.currentStage ?? '(none)'}` +
      (status.currentType ? ` (${status.currentType})` : ''),
    `Since last event: ${duration(status.gapMs)}`,
    `Files changed (${status.files.length}): ${status.files.join(', ') || '(none)'}`,
    `Tokens: input ${status.tokens.inputTokens}; cached ${status.tokens.cachedInputTokens}; ` +
      `output ${status.tokens.outputTokens}; reasoning ${status.tokens.reasoningOutputTokens}; ` +
      `cache write ${status.tokens.cacheWriteTokens}`,
  ];
  if (status.otherRunIds?.length > 0) {
    lines.splice(1, 0, `Note: ${EVENTS_FILENAME} contains ${status.runIds.length} runs; ` +
      `showing only ${status.runId}.`);
  }
  lines.push(`Gate commands (${status.gateCommands.length}):`);
  for (const command of status.gateCommands) {
    lines.push(`  ${commandLine(command)} -> ${command.code}`);
  }
  if (status.gateCommands.length === 0) lines.push('  (none)');
  lines.push(`Stalls (${status.stalls.length}):`);
  for (const stall of status.stalls) {
    const last = stall.lastEvent ?? {};
    lines.push(`  ${stall.stage}: ${duration(stall.gapMs)} after ` +
      `${last.stage ?? 'unknown'}/${last.type ?? 'unknown'}`);
  }
  if (status.stalls.length === 0) lines.push('  (none)');
  return `${lines.join('\n')}\n`;
}

export function formatCampaignStatus(status) {
  const lines = [
    `Campaign: ${status.campaignId ?? '(unknown)'}`,
    `Current stage: ${status.currentStage ?? '(none)'}`
      + (status.currentType ? ` (${status.currentType})` : ''),
    `Since last event: ${duration(status.gapMs)}`,
    `Rounds (${status.rounds.length}):`,
  ];
  if (status.rounds.length === 0) lines.push('  (none)');
  for (const round of status.rounds) {
    lines.push(`  ${round.round}: ${round.state}${round.outcome ? ` -> ${round.outcome}` : ''}`);
  }
  lines.push(`Units (${status.units.length}):`);
  if (status.units.length === 0) lines.push('  (none)');
  for (const unit of status.units) {
    const details = [
      unit.outcome ? `outcome ${unit.outcome}` : '',
      unit.perspective ? `perspective ${unit.perspective}` : '',
      unit.reviewsComplete === null ? '' : `reviews ${unit.reviewsComplete ? 'complete' : 'incomplete'}`,
      unit.currentStage ? `last ${unit.currentStage}/${unit.currentType}` : '',
    ].filter(Boolean).join('; ');
    lines.push(`  ${unit.unitId} [${unit.unitKind ?? 'unknown'}]: ${unit.state}`
      + (details ? `; ${details}` : ''));
  }
  if (status.synthesis) {
    lines.push(`Synthesis: ${status.synthesis.decision ?? '(unknown)'}`);
    lines.push(`Reasoning: ${status.synthesis.reasoning ?? '(none)'}`);
  } else {
    lines.push('Synthesis: (none)');
  }
  return `${lines.join('\n')}\n`;
}

export function formatStatus(status) {
  return status?.mode === 'campaign' ? formatCampaignStatus(status) : formatRunStatus(status);
}
