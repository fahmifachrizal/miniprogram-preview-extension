const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { startMcpServer } = require('../mcp-server');
const { analyzeProject } = require('../page-graph');

// The MCP server with a stub context (no VS Code, no simulator), on a copy of the fixture app
const fixture = path.join(__dirname, 'fixtures', 'nav-app');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-mcp-'));
fs.cpSync(fixture, root, { recursive: true });
const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
const pages = [...app.pages, ...app.subPackages.flatMap((s) => s.pages.map((p) => `${s.root}/${p}`))];
const ctx = {
  projectPath: () => root,
  projectInfo: () => ({ root, pages, simulatorRunning: false }),
  pageMap: ({ page }) => {
    const graph = analyzeProject({ root, pages, tabPages: app.tabBar.items.map((i) => i.pagePath) });
    return page ? graph.pages.find((p) => p.path === page) : graph;
  },
  buildErrors: () => ({ ok: true, errors: [] }),
  minicodePath: () => null,
  compileModes: () => ({ modes: [] }),
  simulator: { running: () => false, start: async () => ({}), restartApp: async () => ({}), launch: async () => ({}), call: async () => ({}) },
};
const TOKEN = 'test-token';
let server;
let url;

test.before(async () => {
  server = await startMcpServer({ port: 0, token: TOKEN, ctx });
  url = new URL(`http://127.0.0.1:${server.port}/mcp`);
});
test.after(async () => { await server.close(); fs.rmSync(root, { recursive: true, force: true }); });

async function connect(token = TOKEN) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
const parse = (result) => JSON.parse(result.content[0].text);

test('rejects a missing or wrong token, and other hosts', async () => {
  const post = (headers) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: '{}' });
  assert.strictEqual((await post({})).status, 401);
  assert.strictEqual((await post({ Authorization: 'Bearer nope' })).status, 401);
  // fetch can't set Host; a page on another origin reaching this port through DNS rebinding would send its own
  const foreignHost = await new Promise((resolve, reject) => {
    const req = require('http').request({ host: '127.0.0.1', port: server.port, path: '/mcp', method: 'POST',
      headers: { Host: 'evil.example.com', Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end('{}');
  });
  assert.strictEqual(foreignHost, 403);
});

test('lists the tools and the guide prompt', async () => {
  const client = await connect();
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepStrictEqual(tools, ['api_docs', 'api_search', 'build_errors', 'compile_modes', 'mock_rules', 'page_map', 'project_context', 'project_info',
    'simulator_api_log', 'simulator_current_page', 'simulator_eval', 'simulator_launch', 'simulator_logs', 'simulator_open_page', 'simulator_restart_app',
    'simulator_set_data', 'simulator_start', 'simulator_storage', 'simulator_trigger', 'simulator_view'].sort());
  assert.ok((await client.listPrompts()).prompts.some((p) => p.name === 'miniprogram_guide'));
  await client.close();
});

test('project tools', async () => {
  const client = await connect();
  const info = parse(await client.callTool({ name: 'project_info', arguments: {} }));
  assert.strictEqual(info.pages[0], 'pages/index/index');
  const page = parse(await client.callTool({ name: 'page_map', arguments: { page: 'pages/detail/detail' } }));
  assert.deepStrictEqual(page.functions.map((f) => f.name), ['onLoad', 'goBack', 'replace']);
  const docs = await client.callTool({ name: 'api_docs', arguments: { name: 'nope' } });
  assert.ok(docs.content[0].text.length > 0);
  const sim = await client.callTool({ name: 'simulator_current_page', arguments: {} });
  assert.strictEqual(sim.isError, true);
  assert.match(sim.content[0].text, /simulator_start/);
  await client.close();
});

test('project context: instructions and tool, re-read on every connection', async () => {
  let client = await connect();
  assert.match(client.getInstructions(), /no \.mini-ide\/context\.md yet/);
  await client.close();
  fs.mkdirSync(path.join(root, '.mini-ide'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mini-ide', 'context.md'), '# Rules\nAlways navigate with open({ url }).\n');
  client = await connect();
  assert.match(client.getInstructions(), /Always navigate with open\(\{ url \}\)/);
  const ctxResult = parse(await client.callTool({ name: 'project_context', arguments: {} }));
  assert.deepStrictEqual(ctxResult.files, [path.join('.mini-ide', 'context.md')]);
  const prompt = await client.getPrompt({ name: 'miniprogram_guide' });
  assert.match(prompt.messages[0].content.text, /Always navigate/);
  await client.close();
});

test('mock rules round-trip through the file', async () => {
  const client = await connect();
  const added = parse(await client.callTool({ name: 'mock_rules', arguments: { action: 'add', rule: { api: 'getNativeUser', payload: { id: 1 } } } }));
  assert.strictEqual(added.added.api, 'getNativeUser');
  parse(await client.callTool({ name: 'mock_rules', arguments: { action: 'enable' } }));
  const file = JSON.parse(fs.readFileSync(path.join(root, '.mini-ide', 'mockConfig.json'), 'utf8'));
  assert.strictEqual(file.active, true);
  assert.deepStrictEqual(file.rules[0].response, { success: true, payload: { id: 1 } });
  const removed = parse(await client.callTool({ name: 'mock_rules', arguments: { action: 'remove', uid: added.added.uid } }));
  assert.strictEqual(removed.rules.length, 0);
  await client.close();
});
