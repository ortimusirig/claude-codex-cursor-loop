export const EVENT_STAGES = Object.freeze([
  'isolate',
  'executor',
  'gate',
  'diff',
  'verify',
  'report',
]);

export const EVENT_TYPES = Object.freeze([
  'start',
  'finish',
  'file_change',
  'gate_command',
  'retry',
  'verdict',
  'stalled',
]);

const STAGES = new Set(EVENT_STAGES);
const TYPES = new Set(EVENT_TYPES);

export const MAX_EVENT_SUMMARY_LENGTH = 300;

export function createEvent({ runId, stage, type, fields = {}, now = () => new Date() }) {
  if (!STAGES.has(stage)) throw new TypeError(`unknown event stage: ${stage}`);
  if (!TYPES.has(type)) throw new TypeError(`unknown event type: ${type}`);
  if (typeof runId !== 'string' || runId === '') throw new TypeError('event runId must be a non-empty string');
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new TypeError('event fields must be an object');
  }

  // Core envelope fields cannot be shadowed by stage-specific data.
  const { ts: _ts, runId: _runId, stage: _stage, type: _type, ...stageFields } = fields;
  const timestamp = now();
  const ts = timestamp instanceof Date ? timestamp.toISOString() : String(timestamp);
  return { ts, runId, stage, type, ...stageFields };
}

// The guard deliberately happens before event construction: callers without a reporter
// do not pay for a timestamp, allocate an event, open a sink, or create an artifact.
export function reportEvent(reporter, runId, stage, type, fields) {
  if (typeof reporter !== 'function') return;
  try {
    const result = reporter(createEvent({ runId, stage, type, fields }));
    // Reporters are intended to be synchronous, but also swallow an accidentally async
    // reporter's rejection so observability can never become an unhandled run failure.
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch {
    // An event is disposable. The run is not.
  }
}

function oneLine(value) {
  return String(value ?? '')
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function command(event) {
  const args = Array.isArray(event.args) ? event.args.map(oneLine) : [];
  return [oneLine(event.bin), ...args].filter(Boolean).join(' ');
}

function detailFor(event) {
  const attempt = event.attempt === undefined ? '' : ` attempt=${event.attempt}`;
  if (event.type === 'stalled') {
    const last = event.lastEvent ?? {};
    return `gap=${oneLine(event.gapMs)}ms last=${oneLine(last.stage)}/${oneLine(last.type)}`;
  }
  if (event.stage === 'isolate') {
    return event.type === 'start'
      ? 'creating isolated copy'
      : `created ${oneLine(event.dir)} source=${oneLine(event.source)}`;
  }
  if (event.stage === 'executor' && event.type === 'retry') {
    return `starting retry${attempt} reason=${oneLine(event.reason)}`;
  }
  if (event.stage === 'executor' && event.type === 'file_change') {
    return `file=${oneLine(event.file)}${attempt}`;
  }
  if (event.stage === 'executor' && event.type === 'start') {
    return `started ${oneLine(event.bin)}${attempt}`;
  }
  if (event.stage === 'executor' && event.type === 'finish') {
    return `finished code=${oneLine(event.code)}${attempt}${event.timedOut ? ' timed-out' : ''}`;
  }
  if (event.stage === 'gate' && event.type === 'gate_command') {
    return `${command(event)} code=${oneLine(event.code)}${event.timedOut ? ' timed-out' : ''}`;
  }
  if (event.stage === 'gate') {
    return `${event.type === 'start' ? 'started' : 'finished'}${attempt}`
      + (event.verdict ? ` verdict=${oneLine(event.verdict)}` : '');
  }
  if (event.stage === 'diff') {
    return event.type === 'start' ? 'producing diff' : `finished verdict=${oneLine(event.verdict)}`;
  }
  if (event.stage === 'verify') {
    const pass = event.pass ? ` pass=${oneLine(event.pass)}` : '';
    const verdict = event.verdict ? ` verdict=${oneLine(event.verdict)}` : '';
    return `${event.type === 'start' ? 'started' : 'finished'}${pass}${verdict}`;
  }
  if (event.stage === 'report') {
    return event.type === 'start'
      ? 'writing report'
      : `written ${oneLine(event.file)}`;
  }
  return [command(event), oneLine(event.file), oneLine(event.verdict)].filter(Boolean).join(' ');
}

export function formatEventSummary(event, maxLength = MAX_EVENT_SUMMARY_LENGTH) {
  if (!Number.isSafeInteger(maxLength) || maxLength < 16) {
    throw new TypeError('maxLength must be a safe integer of at least 16');
  }
  const prefix = `[ccc] ${oneLine(event?.ts)} ${oneLine(event?.stage)}/${oneLine(event?.type)}`;
  const detail = detailFor(event ?? {});
  const line = oneLine(detail ? `${prefix} ${detail}` : prefix);
  return line.length <= maxLength ? line : `${line.slice(0, maxLength - 3)}...`;
}
