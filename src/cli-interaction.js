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

export function formatHeadlessSetupSummary(outcomes, { scratchRoot } = {}) {
  const failing = outcomes.filter(({ check, outcome }) => (
    check.kind === 'required' && outcome.status === 'FAIL'
  ));
  if (failing.length === 0) return '';

  const lines = [
    'SETUP STATUS: prerequisite-incomplete',
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
