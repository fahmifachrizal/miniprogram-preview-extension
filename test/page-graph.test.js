const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { analyzeProject } = require('../page-graph');

// The fixture app covers: literal, constant, relative and query URLs; a dynamic URL; redirectTo,
// switchTab, reLaunch and navigateBack; wrappers (template URL, wrapper of a wrapper, {url} option,
// one listed in settings only); a TS page; a subpackage page; axml handlers; this.method() calls;
// navigation inside a callback; navigation functions found by their { url } parameter (including one
// that never reaches my.*), an HTTP helper of the same shape (ignored), an npm router called with
// { url } (counted only for page URLs), and a namespace import (nav.toTab).
const root = path.join(__dirname, 'fixtures', 'nav-app');
const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
const pages = [...app.pages, ...app.subPackages.flatMap((s) => s.pages.map((p) => `${s.root}/${p}`))];
const graph = analyzeProject({ root, pages, tabPages: app.tabBar.items.map((i) => i.pagePath), wrapperNames: ['myRouter.push'] });
const page = (p) => graph.pages.find((x) => x.path === p);
const fn = (p, name) => page(p).functions.find((f) => f.name === name);

test('edges', () => {
  const edges = graph.edges.map((e) => `${e.from} ${e.fn} -> ${e.to} ${e.api}${e.via ? ` via ${e.via}` : ''}${e.viaMethod ? ` through ${e.viaMethod}` : ''}${e.inferred ? ' inferred' : ''}${e.dynamic ? ' dynamic' : ''}`);
  assert.deepStrictEqual(edges.sort(), [
    'pages/detail/detail goBack -> pages/index/index navigateBack inferred',
    'pages/detail/detail goBack -> pages/ts-page/ts-page navigateBack inferred',
    'pages/detail/detail replace -> pages/list/list redirectTo',
    'pages/index/index custom -> pages/profile/index navigateTo via myRouter.push',
    'pages/index/index goOptions -> pages/list/list navigateTo via openPage',
    'pages/index/index goRoute -> pages/cart/cart navigateTo via routeTo',
    'pages/index/index goRouteDynamic -> ? navigateTo via routeTo dynamic',
    'pages/index/index helper -> pages/list/list navigateTo through openList',
    'pages/index/index later -> pages/cart/cart navigateTo',
    'pages/index/index npmRouter -> pages/detail/detail navigateTo via router.go',
    'pages/index/index onTapDetail -> pages/detail/detail navigateTo via go',
    'pages/index/index openDynamic -> ? navigateTo dynamic',
    'pages/index/index openList -> pages/list/list navigateTo',
    'pages/index/index openRelative -> pages/detail/detail navigateTo',
    'pages/index/index order -> sub/order/order navigateTo via goOrder',
    'pages/index/index profileShort -> pages/profile/index navigateTo',
    'pages/index/index reset -> pages/index/index reLaunch',
    'pages/index/index toCart -> pages/cart/cart switchTab via toTab',
    'pages/index/index withOptions -> pages/list/list redirectTo via openWith',
    'pages/list/list back -> pages/index/index navigateBack inferred',
    'pages/list/list back -> sub/order/order navigateBack inferred',
    'pages/ts-page/ts-page go -> pages/detail/detail navigateTo',
    'sub/order/order toCart -> pages/cart/cart switchTab via toTab',
    'sub/order/order toList -> pages/list/list navigateTo',
  ]);
});

test('pages', () => {
  assert.deepStrictEqual(graph.pages.map((p) => [p.path, p.file, p.isTab, p.isEntry]), [
    ['pages/index/index', 'pages/index/index.js', true, true],
    ['pages/detail/detail', 'pages/detail/detail.js', false, false],
    ['pages/list/list', 'pages/list/list.js', false, false],
    ['pages/cart/cart', 'pages/cart/cart.js', true, false],
    ['pages/profile/index', 'pages/profile/index.js', false, false],
    ['pages/ts-page/ts-page', 'pages/ts-page/ts-page.ts', false, false],
    ['sub/order/order', 'sub/order/order.js', false, false],
  ]);
});

test('functions: all listed, with kinds and lines', () => {
  assert.deepStrictEqual(page('pages/index/index').functions.map((f) => [f.name, f.kind, f.line]).slice(0, 4), [
    ['onLoad', 'lifecycle', 5],
    ['onTapDetail', 'handler', 6],
    ['openList', 'handler', 7],
    ['openRelative', 'method', 8],
  ]);
  assert.strictEqual(page('pages/index/index').functions.length, 19);
  // loadData calls an HTTP helper with a { url } object, track an unknown function with a web URL
  assert.deepStrictEqual(['loadData', 'track'].map((name) => fn('pages/index/index', name).navs), [[], []]);
  assert.deepStrictEqual(page('pages/cart/cart').functions.map((f) => [f.name, f.navs.length]), [['onLoad', 0]]);
});

test('navigations carry the source text and line', () => {
  assert.deepStrictEqual(fn('pages/index/index', 'onTapDetail').navs, [
    { api: 'navigateTo', via: 'go', target: 'pages/detail/detail', dynamic: false, raw: "go('detail', e.id)", line: 6 },
  ]);
  assert.deepStrictEqual(fn('pages/index/index', 'helper').navs, [
    { api: 'navigateTo', via: null, viaMethod: 'openList', target: 'pages/list/list', dynamic: false, raw: 'this.openList()', line: 13 },
  ]);
  assert.deepStrictEqual(fn('pages/index/index', 'openDynamic').navs, [
    { api: 'navigateTo', via: null, target: null, dynamic: true, raw: 'e.target.dataset.url', line: 9 },
  ]);
  assert.deepStrictEqual(fn('pages/detail/detail', 'goBack').navs, [
    { api: 'navigateBack', via: null, target: null, dynamic: false, raw: '', line: 3 },
  ]);
});
