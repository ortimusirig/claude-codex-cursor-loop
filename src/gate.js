import { spawnCapture } from './spawn.js';
import { reportEvent } from './events.js';
import { resolveStageTimeouts } from './timeouts.js';

export const GATE_TAIL_LIMIT = 4000;

function outputTail(stdout, stderr) {
  const stdoutLabel = '[stdout]\n';
  const stderrLabel = '\n[stderr]\n';
  const contentLimit = GATE_TAIL_LIMIT - stdoutLabel.length - stderrLabel.length;
  let stdoutLimit = Math.min(stdout.length, Math.floor(contentLimit / 2));
  let stderrLimit = Math.min(stderr.length, Math.floor(contentLimit / 2));
  let remaining = contentLimit - stdoutLimit - stderrLimit;

  const extraStdout = Math.min(remaining, stdout.length - stdoutLimit);
  stdoutLimit += extraStdout;
  remaining -= extraStdout;
  stderrLimit += Math.min(remaining, stderr.length - stderrLimit);

  // `s.slice(-0)` is `s.slice(0)` — the WHOLE string, not the empty tail the arithmetic
  // intends. Unreachable while GATE_TAIL_LIMIT is 4000, but it would turn a shrunk limit
  // into an unbounded report, so take the tail through a guard rather than by luck.
  const tail = (s, n) => (n > 0 ? s.slice(-n) : '');
  return `${stdoutLabel}${tail(stdout, stdoutLimit)}${stderrLabel}${tail(stderr, stderrLimit)}`;
}

export async function runGate({
  commands,
  cwd,
  timeoutMs = resolveStageTimeouts().gate,
  reporter,
  runId,
  attempt,
}) {
  const results = [];
  reportEvent(reporter, runId, 'gate', 'start', { attempt });
  for (const cmd of commands) {
    const r = await spawnCapture(cmd.bin, cmd.args, { cwd, timeoutMs });
    const result = { bin: cmd.bin, args: cmd.args, code: r.code };
    reportEvent(reporter, runId, 'gate', 'gate_command', {
      ...result, timedOut: r.timedOut, attempt,
    });
    if (r.code !== 0) {
      results.push({
        ...result,
        ...(r.timedOut ? { timedOut: true, timeoutMs: r.timeoutMs } : {}),
        outputTail: outputTail(r.stdout, r.stderr),
      });
      reportEvent(reporter, runId, 'gate', 'finish', {
        verdict: 'failed', code: r.code, attempt,
      });
      return { passed: false, results };
    }
    results.push(result);
  }
  reportEvent(reporter, runId, 'gate', 'finish', { verdict: 'passed', attempt });
  return { passed: true, results };
}
