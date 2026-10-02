const { minidev } = require('minidev');
async function test() {
  const result = await minidev.dev({ project: '../integration-test' });
  console.log("DEV RESULT KEYS:", Object.keys(result));
  console.log("DEV RESULT:", result);
  process.exit(0);
}
test();
