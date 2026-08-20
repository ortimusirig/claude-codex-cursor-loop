export const EVENT_STAGES = Object.freeze([
  'campaign',
  'round',
  'planner',
  'unit',
  'isolate',
  'merge',
  'executor',
  'gate',
  'diff',
  'verify',
  'report',
  'journal',
]);

export const EVENT_TYPES = Object.freeze([
  'start',
  'finish',
  'file_change',
  'item_completed',
  'gate_command',
  'retry',
  'verdict',
  'stalled',
  'not_dispatched',
  'waiting',
  'released',
  'skipped',
  'candidate_generated',
  'review_received',
  'synthesis',
]);

export const UNIT_KINDS = Object.freeze(['candidate', 'node', 'merge']);

// This is the declared (stage, type) vocabulary. Keeping pairs explicit prevents the
// stage and type allowlists from accidentally implying nonsensical combinations such as
// campaign/file_change. The conformance ratchet compares exercised emissions to this list.
export const EVENT_PAIRS = Object.freeze([
  'campaign/start',
  'campaign/finish',
  'round/start',
  'round/finish',
  'planner/candidate_generated',
  'planner/review_received',
  'planner/synthesis',
  'unit/start',
  'unit/finish',
  'unit/not_dispatched',
  'unit/waiting',
  'unit/released',
  'unit/skipped',
  'isolate/start',
  'isolate/finish',
  'isolate/stalled',
  'merge/start',
  'merge/finish',
  'merge/stalled',
  'executor/start',
  'executor/finish',
  'executor/file_change',
  'executor/item_completed',
  'executor/retry',
  'executor/stalled',
  'gate/start',
  'gate/finish',
  'gate/gate_command',
  'gate/stalled',
  'diff/start',
  'diff/finish',
  'diff/stalled',
  'verify/start',
  'verify/finish',
  'verify/verdict',
  'verify/stalled',
  'report/start',
  'report/finish',
  'report/stalled',
  'journal/start',
  'journal/finish',
]);

// The aggregate stream is intentionally smaller than a unit stream: the orchestrator is
// its only writer, and detailed executor/gate/verifier records remain one-writer-per-unit.
// This list is a second conformance surface for campaign boundaries and orchestration.
export const CAMPAIGN_EVENT_PAIRS = Object.freeze([
  'campaign/start',
  'campaign/finish',
  'round/start',
  'round/finish',
  'planner/candidate_generated',
  'planner/review_received',
  'planner/synthesis',
  'unit/start',
  'unit/finish',
  'unit/not_dispatched',
  'unit/waiting',
  'unit/released',
  'unit/skipped',
  'isolate/start',
  'isolate/finish',
  'merge/start',
  'merge/finish',
]);

const STAGES = new Set(EVENT_STAGES);
const TYPES = new Set(EVENT_TYPES);
const PAIRS = new Set(EVENT_PAIRS);
const KINDS = new Set(UNIT_KINDS);

export const MAX_EVENT_SUMMARY_LENGTH = 300;

export function createEvent({
  runId,
  campaignId,
  round,
  unitId,
  unitKind,
  stage,
  type,
  fields = {},
  now = () => new Date(),
}) {
  if (!STAGES.has(stage)) throw new TypeError(`unknown event stage: ${stage}`);
  if (!TYPES.has(type)) throw new TypeError(`unknown event type: ${type}`);
  if (!PAIRS.has(`${stage}/${type}`)) {
    throw new TypeError(`unknown event pair: ${stage}/${type}`);
  }
  if (typeof runId !== 'string' || runId === '') throw new TypeError('event runId must be a non-empty string');
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new TypeError('event fields must be an object');
  }

  const hasCampaignIdentity = [campaignId, round, unitId, unitKind]
    .some((value) => value !== undefined);
  if (hasCampaignIdentity) {
    if (typeof campaignId !== 'string' || campaignId === '') {
      throw new TypeError('event campaignId must be a non-empty string');
    }
    if (!Number.isSafeInteger(round) || round < 1) {
      throw new TypeError('event round must be a positive safe integer');
    }
    if (unitId !== null && (typeof unitId !== 'string' || unitId === '')) {
      throw new TypeError('event unitId must be null or a non-empty string');
    }
    if (unitKind !== null && !KINDS.has(unitKind)) {
      throw new TypeError(`unknown event unit kind: ${unitKind}`);
    }
    if ((unitId === null) !== (unitKind === null)) {
      throw new TypeError('event unitId and unitKind must both be null or both identify a unit');
    }
  }

  // Core envelope fields cannot be shadowed by stage-specific data.
  const {
    ts: _ts,
    runId: _runId,
    campaignId: _campaignId,
    round: _round,
    unitId: _unitId,
    unitKind: _unitKind,
    stage: _stage,
    type: _type,
    ...stageFields
  } = fields;
  const timestamp = now();
  const ts = timestamp instanceof Date ? timestamp.toISOString() : String(timestamp);
  return {
    ts,
    runId,
    ...(hasCampaignIdentity ? { campaignId, round, unitId, unitKind } : {}),
    stage,
    type,
    ...stageFields,
  };
}

