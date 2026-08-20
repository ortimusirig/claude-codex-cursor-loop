#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const statePath = process.env.URO_FAKE_GH_STATE;
if (!statePath) {
  process.stderr.write('URO_FAKE_GH_STATE is required\n');
  process.exitCode = 2;
} else {
  const state = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, 'utf8'))
    : { calls: [], createCount: 0, editCount: 0, comments: [] };
  const args = process.argv.slice(2);
  const command = args.slice(0, 2).join(' ');
  state.calls.push(args);
  const save = () => writeFileSync(statePath, JSON.stringify(state));
  const option = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? null : args[index + 1];
  };
  const body = () => option('--body-file') === '-'
    ? readFileSync(0, 'utf8')
    : option('--body');

  if (command === 'auth status') {
    save();
    if (process.env.URO_FAKE_GH_AUTH === 'fail') {
      process.stderr.write('not logged in\n');
      process.exitCode = 1;
    }
  } else if (process.env.URO_FAKE_GH_FAIL === command) {
    save();
    process.stderr.write(`configured failure for ${command}\n`);
    process.exitCode = 1;
  } else if (command === 'pr list') {
    save();
    process.stdout.write(JSON.stringify(state.pull && state.pull.open !== false
      ? [{ number: state.pull.number, url: state.pull.url }]
      : []));
  } else if (command === 'pr create') {
    state.createCount++;
    state.pull = {
      number: 42,
      url: 'https://github.com/acme/widgets/pull/42',
      title: option('--title'),
      body: body(),
      open: true,
    };
    save();
    process.stdout.write(`${state.pull.url}\n`);
  } else if (command === 'pr edit') {
    state.editCount++;
    state.pull = {
      ...(state.pull ?? {
        number: Number(args[2]),
        url: `https://github.com/acme/widgets/pull/${args[2]}`,
        open: true,
      }),
      title: option('--title'),
      body: body(),
    };
    save();
  } else if (command === 'pr view') {
    save();
    if (option('--json') === 'comments') {
      process.stdout.write(JSON.stringify({
        comments: state.comments.map((body) => ({ body })),
      }));
    } else {
      process.stdout.write(JSON.stringify({
        number: state.pull?.number ?? 42,
        url: state.pull?.url ?? 'https://github.com/acme/widgets/pull/42',
      }));
    }
  } else if (command === 'pr comment') {
    state.comments.push(body());
    save();
    process.stdout.write('https://github.com/acme/widgets/pull/42#issuecomment-1\n');
  } else {
    save();
    process.stderr.write(`unsupported fake gh command: ${args.join(' ')}\n`);
    process.exitCode = 2;
  }
}
