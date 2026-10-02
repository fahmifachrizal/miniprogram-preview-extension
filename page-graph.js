const fs = require('fs');
const path = require('path');
const { parse } = require('@babel/parser');

// Page map: the mini program's pages and the navigation between them, from the source alone.
//   analyzeProject({root, pages, tabPages, wrapperNames}) →
//     {pages: [{path, file, isTab, isEntry, functions: [{name, kind, line, navs: [nav]}]}], edges: [edge]}
//   nav:  {api, via, target, dynamic, raw, line}   target null for navigateBack and unresolved URLs
//   edge: {from, fn, to, api, via, dynamic?, inferred?}   to '?' for unresolved URLs
// Navigation is a my.navigateTo / redirectTo / switchTab / reLaunch / navigateBack call, or a call to a
// wrapper: any function outside the Page() object that makes one (directly or through another wrapper).
// A wrapper's URL is evaluated with the call's arguments, so helpers like go('detail', id) resolve.

const NAV_APIS = new Set(['navigateTo', 'redirectTo', 'switchTab', 'reLaunch', 'navigateBack']);
const LIFECYCLE = new Set(['onLoad', 'onShow', 'onReady', 'onHide', 'onUnload', 'onPullDownRefresh', 'onReachBottom',
  'onShareAppMessage', 'onPageScroll', 'onTabItemTap', 'onTitleClick', 'onOptionMenuClick', 'onPopMenuClick', 'onResize']);
const THIS_ALIASES = new Set(['that', 'self', '_this', 'me', 'vm']);
const SKIP_DIRS = new Set(['node_modules', 'miniprogram_npm', 'dist', '.mini-ide', '.git']);
// Option callbacks and array/promise methods: never treated as wrappers, whatever their body does
const NOT_WRAPPERS = new Set(['success', 'fail', 'complete', 'then', 'catch', 'finally', 'map', 'forEach', 'filter', 'reduce', 'call', 'apply', 'bind']);
const MAX_FILE_SIZE = 512 * 1024;
const MAX_DEPTH = 4;

// --- parsing (cached by path + mtime, so live updates only reparse changed files) ---

const astCache = new Map();
function parseFile(file) {
  let stat;
  try { stat = fs.statSync(file); } catch (e) { return null; }
  if (stat.size > MAX_FILE_SIZE) return null;
  const cached = astCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.result;
  let result = null;
  try {
    const code = fs.readFileSync(file, 'utf8');
    const ast = parse(code, {
      sourceType: 'unambiguous',
      errorRecovery: true,
      plugins: file.endsWith('.ts') ? ['typescript', 'decorators-legacy'] : ['decorators-legacy'],
    });
    result = { ast, code };
  } catch (e) { /* unparsable: skipped */ }
  astCache.set(file, { mtimeMs: stat.mtimeMs, result });
  return result;
}

function listScripts(root) {
  const out = [];
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name)); }
      else if (/\.(js|ts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(path.join(dir, entry.name));
    }
  })(root);
  return out;
}

// --- AST helpers ---

