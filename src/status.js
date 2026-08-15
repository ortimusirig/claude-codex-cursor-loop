import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { addUsage, EMPTY_USAGE } from './usage.js';

export const EVENTS_FILENAME = 'events.jsonl';

function eventsPathFor(runDirectory) {
  const directory = resolve(runDirectory);
  if (!statSync(directory).isDirectory()) {
    throw new TypeError(`status path is not a directory: ${directory}`);
  }
  const candidates = [join(directory, EVENTS_FILENAME), join(directory, 'w', EVENTS_FILENAME)];
  const found = candidates.filter(existsSync);
  if (found.length === 1) return found[0];
  if (found.length > 1) {
    throw new Error(`run directory contains multiple ${EVENTS_FILENAME} files: ${directory}`);
  }
  throw new Error(`run directory does not contain ${EVENTS_FILENAME}: ${directory}`);
}

export function parsePartialEventStream(text, source = EVENTS_FILENAME) {
  const events = [];
  const lines = text.split(/\r?\n/);
  const finalLineIsComplete = /(?:\r?\n)$/.test(text);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (line === '') continue;
    try {
      const event = JSON.parse(line);
      if (event !== null && typeof event === 'object' && !Array.isArray(event)) events.push(event);
    } catch (error) {
      if (!finalLineIsComplete && index === lines.length - 1) break;
      throw new Error(`invalid JSON in ${source} at line ${index + 1}: ${error.message}`);
    }
  }
  return events;
}

function runIdsIn(events) {
  return [...new Set(events
    .map((event) => event?.runId)
    .filter((runId) => typeof runId === 'string' && runId !== ''))];
}

function runIdFor(eventsPath, events) {
  const eventDirectory = dirname(eventsPath);
  // Normal run layout is <scratch>/<runId>/w/events.jsonl. The directory is authoritative
  // even when copied or appended data makes the event file heterogeneous.
  if (basename(eventDirectory).toLowerCase() === 'w') return basename(dirname(eventDirectory));

  const pathRunId = basename(eventDirectory);
  const runIds = runIdsIn(events);
  if (runIds.includes(pathRunId)) return pathRunId;
  if (runIds.length === 1) return runIds[0];
  if (runIds.length === 0) return pathRunId;
  throw new Error(`cannot derive the requested run identity from mixed ${EVENTS_FILENAME}`);
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
  const eventsPath = eventsPathFor(runDirectory);
  const events = parsePartialEventStream(readFileSync(eventsPath, 'utf8'), eventsPath);
  const runId = runIdFor(eventsPath, events);
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
