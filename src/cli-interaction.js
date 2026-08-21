import { remediationCommandText, selectedRemediation } from './remediation.js';
import { WAIT_NOT_ACKNOWLEDGED } from './interaction-signals.js';

export function createHeadlessInteraction({ yes = false, write = () => {} } = {}) {
  return {
    consent: async (_question, { commandText } = {}) => {
      if (!yes) write(`Consent refused in headless mode; NOT RUN: ${commandText}\n`);
      return yes;
    },
    wait: async () => WAIT_NOT_ACKNOWLEDGED,
  };
}

export function formatHeadlessSetupSummary(
  outcomes,
  { scratchRoot, status, restartRequired = [] } = {},
) {
  if (typeof status !== 'string' || status === '') {
    throw new TypeError('headless setup summary requires a status');
  }

  const failing = outcomes.filter(({ check, outcome }) => (
    check.kind === 'required' && outcome.status === 'FAIL'
  ));

  if (status === 'restart-required') {
    const restartIds = new Set(restartRequired);
    const awaitingRestart = restartIds.size > 0
      ? failing.filter(({ check }) => restartIds.has(check.id))
      : failing.filter(({ outcome }) => outcome.reason === 'not-on-path');
    const lines = [
      `SETUP STATUS: ${status}`,
      'Restart the terminal, then run setup again.',
      'Checks requiring restart:',
    ];
    for (const { check } of awaitingRestart) {
      lines.push(`RESTART REQUIRED: ${check.id}\t${check.name}`);
    }
    return `${lines.join('\n')}\n`;
  }

  if (status !== 'prerequisite-incomplete') return `SETUP STATUS: ${status}\n`;
  if (failing.length === 0) return '';

  const lines = [
    `SETUP STATUS: ${status}`,
    'Remaining required work:',
  ];
  for (const { check, outcome } of failing) {
    const remediation = selectedRemediation(check, outcome.remediationKey);
    const next = remediation?.command
      ? remediationCommandText(remediation.command, { scratchRoot })
      : remediation?.prose ?? outcome.detail;
    lines.push(`NEEDS: ${check.id}\t${check.name}\t${next}`);
  }
  return `${lines.join('\n')}\n`;
}
