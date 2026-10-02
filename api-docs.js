const fs = require('fs');
const os = require('os');
const path = require('path');
const { parse } = require('@babel/parser');

// my.* API reference from the typings minicode and minidev ship (@mini-types/my, @alipay/mini-types-my:
// `declare namespace my { /** doc */ export function request(object: {…}): …; … }`). Descriptions are
// the typings' own (mostly Chinese), with a link to the official docs.

// Where the typings are: minidev's download (kept up to date), else the copy inside alipay.minicode
function findTypings(minicodePath) {
  const candidates = [
    path.join(os.homedir(), '.minidev/typings/public/alipay-local/package/node_modules/@mini-types/my/types/lib.my.d.ts'),
    minicodePath && path.join(minicodePath, 'node_modules/@alipay/mini-types-my/types/lib.my.d.ts'),
  ].filter(Boolean);
  return candidates.find((f) => fs.existsSync(f)) || null;
}

let cache = null;
function load(file) {
  const mtimeMs = fs.statSync(file).mtimeMs;
  if (cache && cache.file === file && cache.mtimeMs === mtimeMs) return cache.apis;
  const code = fs.readFileSync(file, 'utf8');
  const ast = parse(code, { sourceType: 'module', plugins: ['typescript'], errorRecovery: true });
  const apis = new Map();
  const visit = (statements) => {
    for (const st of statements) {
      // namespace my { … } (a block), or namespace a.b { … } (a declaration inside a declaration)
      if (st.type === 'TSModuleDeclaration') {
        if (st.body && st.body.type === 'TSModuleBlock') visit(st.body.body);
        else if (st.body && st.body.type === 'TSModuleDeclaration') visit([st.body]);
        continue;
      }
      const decl = st.type === 'ExportNamedDeclaration' ? st.declaration : st;
      if (!decl) continue;
      let name = null;
      if (decl.type === 'TSDeclareFunction' && decl.id) name = decl.id.name;
      else if (decl.type === 'VariableDeclaration' && decl.declarations[0] && decl.declarations[0].id.type === 'Identifier') name = decl.declarations[0].id.name;
      if (!name || name.startsWith('_')) continue;
      const doc = (st.leadingComments || []).filter((c) => c.type === 'CommentBlock' && c.value.startsWith('*')).map((c) => c.value).pop() || '';
      const entry = apis.get(name) || { name, docs: [], signatures: [] };
      if (doc) entry.docs.push(cleanDoc(doc));
      entry.signatures.push(condense(code.slice(decl.start, decl.end)));
      apis.set(name, entry);
    }
  };
  visit(ast.program.body);
  cache = { file, mtimeMs, apis };
  return apis;
}

// "/**\n * text\n * @see url\n */" → "text\n@see url"
const cleanDoc = (raw) => raw.replace(/^\*+/, '').split('\n').map((l) => l.replace(/^\s*\*\s?/, '').trimEnd()).join('\n').trim();
// Nested JSDoc inside a signature becomes one-line comments, so option docs stay readable but short
const condense = (text) => text.replace(/\/\*\*([\s\S]*?)\*\//g, (_, body) => {
  const lines = cleanDoc('*' + body).split('\n').filter((l) => l && !l.startsWith('@example'));
  return lines.length ? `// ${lines.join(' · ')}` : '';
}).replace(/\n\s*\n/g, '\n');

// Edit distance, for "did you mean" on misspelled names
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row[j];
      row[j] = next;
    }
  }
  return row[b.length];
}

const summary = (entry) => ((entry.docs[0] || '').split('\n')[0] || '').trim();

function apiDocs(name, minicodePath) {
  const file = findTypings(minicodePath);
  if (!file) return { error: 'No my.* typings found. Install the alipay.minicode extension, or run minidev once.' };
  const apis = load(file);
  const key = String(name).replace(/^my\./, '');
  const entry = apis.get(key);
  if (!entry) {
    const lower = key.toLowerCase();
    const close = [...apis.keys()]
      .map((k) => ({ k, d: k.toLowerCase().includes(lower) ? 0 : distance(k.toLowerCase(), lower) }))
      .filter((c) => c.d <= Math.max(2, Math.floor(key.length / 4)))
      .sort((a, b) => a.d - b.d).slice(0, 8).map((c) => c.k);
    return { error: `No my.${key} in the typings.`, didYouMean: close.map((k) => `my.${k}`) };
  }
  const MAX = 8000;
  let signature = entry.signatures.join('\n\n');
  if (signature.length > MAX) signature = signature.slice(0, MAX) + '\n… (truncated)';
  return { name: `my.${entry.name}`, description: entry.docs.join('\n\n'), signature, source: file };
}

function apiSearch(query, minicodePath, limit = 30) {
  const file = findTypings(minicodePath);
  if (!file) return { error: 'No my.* typings found. Install the alipay.minicode extension, or run minidev once.' };
  const q = String(query || '').toLowerCase();
  const results = [];
  for (const entry of load(file).values()) {
    const inName = entry.name.toLowerCase().includes(q);
    if (inName || entry.docs.join('\n').toLowerCase().includes(q)) results.push({ name: `my.${entry.name}`, summary: summary(entry), inName });
  }
  results.sort((a, b) => (b.inName - a.inName) || a.name.length - b.name.length);
  return { count: results.length, results: results.slice(0, limit).map(({ name, summary: s }) => ({ name, summary: s })) };
}

module.exports = { apiDocs, apiSearch, findTypings };
