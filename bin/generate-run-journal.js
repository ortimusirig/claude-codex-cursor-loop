#!/usr/bin/env node

import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateRunJournal, generateRunJournalCampaign } from '../src/run-journal.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

function usage() {
  return [
    'Usage:',
    '  node bin/generate-run-journal.js <run-directory-or-ccc-runfacts.json>',
    '  node bin/generate-run-journal.js --all <scratch-root>',
  ].join('\n');
}

function displayPath(path) {
  return relative(projectRoot, path).replaceAll('\\', '/');
}

function main(argv) {
  if (argv.length === 1 && argv[0] !== '--all' && argv[0] !== '--help') {
    const result = generateRunJournal(argv[0]);
    process.stdout.write(`${displayPath(result.notePath)}\n`);
    return;
  }
  if (argv.length === 2 && argv[0] === '--all') {
    const results = generateRunJournalCampaign(argv[1]);
    for (const result of results) process.stdout.write(`${displayPath(result.notePath)}\n`);
    return;
  }
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  process.stderr.write(`${usage()}\n`);
  process.exitCode = 2;
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`run-journal error: ${error.message}\n`);
  process.exitCode = 1;
}
