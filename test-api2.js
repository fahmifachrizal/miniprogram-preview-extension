const { minidev } = require('minidev');
async function run() {
  const result = await minidev.dev({ project: '../integration-test' });
  console.log("devServer keys:", Object.keys(result.devServer || {}));
  console.log("port:", result.devServer?.port);
  console.log("url?:", result.devServer?.url);
  process.exit(0);
}
run().catch(console.error);
