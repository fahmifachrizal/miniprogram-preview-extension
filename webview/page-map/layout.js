import dagre from '@dagrejs/dagre';

// Node geometry shared by the layout and PageNode, so dagre sizes nodes the way they render
export const NODE_WIDTH = 280;
export const HEADER_HEIGHT = 34;
export const ROW_HEIGHT = 22;
export const nodeHeight = (functionCount) => HEADER_HEIGHT + Math.max(1, functionCount) * ROW_HEIGHT + 8;

// Top-left positions for each node id. Back edges (navigateBack) and self-loops are left out of the
// layout so they don't pull the forward flow into cycles.
export function layout(nodes, edges, direction) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: direction, nodesep: 36, ranksep: 110, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: NODE_WIDTH, height: n.height });
  for (const e of edges) {
    if (e.data.api === 'navigateBack' || e.source === e.target) continue;
    g.setEdge(e.source, e.target);
  }
  dagre.layout(g);
  const positions = {};
  for (const n of nodes) {
    const p = g.node(n.id);
    positions[n.id] = { x: p.x - NODE_WIDTH / 2, y: p.y - n.height / 2 };
  }
  return positions;
}
