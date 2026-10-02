import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import { NODE_WIDTH, HEADER_HEIGHT, ROW_HEIGHT } from './layout';
import { post } from './vscode';
import { fnOf } from './legend';

const KIND_ICON = { lifecycle: '◷', handler: '⚡', method: 'ƒ' };
const KIND_TITLE = { lifecycle: 'Lifecycle', handler: 'Event handler (used in the template)', method: 'Method' };
// pages/detail/detail → detail, pages/profile/index → profile/index
const short = (pagePath) => {
  const [dir, name] = pagePath.split('/').slice(-2);
  return dir === name || !name ? (name || dir) : `${dir}/${name}`;
};

// Badge coloured like the navigation function's legend entry
function navBadge(nav) {
  const fn = fnOf(nav);
  const through = nav.viaMethod ? ` (through ${nav.viaMethod})` : '';
  const calls = nav.via ? ` → my.${nav.api}` : '';
  if (nav.api === 'navigateBack') return { text: '↩ back', className: 'badge back', title: `${fn}${calls}${through}` };
  if (!nav.target) return { text: '→ ?', className: 'badge dynamic', title: `${fn}${calls}${through}: ${nav.raw} (URL not known until run time)` };
  return { text: `→ ${short(nav.target)}`, className: 'badge', title: `${fn}${calls}${through} → ${nav.target}` };
}

// A page: header (path, tab/entry badges; click opens the page) and one row per function (click opens
// its line). Each row that navigates has its own source handle, so edges start at the function.
function PageNode({ data }) {
  const { page, direction, dimmed, colors } = data;
  const target = direction === 'LR' ? Position.Left : Position.Top;
  return (
    <div className={`page-node${dimmed ? ' dimmed' : ''}`} style={{ width: NODE_WIDTH }}>
      <Handle type="target" id="in" position={target} className="handle-in" />
      <div className="page-header" style={{ height: HEADER_HEIGHT }} title={`Open ${page.file || page.path}`}
        onClick={() => post({ type: 'openPage', path: page.path })}>
        <span className="page-path">{page.path}</span>
        {page.isEntry && <span className="tag entry" title="First page in app.json">entry</span>}
        {page.isTab && <span className="tag tab" title="Tab bar page">tab</span>}
      </div>
      <div className="rows">
        {page.functions.length === 0 && <div className="row empty" style={{ height: ROW_HEIGHT }}>{page.file ? 'no functions' : 'no script file'}</div>}
        {page.functions.map((fn) => (
          <div key={fn.name} className={`row${fn.navs.length ? ' navigates' : ''}`} style={{ height: ROW_HEIGHT }}
            title={`${KIND_TITLE[fn.kind]} · line ${fn.line}`}
            onClick={() => page.file && post({ type: 'openSource', file: page.file, line: fn.line })}>
            <span className={`kind ${fn.kind}`}>{KIND_ICON[fn.kind]}</span>
            <span className="fn-name">{fn.name}</span>
            <span className="badges">
              {fn.navs.map((nav, i) => {
                const b = navBadge(nav);
                return <span key={i} className={b.className} title={b.title} style={{ color: (colors && colors[fnOf(nav)]) || undefined }}>{b.text}</span>;
              })}
            </span>
            {fn.navs.length > 0 && <Handle type="source" id={`fn:${fn.name}`} position={Position.Right} className="handle-out" />}
          </div>
        ))}
      </div>
    </div>
  );
}

// "?" — where navigations with URLs computed at run time go
function UnknownNode({ data }) {
  const target = data.direction === 'LR' ? Position.Left : Position.Top;
  return (
    <div className="unknown-node" title="URLs only known at run time">
      <Handle type="target" id="in" position={target} className="handle-in" />
      ? dynamic URL
    </div>
  );
}

export const nodeTypes = { page: memo(PageNode), unknown: memo(UnknownNode) };
