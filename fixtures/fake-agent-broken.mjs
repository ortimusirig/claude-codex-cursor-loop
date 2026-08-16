if (process.argv[2] === 'status') {
  process.stdout.write('✓ Logged in as test@example.com\n');
} else {
  process.stderr.write('fake agent failed before producing a verifier stream\n');
  process.exitCode = 1;
}
