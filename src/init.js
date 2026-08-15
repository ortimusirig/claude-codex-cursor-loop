import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

export const PLAN_TEMPLATE = `# Task

Describe the user-visible outcome and why it matters.

## Required behavior

- State the behavior that must be added or changed.
- State the observable result, including failure behavior and exit codes where relevant.

## Invariants

- State what must remain true after the change, not only the implementation steps.
- Preserve existing product behavior and supported project shapes unless a change is explicit here.
- Keep tests independent of the checkout path, current working directory, and run time.

## Out of scope

- List behavior, interfaces, defaults, and integrations that must not change.

## Test requirements

- Add assertions that fail when the requested feature is broken, with a positive control when absence is asserted.
- Do not write instructions that quietly narrow the product to make the task easier.
- Do not use fixtures that erase the signal by making correct and incorrect implementations look the same.
- Do not delete, skip, or weaken existing tests.
`;

function detectedGate(directory) {
  const packagePath = join(directory, 'package.json');
  if (existsSync(packagePath)) {
    try {
      const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
      if (typeof pkg?.scripts?.test === 'string' && pkg.scripts.test.trim() !== '') {
        return [{
          _comment: 'Detected package.json scripts.test. Gate pass/fail uses this command\'s exit code.',
          bin: 'npm',
          args: ['test'],
        }];
      }
    } catch {
      // A malformed package manifest is not a reason to generate malformed scaffolding.
      // The runnable fallback tells the user to replace it with the real project gate.
    }
  }
  return [{
    _comment: 'Runnable placeholder: replace this object with your real test/lint/build command. Gate pass/fail uses only the command exit code.',
    bin: 'node',
    args: ['-e', "console.log('Gate placeholder passed. Replace it with a real project check.')"],
  }];
}

function writePairWithoutOverwrite(planPath, gatePath, gateText) {
  let planHandle;
  let gateHandle;
  try {
    planHandle = openSync(planPath, 'wx');
    gateHandle = openSync(gatePath, 'wx');
    writeFileSync(planHandle, PLAN_TEMPLATE, 'utf8');
    writeFileSync(gateHandle, gateText, 'utf8');
  } catch (error) {
    if (planHandle !== undefined) closeSync(planHandle);
    if (gateHandle !== undefined) closeSync(gateHandle);
    if (planHandle !== undefined) rmSync(planPath, { force: true });
    if (gateHandle !== undefined) rmSync(gatePath, { force: true });
    if (error?.code === 'EEXIST') {
      throw new Error('refusing to overwrite an existing plan.md or gate.json');
    }
    throw error;
  }
  closeSync(planHandle);
  closeSync(gateHandle);
}

export function scaffold(directory) {
  const destination = resolve(directory);
  const planPath = join(destination, 'plan.md');
  const gatePath = join(destination, 'gate.json');
  const conflicts = [planPath, gatePath].filter(existsSync);
  if (conflicts.length > 0) {
    throw new Error(`refusing to overwrite existing file${conflicts.length === 1 ? '' : 's'}: ${conflicts.join(', ')}`);
  }

  mkdirSync(destination, { recursive: true });
  const gateText = `${JSON.stringify(detectedGate(destination), null, 2)}\n`;
  writePairWithoutOverwrite(planPath, gatePath, gateText);
  return { directory: destination, planPath, gatePath };
}

