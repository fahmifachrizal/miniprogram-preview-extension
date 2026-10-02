import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, MarkerType, Panel, useReactFlow, useNodesState, useNodesInitialized } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './theme.css';
import { nodeTypes } from './PageNode';
import { layout, nodeHeight } from './layout';
import { buildLegend, dashFor, fnOf } from './legend';
import { post, getState, setState } from './vscode';

// Edges are coloured by the navigation function that makes them (see legend.js); hidden holds
// legend keys (function names) and 'dynamic' (URLs only known at run time)
const isHidden = (e, hidden) => hidden.includes(fnOf(e)) || (e.dynamic && hidden.includes('dynamic'));

function edgeStyle(e, colors) {
  const color = colors[fnOf(e)] || 'var(--edge-navigateTo)';
  const style = { stroke: color, strokeWidth: e.api === 'reLaunch' ? 3 : 1.5 };
  const dash = dashFor(e.api, e.dynamic);
  if (dash) style.strokeDasharray = dash;
  return { style, markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 } };
}

// One row per navigation function, with its line, what it calls (for custom ones) and how often
function Legend({ legend, hidden, onToggle }) {
  const Line = ({ color, api, dynamic }) => (
    <svg className="legend-line" width="28" height="8" aria-hidden="true">
      <line x1="0" y1="4" x2="28" y2="4" stroke={color} strokeWidth={api === 'reLaunch' ? 3 : 2} strokeDasharray={dashFor(api, dynamic)} />
    </svg>
  );
  return (
    <div className="legend">
      <div className="legend-title">Navigation functions</div>
      {legend.entries.map((en) => (
        <label key={en.key} className="legend-row" title={en.custom ? `${en.key}: calls ${en.apis.map((a) => `my.${a}`).join(', ')}` : en.key}>
          <input type="checkbox" checked={!hidden.includes(en.key)} onChange={() => onToggle(en.key)} />
          <Line color={en.color} api={en.apis[0]} />
          <span className="legend-name">{en.key}</span>
          {en.custom && <span className="legend-api">{en.apis.join(', ')}</span>}
          <span className="count">{en.count}</span>
        </label>
      ))}
      {legend.dynamicCount > 0 && (
        <label className="legend-row" title="URLs only known at run time, drawn to the ? node">
          <input type="checkbox" checked={!hidden.includes('dynamic')} onChange={() => onToggle('dynamic')} />
          <Line color="var(--edge-dynamic)" dynamic />
          <span className="legend-name">dynamic URL (?)</span>
          <span className="count">{legend.dynamicCount}</span>
        </label>
      )}
    </div>
  );
}

// Nodes snap to the background's grid, and edges are drawn as right-angled lines on it
const GRID = 20;
const snap = (p) => ({ x: Math.round(p.x / GRID) * GRID, y: Math.round(p.y / GRID) * GRID });
// Dragged positions are kept per layout direction: {LR: {pagePath: {x, y}}, TB: {…}} (older saves were flat, LR)
const byDirection = (positions) => (positions && (positions.LR || positions.TB) ? positions : { LR: positions || {} });