export function identifyEvent(event, identity) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw new TypeError('event must be an object');
  }
  return createEvent({
    runId: event.runId,
    stage: event.stage,
    type: event.type,
    fields: event,
    now: () => event.ts,
    ...identity,
  });
}

export function assertEventConformance(events, {
  declaredStages = EVENT_STAGES,
  declaredTypes = EVENT_TYPES,
  declaredPairs = EVENT_PAIRS,
  allowUnemitted = [],
} = {}) {
  const stages = new Set(declaredStages);
  const types = new Set(declaredTypes);
  const declared = new Set(declaredPairs);
  const allowed = new Set(allowUnemitted);
  const parsedPairs = [...declared].map((pair) => {
    const [stage, type, extra] = String(pair).split('/');
    if (!stage || !type || extra !== undefined) {
      throw new Error(`invalid declared event pair: ${pair}`);
    }
    return { pair, stage, type };
  });
  const invalidPairs = parsedPairs
    .filter(({ stage, type }) => !stages.has(stage) || !types.has(type))
    .map(({ pair }) => pair);
  if (invalidPairs.length > 0) {
    throw new Error(`event pairs use undeclared stages or types: ${invalidPairs.join(', ')}`);
  }
  const stagesWithoutPairs = [...stages]
    .filter((stage) => !parsedPairs.some((pair) => pair.stage === stage));
  const typesWithoutPairs = [...types]
    .filter((type) => !parsedPairs.some((pair) => pair.type === type));
  if (stagesWithoutPairs.length > 0 || typesWithoutPairs.length > 0) {
    throw new Error([
      `declared stages without pairs: ${stagesWithoutPairs.join(', ') || '(none)'}`,
      `declared types without pairs: ${typesWithoutPairs.join(', ') || '(none)'}`,
    ].join('; '));
  }
  const undeclaredAllowlist = [...allowed].filter((pair) => !declared.has(pair));
  if (undeclaredAllowlist.length > 0) {
    throw new Error(`conformance allowlist contains undeclared pairs: ${undeclaredAllowlist.join(', ')}`);
  }
  const expected = new Set([...declared].filter((pair) => !allowed.has(pair)));
  const emitted = new Set(events.map((event) => `${event.stage}/${event.type}`));
  const missing = [...expected].filter((pair) => !emitted.has(pair));
  const unexpected = [...emitted].filter((pair) => !expected.has(pair));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error([
      'event vocabulary conformance failed',
      `missing: ${missing.join(', ') || '(none)'}`,
      `unexpected: ${unexpected.join(', ') || '(none)'}`,
    ].join('; '));
  }
}

