import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readEventStream } from './event-stream.js';
import { detailFor } from './events.js';

export const COLLAPSIBLE_EVENT_PAIR = 'executor/item_completed';

export class LogRunNotFoundError extends Error {
  constructor(runId) {
    super(`pass not found: ${runId}`);
    this.name = 'LogRunNotFoundError';
    this.code = 'RUN_NOT_FOUND';
    this.runId = runId;
  }
}

function timestampMs(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function eventRow(event, sourceRunId, encounter) {
  return {
    ...event,
    kind: 'event',
    runId: sourceRunId,
    sourceRunId,
    detail: detailFor(event),
    event,
    _encounter: encounter,
  };
}

export function isProblemEvent(event) {
  const hasNonZeroCode = typeof event?.code === 'number'
    && Number.isFinite(event.code)
    && event.code !== 0;
  return hasNonZeroCode
    || event?.timedOut === true
    || event?.type === 'stalled'
    || event?.verdict === 'ISSUES'
    || event?.verdictSource === 'none';
}

export function isCollapsibleEvent(event) {
  return event?.stage === 'executor' && event?.type === 'item_completed';
}

export function collapseLogRows(rows) {
  const collapsed = [];
  for (let index = 0; index < rows.length;) {
    const row = rows[index];
    if (!isCollapsibleEvent(row.event ?? row)) {
      collapsed.push(row);
      index += 1;
      continue;
    }
    const children = [];
    while (index < rows.length && isCollapsibleEvent(rows[index].event ?? rows[index])) {
      children.push(rows[index]);
      index += 1;
    }
    const runIds = [...new Set(children.map((child) => child.runId))];
    const records = children.map((child) => child.event ?? child);
    collapsed.push({
      kind: 'group',
      groupType: COLLAPSIBLE_EVENT_PAIR,
      count: children.length,
      runId: runIds.length === 1 ? runIds[0] : null,
      runIds,
      rows: children,
      records,
      events: records,
    });
  }
  return collapsed;
}

function directoriesUnderScratch(scratchRoot) {
  const root = resolve(scratchRoot);
  let stat;
  try {
    stat = statSync(root);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  if (!stat.isDirectory()) throw new TypeError(`scratch root is not a directory: ${root}`);
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => join(root, entry.name));
}

function streamsFor({ runDirectory, scratchRoot }) {
  if (Boolean(runDirectory) === Boolean(scratchRoot)) {
    throw new TypeError('log query requires exactly one of runDirectory or scratchRoot');
  }
  const directories = runDirectory ? [resolve(runDirectory)] : directoriesUnderScratch(scratchRoot);
  return directories.map((directory) => readEventStream(directory, { allowMissing: true }));
}

/**
 * Read and query raw run event streams. Event rows retain the exact parsed record as
 * `event` (and expose its fields at the top level); group rows retain every folded
 * event row in `rows` and every exact parsed record in `records`.
 */
export function queryLogs({
  runDirectory,
  scratchRoot,
  runId = null,
  problemsOnly = false,
  collapse = true,
} = {}) {
  const streams = streamsFor({ runDirectory, scratchRoot });
  const requestedRunId = runId === null || runId === '' || runId === 'all' ? null : runId;
  const selected = requestedRunId === null
    ? streams
    : streams.filter((stream) => stream.runId === requestedRunId);
  if (requestedRunId !== null && selected.length === 0) {
    throw new LogRunNotFoundError(requestedRunId);
  }

  let encounter = 0;
  const rows = selected.flatMap((stream) => stream.events.map((event) => (
    eventRow(event, stream.runId, encounter++)
  )));
  rows.sort((left, right) => {
    const leftTime = timestampMs(left.ts);
    const rightTime = timestampMs(right.ts);
    if (leftTime === null && rightTime === null) return left._encounter - right._encounter;
    if (leftTime === null) return 1;
    if (rightTime === null) return -1;
    return leftTime - rightTime || left._encounter - right._encounter;
  });
  const filtered = problemsOnly ? rows.filter((row) => isProblemEvent(row.event)) : rows;
  for (const row of filtered) delete row._encounter;
  return collapse ? collapseLogRows(filtered) : filtered;
}