function App() {
  const [graph, setGraph] = useState(null);
  const saved = useRef({});                       // dragged positions, see byDirection
  const [ui, setUi] = useState(() => ({ direction: 'LR', hidden: [], search: '', ...getState().ui }));
  const [relayouts, setRelayouts] = useState(0);  // bumped by Re-layout
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const { fitView } = useReactFlow();

  useEffect(() => { setState({ ui }); }, [ui]);
  useEffect(() => {
    const onMessage = (e) => {
      if (e.data && e.data.type === 'graph') { saved.current = byDirection(e.data.positions); setGraph(e.data.graph); }
    };
    window.addEventListener('message', onMessage);
    post({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const search = ui.search.trim().toLowerCase();
  const matches = useCallback((page) => !search || page.path.toLowerCase().includes(search)
    || page.functions.some((f) => f.name.toLowerCase().includes(search)), [search]);
  const matchesRef = useRef(matches);
  matchesRef.current = matches;

  const legend = useMemo(() => (graph ? buildLegend(graph) : null), [graph]);

  // Edges from the graph: one per navigation, from the function's row to the target page
  const edges = useMemo(() => {
    if (!graph) return [];
    return graph.edges
      .filter((e) => !isHidden(e, ui.hidden))
      .map((e, i) => ({
        id: `e${i}`,
        source: e.from,
        sourceHandle: `fn:${e.fn}`,
        target: e.to,
        targetHandle: 'in',
        type: 'smoothstep',
        pathOptions: { borderRadius: 0, offset: GRID },
        data: e,
        ...edgeStyle(e, legend.colors),
      }));
  }, [graph, legend, ui.hidden]);

  // Nodes are (re)built only when the graph, the direction or a re-layout changes them. Dragging,
  // filtering and edge toggles leave positions (and the view) alone. Positions: dragged, else where
  // the node already is (same direction, e.g. after a file change), else dagre's layout, on the grid.
  const layoutKey = `${ui.direction}:${relayouts}`;
  const lastLayoutKey = useRef(null);
  const needsFit = useRef(true);
  useEffect(() => {
    if (!graph) return;
    const list = graph.pages.map((page) => ({ id: page.path, type: 'page', height: nodeHeight(page.functions.length), data: { page } }));
    if (graph.edges.some((e) => e.dynamic)) list.push({ id: '?', type: 'unknown', height: 40, data: {} });
    // Laid out with every edge, so hiding a kind doesn't move nodes
    const auto = layout(list, graph.edges.map((e) => ({ source: e.from, target: e.to, data: e })), ui.direction);
    const dragged = saved.current[ui.direction] || {};
    const sameLayout = lastLayoutKey.current === layoutKey;
    if (!sameLayout) needsFit.current = true;
    lastLayoutKey.current = layoutKey;
    setNodes((prev) => {
      const current = sameLayout ? new Map(prev.map((n) => [n.id, n.position])) : new Map();
      return list.map((n) => ({
        id: n.id,
        type: n.type,
        position: dragged[n.id] || current.get(n.id) || snap(auto[n.id]),
        data: { ...n.data, direction: ui.direction, colors: legend.colors, dimmed: n.type === 'page' && !matchesRef.current(n.data.page) },
      }));
    });
  }, [graph, legend, layoutKey, setNodes]);

  // Filtering only dims nodes
  useEffect(() => {
    setNodes((prev) => prev.map((n) => (n.type === 'page' ? { ...n, data: { ...n.data, dimmed: !matches(n.data.page) } } : n)));
  }, [matches, setNodes]);

  // Fit when the view is (re)built: on open, a new direction, or Re-layout; never after a drag
  const initialized = useNodesInitialized();
  useEffect(() => {
    if (initialized && needsFit.current) {
      needsFit.current = false;
      fitView({ padding: 0.15 });
    }
  }, [initialized, nodes, fitView]);

  const onNodeDragStop = useCallback((_, node) => {
    const dir = ui.direction;
    saved.current = { ...saved.current, [dir]: { ...(saved.current[dir] || {}), [node.id]: snap(node.position) } };
    post({ type: 'savePositions', positions: saved.current });
  }, [ui.direction]);
  const relayout = () => {
    saved.current = { ...saved.current, [ui.direction]: {} };
    post({ type: 'savePositions', positions: saved.current });
    setRelayouts((n) => n + 1);
  };
  const toggle = (id) => setUi((u) => ({ ...u, hidden: u.hidden.includes(id) ? u.hidden.filter((k) => k !== id) : [...u.hidden, id] }));

  if (!graph) return <div className="loading">Reading the project…</div>;
  const visibleEdges = edges.filter((e) => !search || nodes.find((n) => n.id === e.source && !n.data.dimmed));

  return (
    <div className="app">
      <div className="toolbar">
        <input className="search" placeholder="Filter pages or functions" value={ui.search}
          onChange={(e) => setUi({ ...ui, search: e.target.value })} />
        <span className="spacer" />
        <select value={ui.direction} onChange={(e) => setUi({ ...ui, direction: e.target.value })} title="Layout direction">
          <option value="LR">Left → right</option>
          <option value="TB">Top → bottom</option>
        </select>
        <button onClick={relayout} title="Forget dragged positions and lay out again">Re-layout</button>
        <button onClick={() => fitView({ padding: 0.15 })}>Fit</button>
        <button onClick={() => post({ type: 'refresh' })} title="Read the project again">Refresh</button>
      </div>
      <div className="summary">{graph.pages.length} pages · {graph.edges.filter((e) => !e.inferred).length} navigations</div>
      <ReactFlow
        nodes={nodes}
        edges={visibleEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        snapToGrid
        snapGrid={[GRID, GRID]}
        nodesConnectable={false}
        elementsSelectable
        minZoom={0.1}
        proOptions={{ hideAttribution: true }}
        colorMode={document.body.classList.contains('vscode-light') ? 'light' : 'dark'}
      >
        <Background gap={GRID} size={1} />
        <Panel position="top-left"><Legend legend={legend} hidden={ui.hidden} onToggle={toggle} /></Panel>
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeStrokeWidth={2} />
      </ReactFlow>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<ReactFlowProvider><App /></ReactFlowProvider>);
