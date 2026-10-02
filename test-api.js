const { minidev } = require('minidev');
async function run() {
  const devServer = await minidev.dev({ project: '../integration-test' });
  console.log("Keys:", Object.keys(devServer));
  if (devServer.url) console.log("URL:", devServer.url);
  if (devServer.server) devServer.server.close();
  process.exit(0);
}
run().catch(console.error);
