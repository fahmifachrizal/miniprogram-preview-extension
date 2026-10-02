const http = require('http');
const crypto = require('crypto');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { apiDocs, apiSearch } = require('./api-docs');
const { readConfig, writeConfig, newUid } = require('./mock-config');
const { instructions, readProjectContext } = require('./project-context');

// MCP server for AI agents (Claude Code, Copilot agent mode…): the project (pages, navigation, build
// errors, my.* docs, mocks, compile modes, the user's .mini-ide/context.md) and the running simulator
// (current page, data, handlers, what it renders, logs, my.* calls, storage, launch with queries).
//
// Streamable HTTP on 127.0.0.1, stateless (a server per request, so instructions are always fresh),
// with a bearer token and a Host check (no DNS rebinding from web pages). No vscode dependency: the
// extension passes `ctx`:
//   projectPath() → string | null        projectInfo() → object          pageMap({page}) → object
//   buildErrors() → object                minicodePath() → string | null
//   compileModes(action, args) → object   (list / add / update / remove / select)
//   simulator: { running(), start(), restartApp(), launch(mode | null), call(method, params) }

const VERSION = '0.1.0';
const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const failure = (message) => ({ isError: true, content: [{ type: 'text', text: message }] });

function createMcp(ctx) {
  const projectPath = () => ctx.projectPath();
  const mcp = new McpServer({ name: 'miniprogram', version: VERSION }, { instructions: instructions(projectPath()) });
  const tool = (name, description, inputSchema, handler, annotations) => mcp.registerTool(name, { description, inputSchema, annotations }, async (args) => {
    try { return text(await handler(args || {})); } catch (e) { return failure(e && e.message ? e.message : String(e)); }
  });
  const needProject = () => {
    const p = projectPath();
    if (!p) throw new Error('No mini program is open in VS Code (a folder with app.json).');
    return p;
  };
  const simulator = async (method, params) => {
    if (!ctx.simulator.running()) throw new Error('The simulator is not running. Call simulator_start first.');
    return ctx.simulator.call(method, params || {});
  };
  const readOnly = { readOnlyHint: true };

  // --- project ---
  tool('project_info', 'The open mini program: root, pages (first is the start page), tab pages, app.json window settings, compile modes and whether the simulator is running.',
    {}, () => ctx.projectInfo(), readOnly);
  tool('page_map', 'Navigation graph from the source: every page with its functions and where each navigates (my.navigateTo/redirectTo/switchTab/reLaunch/navigateBack or the project\'s own navigation functions). Give `page` to get one page only.',
    { page: z.string().optional().describe('Page path, e.g. pages/index/index') }, ({ page }) => ctx.pageMap({ page }), readOnly);
  tool('build_errors', 'The current build error of the running dev server, with file, line and message (empty when the last build succeeded).',
    {}, () => ctx.buildErrors(), readOnly);
  tool('api_docs', 'Exact signature, options and description of a my.* API from the official typings. Use before calling an API you are not sure about.',
    { name: z.string().describe('API name, e.g. request, my.navigateTo, getStorageSync') }, ({ name }) => apiDocs(name, ctx.minicodePath()), readOnly);
  tool('api_search', 'Search my.* APIs by name or description (e.g. "storage", "location", "clipboard").',
    { query: z.string() }, ({ query }) => apiSearch(query, ctx.minicodePath()), readOnly);
  tool('project_context', 'The project\'s own rules and background for agents (.mini-ide/context.md and .mini-ide/context/*.md, written by the user). Follow them.',
    {}, () => {
      const { text: body, files } = readProjectContext(needProject());
      return body ? { files, context: body } : { files: [], context: '', note: 'No .mini-ide/context.md yet.' };
    }, readOnly);

  const matchSchema = z.array(z.object({
    type: z.enum(['full', 'regex', 'path']).describe('full: equals; regex: RegExp test; path: lodash-style path equals'),
    name: z.string().describe('Parameter (or path) of the call, e.g. url'),
    value: z.string(),
  }));
  tool('mock_rules', [
    'Read or change the simulator\'s API mocks (.mini-ide/mockConfig.json, applied live).',
    'A rule returns your data instead of a real result for a my.* API (api: "request") or for my.call(name, …) (api: name).',
    '`match` limits it to calls whose params match (e.g. {type: "regex", name: "url", value: "/api/user\\\\?id=2"}); pair with simulator_launch page/app queries to test a page with specific inputs.',
    'Mocks only apply while mocking is on (action "enable").',
  ].join(' '), {
    action: z.enum(['get', 'add', 'update', 'remove', 'enable', 'disable', 'set']),
    rule: z.object({
      uid: z.string().optional(), name: z.string().optional(), api: z.string().optional(), active: z.boolean().optional(),
      match: matchSchema.optional(), success: z.boolean().optional().describe('true: success callback (default); false: fail callback'),
      payload: z.any().optional().describe('The data the callback receives'),
    }).optional().describe('For add/update (update needs uid)'),
    uid: z.string().optional().describe('For remove'),
    config: z.object({ active: z.boolean(), rules: z.array(z.any()) }).optional().describe('For set: the whole file'),
  }, ({ action, rule, uid, config }) => {
    const root = needProject();
    const current = readConfig(root);
    const toRule = (r, base = {}) => ({
      uid: base.uid || newUid(), name: r.name !== undefined ? r.name : (base.name || ''), api: r.api || base.api,
      active: r.active !== undefined ? r.active : (base.active !== undefined ? base.active : true),
      match: r.match || base.match || [],
      response: {
        success: r.success !== undefined ? r.success : (base.response ? base.response.success !== false : true),
        payload: r.payload !== undefined ? r.payload : (base.response ? base.response.payload : {}),
      },
    });
    if (action === 'get') return current;
    if (action === 'enable' || action === 'disable') { current.active = action === 'enable'; writeConfig(root, current); return current; }
    if (action === 'set') { if (!config) throw new Error('set needs config'); writeConfig(root, config); return readConfig(root); }
    if (action === 'add') {
      if (!rule || !rule.api) throw new Error('add needs rule.api');
      const added = toRule(rule);
      current.rules.push(added);
      writeConfig(root, current);
      return { added, active: current.active, note: current.active ? undefined : 'Mocking is off; call mock_rules with action "enable" to apply rules.' };
    }
    if (action === 'update') {
      const i = current.rules.findIndex((r) => rule && r.uid === rule.uid);
      if (i < 0) throw new Error('update needs rule.uid of an existing rule');
      current.rules[i] = toRule(rule, current.rules[i]);
      writeConfig(root, current);
      return current.rules[i];
    }
    if (action === 'remove') {
      const before = current.rules.length;
      current.rules = current.rules.filter((r) => r.uid !== uid);
      if (current.rules.length === before) throw new Error(`No rule with uid ${uid}`);
      writeConfig(root, current);
      return current;
    }
    throw new Error(`Unknown action ${action}`);
  });

  const modeSchema = z.object({
    title: z.string(),
    page: z.string().optional().describe('Start page, e.g. pages/product/product'),
    pageQuery: z.string().optional().describe('Page query as a query string, e.g. id=2&from=list (onLoad gets {id: "2", from: "list"})'),
    query: z.string().optional().describe('App (global) query, e.g. from=share (App.onLaunch(options).query, my.getLaunchOptionsSync())'),
    scene: z.union([z.string(), z.number()]).optional().describe('Scene value, e.g. 1007'),
  });
  tool('compile_modes', 'Saved launch presets (.mini-ide/compileMode.json, shared with the IDE): start page, page query, app query and scene. "select" restarts the simulator with one (title null for a normal compile).', {
    action: z.enum(['list', 'add', 'update', 'remove', 'select']),
    mode: modeSchema.optional().describe('For add/update'),
    title: z.string().nullable().optional().describe('For remove/select'),
  }, (args) => ctx.compileModes(args.action, args));

  // --- simulator ---
  tool('simulator_start', 'Start the simulator in VS Code (builds the project; takes a few seconds the first time).',
    {}, () => ctx.simulator.start());
  tool('simulator_restart_app', 'Restart the app in the simulator with the current launch settings.',
    {}, () => { if (!ctx.simulator.running()) throw new Error('The simulator is not running. Call simulator_start first.'); return ctx.simulator.restartApp(); });
  tool('simulator_launch', 'Restart the app as if it was opened with this start page, page query (onLoad), app query (onLaunch / my.getLaunchOptionsSync) and scene. Temporary: call with no arguments to go back to the selected compile mode. To keep a case, save it with compile_modes.', {
    page: z.string().optional().describe('Start page, e.g. pages/product/product'),
    pageQuery: z.string().optional().describe('e.g. id=2&from=list'),
    query: z.string().optional().describe('App query, e.g. from=share'),
    scene: z.union([z.string(), z.number()]).optional(),
  }, (args) => {
    if (!ctx.simulator.running()) throw new Error('The simulator is not running. Call simulator_start first.');
    const empty = !args.page && !args.pageQuery && !args.query && args.scene === undefined;
    return ctx.simulator.launch(empty ? null : {
      title: 'MCP launch', page: args.page || '', pageQuery: args.pageQuery || '', query: args.query || '',
      debugAppxSceneCode: args.scene !== undefined ? String(args.scene) : '',
    });
  });
  tool('simulator_open_page', 'Open a page in the running app with my.reLaunch (clears the page stack). The app query stays as launched; use simulator_launch to change it.', {
    path: z.string().describe('e.g. pages/product/product'),
    query: z.string().optional().describe('Page query, e.g. id=2'),
  }, (args) => simulator('openPage', args));
  tool('simulator_current_page', 'The page on screen: route, the query it was opened with, its data, the page stack, and the app\'s launch options (query, scene).',
    { dataDepth: z.number().optional().describe('How deep to include data objects (default 6)') }, (args) => simulator('currentPage', args), readOnly);
  tool('simulator_set_data', 'Call setData on the page on screen (e.g. to try a state), then return its data.',
    { data: z.record(z.string(), z.any()) }, (args) => simulator('setData', args));
  tool('simulator_trigger', 'Call a handler or method of the page on screen, like a tap would: the event gets `detail`, and `dataset` as currentTarget.dataset/target.dataset (what data-* attributes give). Returns its return value and the page afterwards.', {
    handler: z.string().describe('e.g. onProductTap'),
    detail: z.any().optional(),
    dataset: z.record(z.string(), z.any()).optional().describe('e.g. {id: 2} for data-id="{{2}}"'),
  }, (args) => simulator('trigger', args));
  tool('simulator_view', 'What the page on screen renders, as an indented tree of AXML components (view, button, text…) with classes and text.',
    { maxLines: z.number().optional().describe('Default 300') }, (args) => simulator('view', args), readOnly);
  tool('simulator_logs', 'Console output of the app (worker and pages) since a sequence number (use the returned `last` for the next call).',
    { since: z.number().optional(), level: z.enum(['log', 'info', 'warn', 'error', 'debug']).optional() }, (args) => simulator('logs', args), readOnly);
  tool('simulator_api_log', 'Recent my.* calls made by the app, with parameters and results (success/fail data, return values of *Sync APIs), including my.request and my.call.',
    { since: z.number().optional(), api: z.string().optional().describe('Only this API, e.g. request') }, (args) => simulator('apiLog', args), readOnly);
  tool('simulator_storage', 'The app\'s local storage (my.getStorageSync & co.) in the simulator.', {
    action: z.enum(['info', 'get', 'set', 'remove', 'clear']),
    key: z.string().optional(),
    value: z.any().optional(),
  }, (args) => simulator('storage', args));
  tool('simulator_eval', 'Run JavaScript in the app\'s worker (where App/Page code runs; my, getApp, getCurrentPages are available) and return the result as JSON. An expression, or statements with `return`. Promises are awaited.',
    { code: z.string() }, (args) => simulator('eval', args));

  mcp.registerPrompt('miniprogram_guide', { description: 'How to work on this mini program: the built-in guide plus the project\'s .mini-ide/context.md' },
    () => ({ messages: [{ role: 'user', content: { type: 'text', text: instructions(projectPath()) } }] }));
  return mcp;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (!chunks.length) return resolve(undefined);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// → Promise<{port, close()}>; rejects with the listen error (e.g. EADDRINUSE)
function startMcpServer({ port, token, ctx }) {
  const server = http.createServer(async (req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      if (new URL(req.url, 'http://x').pathname !== '/mcp') return json(404, { error: 'Not found; the endpoint is /mcp' });
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')) return json(403, { error: 'Forbidden host' });
      if (!safeEqual(req.headers.authorization || '', `Bearer ${token}`)) return json(401, { error: 'Unauthorized' });
      if (req.method !== 'POST') return json(405, { error: 'Method not allowed (stateless server: POST only)' });
      const body = await readBody(req);
      const mcp = createMcp(ctx);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { transport.close(); mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) json(500, { error: e.message || String(e) });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve({ port: server.address().port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

module.exports = { startMcpServer, createMcp };
