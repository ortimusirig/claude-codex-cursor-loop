import { fileURLToPath } from 'node:url';
import { spawnCapture } from './spawn.js';
import { reportEvent } from './events.js';
import { normalizeCursorUsage } from './usage.js';
import { resolveStageTimeouts } from './timeouts.js';

export const DEFAULT_VERIFIER_MODEL = 'cursor-grok-4.5-high';

const FORBIDDEN = ['--force', '--yolo', '-f', '--approve-mcps'];

export const VERIFIER_PLUGIN_DIR = fileURLToPath(new URL('../cursor-plugin', import.meta.url));

export function assertNoForbiddenFlags(args) {
  for (const f of FORBIDDEN) {
    if (args.includes(f)) throw new Error(`forbidden verifier flag: ${f}`);
  }
}

export const DEFAULT_PROMPT = '/ccc-verify Read CHANGES.diff and judge the change for correctness and blocking bugs; make the final line exactly NO_BLOCKERS or exactly ISSUES.';
export const INTENT_PROMPT = '/ccc-verify Read TASK.md and CHANGES.diff and judge whether the diff fully implements every TASK.md requirement and whether new or changed assertions detect broken behavior; make the final line exactly NO_BLOCKERS or exactly ISSUES.';

export function assertUsablePrompt(prompt) {
  if (prompt.includes('"')) throw new Error('verifier prompt must not contain a double quote');
  if (/[\r\n]/.test(prompt)) throw new Error('verifier prompt must be a single line');
  if (prompt.trim() === '') throw new Error('verifier prompt must not be empty');
}

export function buildCursorArgs({ model = DEFAULT_VERIFIER_MODEL, prompt = DEFAULT_PROMPT } = {}) {
  assertUsablePrompt(prompt);
  // --trust clears Cursor's "Workspace Trust Required" gate for READING the checkout; without
  // it the agent exits 1 with no output and every review defaults to fail-safe ISSUES. It is
  // NOT one of the forbidden flags (--force/--yolo/-f/--approve-mcps auto-APPROVE actions);
  // --mode plan keeps the agent read-only regardless. Verified live (exit 0, NO_BLOCKERS).
  const args = [
    '-p', prompt, '--output-format', 'stream-json', '--mode', 'plan', '--trust',
    '--plugin-dir', VERIFIER_PLUGIN_DIR, '--model', model,
  ];
  assertNoForbiddenFlags(args);
  return args;
}

export function extractPlanArtifact(streamText) {
  let artifact = null;
  for (const line of streamText.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let event;
    try { event = JSON.parse(s); } catch { continue; }
    if (event.type !== 'tool_call') continue;
    const args = event.tool_call?.createPlanToolCall?.args;
    if (!args || typeof args !== 'object' || Array.isArray(args)) continue;
    artifact = {
      name: typeof args.name === 'string' ? args.name : '',
      overview: typeof args.overview === 'string' ? args.overview : '',
      plan: typeof args.plan === 'string' ? args.plan : '',
    };
  }
  return artifact;
}