const isNode = (v) => v && typeof v.type === 'string';
function walk(node, visit) {
  if (!isNode(node)) return;
  if (visit(node) === false) return;
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'extra') continue;
    const value = node[key];
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else if (isNode(value)) walk(value, visit);
  }
}
const unwrapTs = (node) => (node && (node.type === 'TSAsExpression' || node.type === 'TSNonNullExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'ParenthesizedExpression') ? unwrapTs(node.expression) : node);
const isFunction = (node) => node && ['FunctionExpression', 'ArrowFunctionExpression', 'FunctionDeclaration', 'ObjectMethod', 'ClassMethod'].includes(node.type);
function propName(key) {
  if (!key) return null;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'StringLiteral') return key.value;
  return null;
}
// my.navigateTo → ['my', 'navigateTo']; this.go → ['this', 'go']; a.b.c → ['a', 'b', 'c']
function calleePath(callee) {
  callee = unwrapTs(callee);
  if (!callee) return null;
  if (callee.type === 'Identifier') return [callee.name];
  if (callee.type === 'ThisExpression') return ['this'];
  if ((callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') && !callee.computed) {
    const object = calleePath(callee.object);
    const name = propName(callee.property);
    return object && name ? [...object, name] : name ? ['?', name] : null;
  }
  if (callee.type === 'CallExpression') return ['()']; // getApp().go → ['()', 'go'] via the member branch
  return null;
}
const findProperty = (objectNode, name) => objectNode.properties.find((p) => (p.type === 'ObjectProperty' || p.type === 'ObjectMethod') && propName(p.key) === name);

// --- evaluating URL expressions ---
// Values: {str, complete} (complete: no unknown part followed), {obj: ObjectExpression, env}, or null (unknown)

function evaluate(node, env, depth = 0) {
  node = unwrapTs(node);
  if (!node || depth > 8) return null;
  switch (node.type) {
    case 'StringLiteral': return { str: node.value, complete: true };
    case 'NumericLiteral': return { str: String(node.value), complete: true };
    case 'TemplateLiteral': {
      let str = '';
      for (let i = 0; i < node.quasis.length; i++) {
        str += node.quasis[i].value.cooked;
        if (i < node.expressions.length) {
          const part = evaluate(node.expressions[i], env, depth + 1);
          if (!part || part.str === undefined) return { str, complete: false };
          str += part.str;
          if (!part.complete) return { str, complete: false };
        }
      }
      return { str, complete: true };
    }
    case 'BinaryExpression': {
      if (node.operator !== '+') return null;
      const left = evaluate(node.left, env, depth + 1);
      if (!left || left.str === undefined) return null;
      if (!left.complete) return left;
      const right = evaluate(node.right, env, depth + 1);
      if (!right || right.str === undefined) return { str: left.str, complete: false };
      return { str: left.str + right.str, complete: right.complete };
    }
    case 'Identifier': {
      const bound = env.get(node.name);
      if (bound === undefined) return null;
      return typeof bound === 'function' ? bound() : bound;
    }
    case 'ObjectExpression': return { obj: node, env };
    case 'MemberExpression':
    case 'OptionalMemberExpression': {
      if (node.computed) return null;
      const object = evaluate(node.object, env, depth + 1);
      if (!object || !object.obj) return null;
      const prop = findProperty(object.obj, propName(node.property));
      return prop && prop.value ? evaluate(prop.value, object.env, depth + 1) : null;
    }
    default: return null;
  }
}

// Module- and function-level `const x = '…'` (and {…}) bindings, so url: HOME or url: routes.detail work
function constBindings(scopeNode, parentEnv) {
  const env = new Map(parentEnv || []);
  const body = scopeNode.type === 'Program' ? scopeNode.body : scopeNode.body && scopeNode.body.body;
  if (!Array.isArray(body)) return env;
  for (const statement of body) {
    const decl = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (!decl || decl.type !== 'VariableDeclaration') continue;
    for (const d of decl.declarations) {
      if (d.id.type === 'Identifier' && d.init && !isFunction(unwrapTs(d.init))) {
        const init = d.init;
        env.set(d.id.name, () => evaluate(init, env));
      }
    }
  }
  return env;
}

// A function's parameters bound to a call's argument values
function bindParams(fn, args, callerEnv) {
  const env = new Map(fn.env);
  fn.node.params.forEach((param, i) => {
    param = param.type === 'AssignmentPattern' ? param.left : param;
    const arg = args[i];
    if (param.type === 'Identifier') {
      env.set(param.name, arg ? () => evaluate(arg, callerEnv) : null);
    } else if (param.type === 'ObjectPattern') {
      for (const p of param.properties) {
        if (p.type !== 'ObjectProperty') continue;
        const key = propName(p.key);
        const local = p.value.type === 'AssignmentPattern' ? p.value.left : p.value;
        if (key && local.type === 'Identifier') {
          env.set(local.name, () => {
            const value = arg && evaluate(arg, callerEnv);
            const prop = value && value.obj && findProperty(value.obj, key);
            return prop && prop.value ? evaluate(prop.value, value.env) : null;
          });
        }
      }
    }
  });
  return env;
}

// --- wrappers: functions outside Page() that navigate ---

// A navigation function by its signature, like my.navigateTo's: one parameter, an object with a `url`
// ({ url, … } destructured, or a parameter whose .url is read). Not when the body passes it to an HTTP
// API (a request helper with the same shape).
const HTTP_CALLS = new Set(['my.request', 'my.httpRequest', 'my.uploadFile', 'my.downloadFile', 'my.connectSocket', 'fetch']);
function hasUrlObjectParam(fnNode) {
  if (fnNode.params.length !== 1) return false;
  const param = fnNode.params[0].type === 'AssignmentPattern' ? fnNode.params[0].left : fnNode.params[0];
  let takesUrl = false;
  if (param.type === 'ObjectPattern') {
    takesUrl = param.properties.some((p) => p.type === 'ObjectProperty' && propName(p.key) === 'url');
  } else if (param.type === 'Identifier') {
    walk(fnNode.body, (n) => {
      if ((n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression') && !n.computed
        && n.object.type === 'Identifier' && n.object.name === param.name && propName(n.property) === 'url') takesUrl = true;
      return !takesUrl;
    });
  }
  if (!takesUrl) return false;
  let http = false;
  walk(fnNode.body, (n) => {
    if (n.type === 'CallExpression' && HTTP_CALLS.has((calleePath(n.callee) || []).join('.'))) http = true;
    return !http;
  });
  return !http;
}

// Identifiers bound to a whole local module (import * as nav / import nav / const nav = require('./…')),
// so nav.go(…) means the module's top-level go
function localNamespaces(program) {
  const names = new Set();
  const isLocal = (source) => typeof source === 'string' && /^[./]/.test(source);
  for (const st of program.body) {
    if (st.type === 'ImportDeclaration' && isLocal(st.source.value)) {
      for (const sp of st.specifiers) if (sp.type !== 'ImportSpecifier') names.add(sp.local.name);
    } else if (st.type === 'VariableDeclaration') {
      for (const d of st.declarations) {
        const init = unwrapTs(d.init);
        if (d.id.type === 'Identifier' && init && init.type === 'CallExpression' && init.callee.type === 'Identifier'
          && init.callee.name === 'require' && init.arguments[0] && isLocal(init.arguments[0].value)) names.add(d.id.name);
      }
    }
  }
  return names;
}

// Functions by how they're called: 'top:go' for function go / const go = …, 'member:go' for an
// object or class method (nav.go = …, { go() {} }). The first definition of a key wins.
function collectFunctions(ast, file, into) {
  const moduleEnv = constBindings(ast.program);
  const namespaces = localNamespaces(ast.program);
  const add = (kind, name, node) => {
    if (!name || !isFunction(node) || NOT_WRAPPERS.has(name)) return;
    const key = `${kind}:${name}`;
    if (!into.has(key)) into.set(key, { name, node, file, env: moduleEnv, namespaces, navSignature: hasUrlObjectParam(node) });
  };
  walk(ast.program, (node) => {
    // Page({...}) methods are the page's own functions, not wrappers
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'Page') return false;
    if (node.type === 'FunctionDeclaration' && node.id) add('top', node.id.name, node);
    else if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') add('top', node.id.name, unwrapTs(node.init));
    else if (node.type === 'ObjectMethod' || node.type === 'ClassMethod') add('member', propName(node.key), node);
    else if (node.type === 'ObjectProperty') add('member', propName(node.key), unwrapTs(node.value));
    else if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression') add('member', propName(node.left.property), unwrapTs(node.right));
    return true;
  });
}

// Every navigation a function body makes. `resolveCall` handles calls that aren't my.* APIs.
function navigationsIn(bodyNode, env, resolveCall) {
  const navs = [];
  walk(bodyNode, (node) => {
    if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return true;
    const callee = calleePath(node.callee);
    if (!callee) return true;
    if (callee.length === 2 && callee[0] === 'my' && NAV_APIS.has(callee[1])) {
      const options = node.arguments[0];
      const urlNode = options && unwrapTs(options).type === 'ObjectExpression' ? (findProperty(unwrapTs(options), 'url') || {}).value : null;
      navs.push({ api: callee[1], urlNode, env, line: node.loc.start.line, node });
    } else {
      // The outermost call wins: at the page level, line and call are the page's own
      for (const nav of resolveCall(node, callee, env) || []) navs.push({ ...nav, line: node.loc.start.line, callNode: node });
    }
    return true;
  });
  return navs;
}

// --- the analysis ---

function analyzeProject({ root, pages, tabPages = [], wrapperNames = [] }) {
  const pageSet = new Set(pages);
  const tabSet = new Set(tabPages.map((p) => p.replace(/^\//, '')));

  // Candidate wrappers from every script (first definition of a name wins)
  const functions = new Map();
  for (const file of listScripts(root)) {
    const parsed = parseFile(file);
    if (parsed) collectFunctions(parsed.ast, file, functions);
  }
  const extraNames = new Set(wrapperNames);

  // Navigations a wrapper makes for one call, with its URL expressions evaluated in the call's context
  function wrapperNavs(fn, callNode, callerEnv, depth) {
    if (depth > MAX_DEPTH) return [];
    const env = bindParams(fn, callNode.arguments, callerEnv);
    return navigationsIn(fn.node.body, env, (inner, callee, innerEnv) => resolveWrapperCall(inner, callee, innerEnv, depth + 1, fn.namespaces))
      .map((n) => (n.value !== undefined ? n : { api: n.api, value: n.urlNode ? evaluate(n.urlNode, n.env) : null }));
  }
  // namespaces: the calling file's local module namespaces (see localNamespaces)
  function resolveWrapperCall(callNode, callee, env, depth, namespaces) {
    const name = callee[callee.length - 1];
    if (callee[0] === 'my') return [];
    const fn = callee.length === 1 ? functions.get(`top:${name}`) || functions.get(`member:${name}`)
      : callee.length === 2 && namespaces && namespaces.has(callee[0]) ? functions.get(`top:${name}`)
        : functions.get(`member:${name}`);
    const dotted = callee.filter((p) => p !== '?' && p !== '()').join('.');
    // The URL given to the call: its first argument, or that argument's .url
    const argUrl = () => {
      const arg = callNode.arguments[0];
      const value = arg ? evaluate(arg, env) : null;
      return value && value.obj ? evaluate((findProperty(value.obj, 'url') || {}).value, value.env) : value;
    };
    if (fn && fn.node.body) {
      // The outermost function names the path ("via goDetail"), however deep the chain goes
      const navs = wrapperNavs(fn, callNode, env, depth);
      if (navs.length) return navs.map((n) => ({ ...n, via: name }));
      // A navigation function by signature whose body doesn't reach my.* (a router, getApp()…)
      if (fn.navSignature) return [{ api: 'navigateTo', value: argUrl(), via: name, bySignature: true }];
      return [];
    }
    if (extraNames.has(name) || extraNames.has(dotted)) {
      // Listed in settings but not found in the project: navigateTo, URL in the first argument (or its .url)
      return [{ api: 'navigateTo', value: argUrl(), via: extraNames.has(dotted) ? dotted : name }];
    }
    // A function from outside the project (an npm router…) called with a single { url } object:
    // navigation only when that URL is one of the pages
    const arg = unwrapTs(callNode.arguments[0]);
    if (callNode.arguments.length === 1 && arg && arg.type === 'ObjectExpression' && findProperty(arg, 'url')) {
      return [{ api: 'navigateTo', value: argUrl(), via: dotted || name, onlyIfPage: true }];
    }
    return [];
  }

  const graphPages = [];
  const edges = [];
  for (const pagePath of pages) {
    const base = path.join(root, pagePath);
    const file = ['.js', '.ts'].map((ext) => base + ext).find((f) => fs.existsSync(f));
    const node = { path: pagePath, file: file ? path.relative(root, file) : null, isTab: tabSet.has(pagePath), isEntry: pagePath === pages[0], functions: [] };
    graphPages.push(node);
    const parsed = file && parseFile(file);
    if (!parsed) continue;
    const { ast, code } = parsed;
    const moduleEnv = constBindings(ast.program);
    const namespaces = localNamespaces(ast.program);
    const handlers = axmlHandlers(base + '.axml');

    // Page({...}) or Page(options) with `const options = {...}`
    let pageObject = null;
    walk(ast.program, (n) => {
      if (pageObject) return false;
      if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'Page' && n.arguments[0]) {
        let arg = unwrapTs(n.arguments[0]);
        if (arg.type === 'Identifier') arg = findDeclaration(ast.program, arg.name);
        if (arg && arg.type === 'ObjectExpression') pageObject = arg;
      }
      return true;
    });
    if (!pageObject) continue;

    const methods = [];
    for (const prop of pageObject.properties) {
      const name = propName(prop.key);
      const fnNode = prop.type === 'ObjectMethod' ? prop : prop.type === 'ObjectProperty' ? unwrapTs(prop.value) : null;
      if (!name || !isFunction(fnNode)) continue;
      methods.push({ name, fnNode, line: prop.loc.start.line });
    }
    const methodNames = new Set(methods.map((m) => m.name));
    const pageDir = path.posix.dirname(pagePath);

    // raw: the page's own source for it (the URL, or the whole call of a navigation function).
    // null when a call guessed from its { url } argument doesn't open a page after all.
    const toNav = (n) => {
      const value = n.value !== undefined ? n.value : (n.urlNode ? evaluate(n.urlNode, n.env) : null);
      const rawNode = n.via ? n.callNode : n.urlNode;
      const raw = rawNode ? code.slice(rawNode.start, rawNode.end) : '';
      const via = n.via || null;
      if (n.api === 'navigateBack') return { api: n.api, via, target: null, dynamic: false, raw, line: n.line };
      const target = value && value.str !== undefined ? matchPage(value, pageDir, pageSet) : null;
      if (!target && n.onlyIfPage) return null;
      if (!target && n.bySignature && value && /^[a-z][\w+.-]*:/i.test(value.str || '')) return null; // https:, custom-scheme:…
      return { api: n.api, via, target, dynamic: !target, raw, line: n.line };
    };

    const local = new Map();
    for (const m of methods) {
      const calls = [];
      const env = constBindings(m.fnNode, moduleEnv);
      const navs = navigationsIn(m.fnNode.body, env, (callNode, callee, callEnv) => {
        if ((callee[0] === 'this' || THIS_ALIASES.has(callee[0])) && callee.length === 2 && methodNames.has(callee[1])) {
          calls.push({ name: callee[1], line: callNode.loc.start.line, raw: code.slice(callNode.start, callNode.end) });
          return [];
        }
        return resolveWrapperCall(callNode, callee, callEnv, 0, namespaces);
      }).map((n) => toNav(n)).filter(Boolean);
      local.set(m.name, { ...m, navs, calls });
    }
    // One level of this.method(): the caller gets the callee's own navigations (same navigation
    // function), marked with the method they go through
    for (const m of local.values()) {
      for (const call of m.calls) {
        const callee = local.get(call.name);
        for (const nav of callee.navs) if (!nav.viaMethod) m.navs.push({ ...nav, viaMethod: call.name, line: call.line, raw: call.raw });
      }
      node.functions.push({
        name: m.name,
        kind: LIFECYCLE.has(m.name) ? 'lifecycle' : handlers.has(m.name) ? 'handler' : 'method',
        line: m.line,
        navs: m.navs,
      });
    }
    for (const fn of node.functions) {
      for (const nav of fn.navs) {
        if (nav.api === 'navigateBack') continue;
        const edge = { from: pagePath, fn: fn.name, to: nav.target || '?', api: nav.api, via: nav.via };
        if (nav.viaMethod) edge.viaMethod = nav.viaMethod;
        if (!nav.target) edge.dynamic = true;
        edges.push(edge);
      }
    }
  }

  // navigateBack returns to whichever page opened this one: dotted edges to each page that navigates here
  for (const page of graphPages) {
    const callers = [...new Set(edges.filter((e) => e.to === page.path && e.api === 'navigateTo').map((e) => e.from))];
    for (const fn of page.functions) {
      const back = fn.navs.find((n) => n.api === 'navigateBack');
      if (!back) continue;
      for (const from of callers) edges.push({ from: page.path, fn: fn.name, to: from, api: 'navigateBack', via: back.via, inferred: true });
    }
  }
  return { pages: graphPages, edges };
}

function findDeclaration(program, name) {
  let found = null;
  walk(program, (n) => {
    if (found) return false;
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.id.name === name) found = unwrapTs(n.init);
    return true;
  });
  return found;
}

// Handler names referenced from the page's template: onTap="goDetail", catchTap="{{ onBuy }}"
function axmlHandlers(file) {
  const names = new Set();
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return names; }
  for (const m of text.matchAll(/\b(?:on|catch)[A-Z][\w]*\s*=\s*["']\s*(?:\{\{\s*)?([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  return names;
}

// A URL (possibly with an unknown tail) → a page path, relative URLs against the calling page's folder
function matchPage(value, pageDir, pageSet) {
  const hasQuery = value.str.includes('?');
  let url = value.str.split('?')[0].split('#')[0].trim();
  if (!url) return null;
  url = url.startsWith('/') ? url.slice(1) : path.posix.normalize(path.posix.join(pageDir, url));
  url = url.replace(/\/$/, '');
  const candidates = [url, url + '/index'];
  // Without a query, an incomplete URL may continue the path ('/pages/' + name): only an exact match counts
  if (!value.complete && !hasQuery) return candidates.find((c) => pageSet.has(c) && c === url) || null;
  return candidates.find((c) => pageSet.has(c)) || null;
}

module.exports = { analyzeProject, NAV_APIS };
