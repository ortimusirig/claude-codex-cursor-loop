import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--version') {
  process.stdout.write('git version 2.99.0-doctor-stub\n');
} else if (args[0] === 'init') {
  mkdirSync(join(process.cwd(), '.git'), { recursive: true });
} else if (args[0] === 'add' || args.includes('commit')) {
  // The doctor only needs these commands to prepare its disposable probe repository.
} else if (args[0] === '-C' && args[2] === 'remote' && args[3] === '-v') {
  if (process.env.CCC_FAKE_GITHUB_REMOTE === 'yes') {
    process.stdout.write('origin\thttps://github.com/acme/example.git (fetch)\n');
  } else {
    process.exitCode = 1;
  }
} else {
  process.stderr.write(`unsupported fake git command: ${args.join(' ')}\n`);
  process.exitCode = 2;
}

