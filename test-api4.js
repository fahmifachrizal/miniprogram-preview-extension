const { minidev } = require('minidev');
async function run() {
  const build = await minidev.dev({ project: '../integration-test' });
  const simulator = await minidev.devWebSimulator({ autoOpen: false }, build);
  console.log("SIMULATOR URL:", simulator.bundled);
  process.exit(0);
}
run().catch(console.error);
