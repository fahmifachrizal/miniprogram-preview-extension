// The navigation functions in the graph, each with its own colour: my.* APIs first (fixed colours), then
// the project's own navigation functions (goProduct, toTab, router.go…) from a palette, by name.
const BUILTINS = ['navigateTo', 'redirectTo', 'switchTab', 'reLaunch', 'navigateBack'];
const PALETTE = ['#e5c07b', '#56b6c2', '#ff79c6', '#f78c6c', '#c3e88d', '#82aaff', '#bd93f9', '#4ec9b0', '#d7ba7d', '#ff9e64'];

// The function a navigation (or edge) is made with
export const fnOf = (nav) => nav.via || `my.${nav.api}`;

// Line style by what the navigation does (colour says which function made it)
export function dashFor(api, dynamic) {
  if (dynamic) return '4 3';
  if (api === 'redirectTo') return '6 4';
  if (api === 'navigateBack') return '2 4';
  return undefined;
}

// {entries: [{key, color, apis, count, custom}], colors: {key: color}, dynamicCount}
// Counts are navigations in the pages' functions (a this.method() copy isn't counted twice).
export function buildLegend(graph) {
  const byKey = new Map();
  let dynamicCount = 0;
  for (const page of graph.pages) {
    for (const fn of page.functions) {
      for (const nav of fn.navs) {
        if (nav.viaMethod) continue;
        const key = fnOf(nav);
        const entry = byKey.get(key) || { key, apis: new Set(), count: 0, custom: Boolean(nav.via) };
        entry.apis.add(nav.api);
        entry.count++;
        byKey.set(key, entry);
        if (nav.dynamic) dynamicCount++;
      }
    }
  }
  const builtins = BUILTINS.map((api) => byKey.get(`my.${api}`)).filter(Boolean);
  const custom = [...byKey.values()].filter((e) => e.custom).sort((a, b) => a.key.localeCompare(b.key));
  const colors = {};
  for (const e of builtins) colors[e.key] = `var(--edge-${[...e.apis][0]})`;
  custom.forEach((e, i) => { colors[e.key] = PALETTE[i % PALETTE.length]; });
  const entries = [...builtins, ...custom.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))]
    .map((e) => ({ ...e, apis: [...e.apis], color: colors[e.key] }));
  return { entries, colors, dynamicCount };
}
