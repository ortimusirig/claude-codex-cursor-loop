#!/usr/bin/env node

const [tool] = process.argv.slice(2);

if (tool === 'gitleaks') {
  process.stdout.write('[]');
} else if (tool === 'trufflehog') {
  // A clean TruffleHog JSON stream is empty.
} else if (tool === 'agent') {
  process.stdout.write(`${JSON.stringify({ type: 'result', result: 'CLEAN' })}\n`);
} else {
  process.stderr.write(`unsupported fake publish guard tool: ${tool ?? '(missing)'}\n`);
  process.exitCode = 2;
}