// The prompt asks the verifier to "briefly list the problems", so an ISSUES verdict
// carries reasoning worth keeping. parseVerdict answers only "may I treat this as
// clean?"; this returns that answer AND the text it was derived from.
function stripLeadingVerdictNoise(line) {
  let candidate = line.trimStart();
  let previous;
  do {
    previous = candidate;
    candidate = candidate
      .replace(/^#{1,6}\s*/, '')
      .replace(/^(?:[-+*]|\d+[.)]|•)\s+/, '')
      .replace(/^[*_`]+\s*/, '')
      .replace(/^(?:final\s+)?verdict\s*:\s*/i, '')
      .trimStart();
  } while (candidate !== previous);
  return candidate;
}

function finalLineVerdict(text) {
  const finalLine = text.split(/\r?\n/).findLast((line) => line.trim() !== '');
  if (finalLine === undefined) return null;

  let candidate = stripLeadingVerdictNoise(finalLine).trimEnd();
  let previous;
  do {
    previous = candidate;
    candidate = candidate
      .replace(/(?:[*_`]+|[.,!?;:…]+|#+)\s*$/, '')
      .trimEnd();
  } while (candidate !== previous);

  if (candidate === 'ISSUES') return 'ISSUES';
  if (candidate === 'NO_BLOCKERS') return 'NO_BLOCKERS';
  return null;
}

function planVerdict(text) {
  const verdicts = new Set();
  for (const line of text.split(/\r?\n/)) {
    const match = /^(NO_BLOCKERS|ISSUES)(?![A-Z0-9_])/.exec(stripLeadingVerdictNoise(line));
    if (match) verdicts.add(match[1]);
  }
  if (verdicts.has('ISSUES')) return 'ISSUES';
  if (verdicts.has('NO_BLOCKERS')) return 'NO_BLOCKERS';
  return null;
}

export function parseVerdictDetail(streamText) {
  let resultText = null;
  let resultSeen = false;
  let resultUsable = false;
  let lastAssistant = '';
  for (const line of streamText.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let item;
    try { item = JSON.parse(s); } catch { continue; }
    if (item.type === 'assistant' && item.message && Array.isArray(item.message.content)) {
      for (const part of item.message.content) {
        if (part && part.type === 'text' && typeof part.text === 'string') lastAssistant = part.text;
      }
    } else if (item.type === 'result') {
      resultSeen = true;
      resultUsable = !item.is_error && typeof item.result === 'string';
      resultText = resultUsable ? item.result : ''; // an errored result yields no verdict text
    }
  }
  const planText = extractPlanArtifact(streamText)?.plan ?? '';
  const resultVerdict = resultSeen && resultUsable ? finalLineVerdict(resultText) : null;
  if (resultVerdict) {
    return {
      verdict: resultVerdict,
      text: resultText,
      source: 'result',
      planText,
    };
  }

  // Preserve the fail-safe behavior of an invalid result event: its text is empty
  // and an earlier assistant message cannot turn the failed result into a clean one.
  const assistantVerdict = !resultSeen || resultUsable ? finalLineVerdict(lastAssistant) : null;
  if (assistantVerdict) {
    return {
      verdict: assistantVerdict,
      text: lastAssistant,
      source: 'assistant',
      planText,
    };
  }

  const text = resultText ?? lastAssistant;
  const artifactVerdict = planVerdict(planText);
  if (artifactVerdict) {
    return { verdict: artifactVerdict, text, source: 'plan', planText };
  }
  return { verdict: 'ISSUES', text, source: 'none', planText };
}

export function parseVerdict(streamText) {
  return parseVerdictDetail(streamText).verdict;
}

export function hasVerdictEvidence(streamText) {
  for (const line of streamText.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let item;
    try { item = JSON.parse(s); } catch { continue; }
    if (item.type === 'result' || item.type === 'assistant') return true;
  }
  return false;
}

// Cap on retained review text. Long enough for a real list of findings, short
// enough that ccc-runfacts.json stays readable.
export const FINDINGS_LIMIT = 4000;
export const PLAN_LIMIT = 8000;

function extractResultUsage(streamText) {
  let rawUsage;
  for (const line of streamText.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let event;
    try { event = JSON.parse(s); } catch { continue; }
    if (event.type === 'result') rawUsage = event.usage;
  }
  return normalizeCursorUsage(rawUsage);
}

function composePlanArtifact(artifact) {
  if (!artifact) return null;
  const parts = [];
  if (artifact.name.trim()) parts.push(`# ${artifact.name.trim()}`);
  if (artifact.overview.trim()) parts.push(artifact.overview.trim());
  if (artifact.plan.trim()) parts.push(artifact.plan.trim());
  return parts.join('\n\n');
}

export async function runVerifier({
  cwd,
  bin = 'agent',
  prompt = DEFAULT_PROMPT,
  extraArgv = [],
  model = DEFAULT_VERIFIER_MODEL,
  timeoutMs = resolveStageTimeouts().verifier,
  reporter,
  runId,
  pass,
}) {
  const args = [...extraArgv, ...buildCursorArgs({ prompt, model })];
  assertNoForbiddenFlags(args);
  reportEvent(reporter, runId, 'verify', 'start', { bin, args, model, pass });
  const r = await spawnCapture(bin, args, { cwd, timeoutMs });
  const { verdict, text, source } = parseVerdictDetail(r.stdout);
  const exitCode = r.code;
  const launchFailed = r.timedOut || (exitCode !== 0 && !hasVerdictEvidence(r.stdout));
  const usage = extractResultUsage(r.stdout);
  // A verdict without its reasoning is not actionable: report the findings on the
  // path where the verifier actually ran, mirroring how stderr is kept when it did not.
  const result = launchFailed
    ? { verdict, exitCode, launchFailed, timedOut: r.timedOut, timeoutMs: r.timeoutMs,
        stderr: r.stderr.slice(0, 500), verdictSource: source, usage }
    : {
        verdict,
        exitCode,
        launchFailed,
        timedOut: r.timedOut,
        timeoutMs: r.timeoutMs,
        findings: text.trim().slice(0, FINDINGS_LIMIT),
        verdictSource: source,
        plan: composePlanArtifact(extractPlanArtifact(r.stdout))?.slice(0, PLAN_LIMIT) ?? null,
        usage,
      };
  reportEvent(reporter, runId, 'verify', 'finish', {
    code: exitCode,
    verdict,
    source,
    tokens: usage,
    timedOut: r.timedOut,
    pass,
  });
  return result;
}
