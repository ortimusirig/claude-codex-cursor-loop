const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'status') {
  if (process.env.URO_FAKE_GH_AUTH !== 'yes') process.exitCode = 1;
} else {
  process.exitCode = 2;
}
