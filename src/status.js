import { addUsage, EMPTY_USAGE } from './usage.js';
import {
  EVENTS_FILENAME,
  parsePartialEventStream,
  readEventStream,
} from './event-stream.js';

// Preserve the status module's public parser surface while both status and dashboard use
// the same implementation.
export { EVENTS_FILENAME, parsePartialEventStream };

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
