import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export const EVENTS_FILENAME = 'events.jsonl';

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
      // appendFile can expose the last record between writes. It is not an event until it
      // parses, so readers retain no partial state and simply see it on their next read.
      if (!finalLineIsComplete && index === lines.length - 1) break;
      throw new Error(`invalid JSON in ${source} at line ${index + 1}: ${error.message}`);
    }
  }
  return events;
}

export function locateEventStream(runDirectory, { allowMissing = false } = {}) {
  const directory = resolve(runDirectory);
  let stat;
  try {
    stat = statSync(directory);
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') {
      return { directory, eventsPath: null, directoryExists: false };
    }
    throw error;
  }
  if (!stat.isDirectory()) {
    throw new TypeError(`status path is not a directory: ${directory}`);
  }

  const candidates = [join(directory, EVENTS_FILENAME), join(directory, 'w', EVENTS_FILENAME)];
  const found = candidates.filter(existsSync);
  if (found.length === 1) {
    return { directory, eventsPath: found[0], directoryExists: true };
  }
  if (found.length > 1) {
    throw new Error(`run directory contains multiple ${EVENTS_FILENAME} files: ${directory}`);
  }
  if (allowMissing) return { directory, eventsPath: null, directoryExists: true };
  throw new Error(`run directory does not contain ${EVENTS_FILENAME}: ${directory}`);
}

function runIdsIn(events) {
  return [...new Set(events
    .map((event) => event?.runId)
    .filter((runId) => typeof runId === 'string' && runId !== ''))];
}

export function runIdForEventStream(eventsPath, events, runDirectory = dirname(eventsPath)) {
  const eventDirectory = dirname(eventsPath);
  // Normal run layout is <scratch>/<runId>/w/events.jsonl. The directory is authoritative
  // even when copied or appended data makes the event file heterogeneous.
  if (basename(eventDirectory).toLowerCase() === 'w') return basename(dirname(eventDirectory));

  const pathRunId = basename(eventDirectory || resolve(runDirectory));
  const runIds = runIdsIn(events);
  if (runIds.includes(pathRunId)) return pathRunId;
  if (runIds.length === 1) return runIds[0];
  if (runIds.length === 0) return pathRunId;
  throw new Error(`cannot derive the requested run identity from mixed ${EVENTS_FILENAME}`);
}

export function prospectiveRunId(runDirectory) {
  const directory = resolve(runDirectory);
  return basename(directory).toLowerCase() === 'w'
    ? basename(dirname(directory))
    : basename(directory);
}

export function readEventStream(runDirectory, { allowMissing = false } = {}) {
  const located = locateEventStream(runDirectory, { allowMissing });
  if (located.eventsPath === null) {
    return { ...located, runId: prospectiveRunId(located.directory), events: [] };
  }
  const events = parsePartialEventStream(
    readFileSync(located.eventsPath, { encoding: 'utf8', flag: 'r' }),
    located.eventsPath,
  );
  return {
    ...located,
    runId: runIdForEventStream(located.eventsPath, events, located.directory),
    events,
  };
}
