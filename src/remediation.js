import { mkdirSync } from 'node:fs';
import { spawnCapture } from './spawn.js';

export function selectedRemediation(check, key) {
  if (key === undefined) return null;
  if (key === 'default') return check.remediation;
  const variant = check.remediation.variants?.[key];
  if (!variant) throw new Error(`unknown remediation variant ${check.id}:${key}`);
  return { ...check.remediation, ...variant };
}

function commandPath(path, inputs) {
  if (path?.from !== 'input' || typeof path.name !== 'string') {
    throw new Error('unsupported remediation path');
  }
  const value = inputs[path.name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`missing remediation input: ${path.name}`);
  }
  return value;
}

function quoteArgument(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(text)) return text;
  return process.platform === 'win32'
    ? `"${text.replaceAll('"', '""')}"`
    : `'${text.replaceAll("'", `'"'"'`)}'`;
}

export function remediationCommandText(command, inputs = {}) {
  if (command?.type === 'spawn') {
    return [command.binary, ...command.args].map(quoteArgument).join(' ');
  }
  if (command?.type === 'shell') return command.command;
  if (command?.type === 'mkdir') {
    return `mkdir ${quoteArgument(commandPath(command.path, inputs))}`;
  }
  throw new Error(`unsupported remediation command type: ${command?.type ?? 'none'}`);
}

export async function executeRemediation(command, inputs = {}) {
  if (command?.type === 'spawn') return spawnCapture(command.binary, command.args);
  if (command?.type === 'shell') {
    return command.platform === 'win32'
      ? spawnCapture('powershell.exe', ['-NoProfile', '-Command', command.command])
      : spawnCapture('/bin/sh', ['-c', command.command]);
  }
  if (command?.type === 'mkdir') {
    mkdirSync(commandPath(command.path, inputs), { recursive: command.recursive === true });
    return { code: 0, stdout: '', stderr: '', timedOut: false };
  }
  throw new Error(`unsupported remediation command type: ${command?.type ?? 'none'}`);
}

export function isAffirmative(answer) {
  if (answer === true) return true;
  return typeof answer === 'string' && /^(?:y|yes)$/i.test(answer.trim());
}

function executionSucceeded(result) {
  if (result?.ok === false || result?.timedOut === true) return false;
  return result?.code === undefined || result.code === 0;
}

export async function fixFailedCheck({
  check,
  outcome,
  inputs = {},
  consent,
  executor = executeRemediation,
  write = () => {},
}) {
  if (outcome?.status !== 'FAIL') return { status: 'not-failing', attempted: false };
  const remediation = selectedRemediation(check, outcome.remediationKey);
  if (!remediation?.autoFixable || !remediation.command) {
    return { status: 'report-only', attempted: false, remediation };
  }

  const commandText = remediationCommandText(remediation.command, inputs);
  write(`About to run: ${commandText}\n`);
  const answer = await consent(`Run this command? [y/N] `, { check, outcome, commandText });
  if (!isAffirmative(answer)) {
    return { status: 'declined', attempted: false, remediation, commandText };
  }

  try {
    const result = await executor(remediation.command, inputs);
    if (result?.stdout) write(result.stdout);
    if (result?.stderr) write(result.stderr);
    return {
      status: executionSucceeded(result) ? 'succeeded' : 'failed',
      attempted: true,
      remediation,
      commandText,
      result,
    };
  } catch (error) {
    return {
      status: 'failed',
      attempted: true,
      remediation,
      commandText,
      error,
    };
  }
}