// The guard deliberately happens before event construction: callers without a reporter
// do not pay for a timestamp, allocate an event, open a sink, or create an artifact.
export function reportEvent(reporter, runId, stage, type, fields, identity) {
  if (typeof reporter !== 'function') return;
  try {
    const result = reporter(createEvent({ runId, stage, type, fields, ...identity }));
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

export function detailFor(event) {
  const attempt = event.attempt === undefined ? '' : ` attempt=${event.attempt}`;
  if (event.type === 'stalled') {
    const last = event.lastEvent ?? {};
    return `gap=${oneLine(event.gapMs)}ms last=${oneLine(last.stage)}/${oneLine(last.type)}`;
  }
  if (event.stage === 'isolate') {
    if (event.scope === 'campaign-base') {
      return event.type === 'start'
        ? `preparing shared campaign base source=${oneLine(event.source)}`
        : `campaign base ${oneLine(event.verdict)} repository=${oneLine(event.repository)}`;
    }
    if (event.scope === 'candidate-test-baseline') {
      return event.type === 'start'
        ? `measuring candidate test baseline commit=${oneLine(event.baseRef)}`
        : `candidate test baseline ${oneLine(event.verdict)}`
          + ` gate=${oneLine(event.gateTestCount)} files=${oneLine(event.testFileCount)}`;
    }
    if (event.scope === 'campaign-result') {
      return event.type === 'start'
        ? `recording campaign result branch=${oneLine(event.branch)}`
        : `campaign result ${oneLine(event.verdict)} commit=${oneLine(event.commit)}`;
    }
    return event.type === 'start'
      ? `creating isolated copy base=${oneLine(event.baseRef)} branch=${oneLine(event.branch)}`
      : `created ${oneLine(event.dir)} source=${oneLine(event.source)} `
        + `base=${oneLine(event.baseRef)} branch=${oneLine(event.branch)}`;
  }
  if (event.stage === 'executor' && event.type === 'retry') {
    return `starting retry${attempt} reason=${oneLine(event.reason)}`;
  }
  if (event.stage === 'executor' && event.type === 'file_change') {
    return `file=${oneLine(event.file)}${attempt}`;
  }
  if (event.stage === 'executor' && event.type === 'item_completed') {
    return `item=${oneLine(event.itemType)}${attempt}`;
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
  if (event.stage === 'campaign') {
    return event.type === 'start'
      ? `started units=${oneLine(event.unitCount)} shape=${oneLine(event.campaignShape)}`
      : `finished outcome=${oneLine(event.outcome)}`;
  }
  if (event.stage === 'round') {
    return `${event.type === 'start' ? 'started' : 'finished'} round=${oneLine(event.round)}`;
  }
  if (event.stage === 'planner') {
    if (event.type === 'candidate_generated') {
      return `candidate=${oneLine(event.unitId)} perspective=${oneLine(event.perspective)}`;
    }
    if (event.type === 'review_received') {
      return `reviews unit=${oneLine(event.unitId)} complete=${oneLine(event.complete)}`
        + (event.perspective ? ` perspective=${oneLine(event.perspective)}` : '')
        + ` correctness=${oneLine(event.correctness?.verdict)}`
        + ` intent=${oneLine(event.intent?.verdict)}`;
    }
    return `synthesis=${oneLine(event.decision)} reasoning=${oneLine(event.reasoning)}`;
  }
  if (event.stage === 'unit') {
    if (event.type === 'not_dispatched') {
      return `unit=${oneLine(event.unitId)} kind=${oneLine(event.unitKind)} not-dispatched reason=${oneLine(event.reason)}`;
    }
    if (event.type === 'waiting') {
      const predecessors = Array.isArray(event.predecessorUnitIds)
        ? event.predecessorUnitIds.join(',')
        : event.predecessorUnitId;
      return `unit=${oneLine(event.unitId)} kind=${oneLine(event.unitKind)} waiting on predecessor=${oneLine(predecessors)}`;
    }
    if (event.type === 'released') {
      const predecessors = Array.isArray(event.predecessorUnitIds)
        ? event.predecessorUnitIds.join(',')
        : event.predecessorUnitId;
      return `unit=${oneLine(event.unitId)} kind=${oneLine(event.unitKind)} released by predecessor=${oneLine(predecessors)}`
        + ` base=${oneLine(event.baseRef)}`;
    }
    if (event.type === 'skipped') {
      return `unit=${oneLine(event.unitId)} kind=${oneLine(event.unitKind)} skipped reason=${oneLine(event.reason)}`
        + ` predecessor=${oneLine(event.predecessorUnitId)}`
        + ` blocked-by=${oneLine(event.blockedByUnitId)}/${oneLine(event.blockedByOutcome)}`;
    }
    return `unit=${oneLine(event.unitId)} kind=${oneLine(event.unitKind)} ${event.type}`
      + (event.outcome ? ` outcome=${oneLine(event.outcome)}` : '');
  }
  if (event.stage === 'merge') {
    return event.type === 'start'
      ? `preparing parents=${oneLine(event.parentUnitIds?.join(','))}`
      : `finished verdict=${oneLine(event.verdict)} reason=${oneLine(event.reason)}`;
  }
  if (event.stage === 'journal') {
    return event.type === 'start'
      ? `generating from=${oneLine(event.factsPath)}`
      : `written ${oneLine(event.file ?? event.notePath)}`;
  }
  return [command(event), oneLine(event.file), oneLine(event.verdict)].filter(Boolean).join(' ');
}

export function formatEventSummary(event, maxLength = MAX_EVENT_SUMMARY_LENGTH) {
  if (!Number.isSafeInteger(maxLength) || maxLength < 16) {
    throw new TypeError('maxLength must be a safe integer of at least 16');
  }
  const prefix = `[uroboros] ${oneLine(event?.ts)} ${oneLine(event?.stage)}/${oneLine(event?.type)}`;
  const detail = detailFor(event ?? {});
  const line = oneLine(detail ? `${prefix} ${detail}` : prefix);
  return line.length <= maxLength ? line : `${line.slice(0, maxLength - 3)}...`;
}
