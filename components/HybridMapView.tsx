import React, { useMemo, useState, useRef } from 'react';
import ReactDOM from 'react-dom';
import { Project, Subsystem, Failure, Mode } from '../types';

// ── Layout constants ──────────────────────────────────────────────────────────
const SYS_W = 320;
const SYS_H = 72;
const SUB_W = 200;
const SUB_H = 90;
const FF_W  = 190;
const FF_H  = 62;
const FM_W  = 215;
const FM_H  = 136;
const H_GAP = 32;      // horizontal gap between card columns within a sub
const V_GAP = 24;      // vertical gap between FF rows
const FM_V_GAP = 16;   // vertical gap between FM cards within one FF row
const COL_GAP = 40;    // horizontal gap between sub columns
const SYS_BOTTOM_TO_BUS = 28;
const BUS_TO_SUB = 28;
const PADDING = 56;
const CONN_COLOR = '#cbd5e1';
const CONN_W = 2;

// ── Types ─────────────────────────────────────────────────────────────────────
interface NodeLayout { x: number; y: number; w: number; h: number; }
type LayoutMap = Record<string, NodeLayout>;
interface TooltipState { type: 'sys' | 'sub' | 'ff' | 'fm'; rect: DOMRect; data: Project | Subsystem | Failure | Mode; }

// ── Height helpers ────────────────────────────────────────────────────────────
function ffRowHeight(fail: Failure, expanded: Set<string>): number {
  if (!expanded.has(fail.id) || fail.modes.length === 0) return FF_H;
  return Math.max(FF_H, fail.modes.length * FM_H + (fail.modes.length - 1) * FM_V_GAP);
}

function groupHeight(sub: Subsystem, expanded: Set<string>): number {
  if (!expanded.has(sub.id) || sub.failures.length === 0) return SUB_H;
  let total = 0;
  sub.failures.forEach((f, fi) => {
    total += ffRowHeight(f, expanded);
    if (fi < sub.failures.length - 1) total += V_GAP;
  });
  return Math.max(SUB_H, total);
}

/** Width of one sub column — compact when collapsed, full when expanded. */
function colWidth(sub: Subsystem, expanded: Set<string>): number {
  if (!expanded.has(sub.id)) return SUB_W;
  return SUB_W + H_GAP + FF_W + H_GAP + FM_W;
}

// ── Layout computation ────────────────────────────────────────────────────────
function computeLayout(
  project: Project,
  expanded: Set<string>
): { map: LayoutMap; canvasW: number; canvasH: number; busY: number; colXs: number[] } {
  const subs = project.subsystems;
  const n = subs.length;

  // Dynamic per-column X positions
  const colXs: number[] = [];
  let curX = PADDING;
  subs.forEach((sub) => {
    colXs.push(curX);
    curX += colWidth(sub, expanded) + COL_GAP;
  });
  const contentRight = n > 0 ? curX - COL_GAP : PADDING;
  const canvasW = Math.max(SYS_W + PADDING * 2, contentRight + PADDING);

  const sysX  = (canvasW - SYS_W) / 2;
  const sysY  = PADDING;
  const busY  = sysY + SYS_H + SYS_BOTTOM_TO_BUS;
  const subRowY = busY + BUS_TO_SUB;

  let maxGroupH = SUB_H;
  subs.forEach(s => { maxGroupH = Math.max(maxGroupH, groupHeight(s, expanded)); });

  const canvasH = subRowY + maxGroupH + PADDING;

  const map: LayoutMap = {};
  map[project.id] = { x: sysX, y: sysY, w: SYS_W, h: SYS_H };

  subs.forEach((sub, i) => {
    const gh   = groupHeight(sub, expanded);
    const colX = colXs[i];
    const subY = subRowY + Math.max(0, (gh - SUB_H) / 2);
    map[sub.id] = { x: colX, y: subY, w: SUB_W, h: SUB_H };

    if (!expanded.has(sub.id)) return;

    let cursor = subRowY;
    const ffX  = colX + SUB_W + H_GAP;
    const fmX  = ffX  + FF_W  + H_GAP;

    sub.failures.forEach((fail, fi) => {
      const rh  = ffRowHeight(fail, expanded);
      const ffY = cursor + Math.max(0, (rh - FF_H) / 2);
      map[fail.id] = { x: ffX, y: ffY, w: FF_W, h: FF_H };

      if (expanded.has(fail.id)) {
        fail.modes.forEach((mode, mi) => {
          map[mode.id] = { x: fmX, y: cursor + mi * (FM_H + FM_V_GAP), w: FM_W, h: FM_H };
        });
      }
      cursor += rh;
      if (fi < sub.failures.length - 1) cursor += V_GAP;
    });
  });

  return { map, canvasW, canvasH, busY, colXs };
}

// ── Connector helpers (div-based — html2canvas safe) ──────────────────────────
let _k = 0;

function hLine(x1: number, y: number, x2: number): React.ReactNode {
  const left = Math.min(x1, x2);
  const width = Math.abs(x2 - x1);
  if (width < 1) return null;
  return <div key={_k++} style={{ position:'absolute', left, top: Math.round(y) - 1, width, height: CONN_W, background: CONN_COLOR, zIndex: 5, pointerEvents:'none' }} />;
}

function vLine(x: number, y1: number, y2: number): React.ReactNode {
  const top    = Math.min(y1, y2);
  const height = Math.abs(y2 - y1);
  if (height < 1) return null;
  return <div key={_k++} style={{ position:'absolute', left: Math.round(x) - 1, top, width: CONN_W, height, background: CONN_COLOR, zIndex: 5, pointerEvents:'none' }} />;
}

// ── Multi-line text clamp ─────────────────────────────────────────────────────
function clamp(lines: number): React.CSSProperties {
  return { display:'-webkit-box', WebkitLineClamp:lines, WebkitBoxOrient:'vertical', overflow:'hidden' } as React.CSSProperties;
}

// ── RPN helper ────────────────────────────────────────────────────────────────
function calcRpn(mode: Mode): string {
  const v = Number(mode.rpn.s) * Number(mode.rpn.o) * Number(mode.rpn.d);
  return isNaN(v) || v === 0 ? '' : String(v);
}

// ── Component ─────────────────────────────────────────────────────────────────
interface HybridMapViewProps {
  project: Project;
  treeExpanded: Set<string>;
  treeSelected: string | null;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
}

export const HybridMapView: React.FC<HybridMapViewProps> = ({
  project, treeExpanded, treeSelected, onToggle, onSelect,
}) => {
  _k = 0;

  const { map, canvasW, canvasH, busY, colXs } = useMemo(
    () => computeLayout(project, treeExpanded),
    [project, treeExpanded]
  );

  // ── Tooltip ───────────────────────────────────────────────────────────────
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startHover = (e: React.MouseEvent, type: 'sys' | 'sub' | 'ff' | 'fm', data: Project | Subsystem | Failure | Mode) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    timerRef.current = setTimeout(() => setTooltip({ type, rect, data }), 1000);
  };
  const endHover = (typeOverride?: string | React.MouseEvent) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (typeOverride === 'sys' || tooltip?.type === 'sys') {
      hideTimerRef.current = setTimeout(() => setTooltip(null), 500);
    } else {
      setTooltip(null);
    }
  };
  const cancelHide = () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
  };

  const sysLayout = map[project.id];

  // ── Connectors ────────────────────────────────────────────────────────────
  const connectors: React.ReactNode[] = [];

  if (sysLayout && project.subsystems.length > 0) {
    const sysCx     = sysLayout.x + SYS_W / 2;
    const sysBottom = sysLayout.y + SYS_H;

    connectors.push(vLine(sysCx, sysBottom, busY));

    const subCxs   = project.subsystems.map((_, i) => (colXs[i] ?? PADDING) + SUB_W / 2);
    const busLeft  = Math.min(...subCxs);
    const busRight = Math.max(...subCxs);
    if (busLeft < busRight) connectors.push(hLine(busLeft, busY, busRight));

    project.subsystems.forEach(sub => {
      const sl = map[sub.id];
      if (!sl) return;

      const subCx = sl.x + SUB_W / 2;
      connectors.push(vLine(subCx, busY, sl.y));

      if (!treeExpanded.has(sub.id) || sub.failures.length === 0) return;

      const subMidY = sl.y + SUB_H / 2;
      const ffBusX  = sl.x + SUB_W + H_GAP / 2;
      const ffLayouts = sub.failures.map(f => map[f.id]).filter((l): l is NodeLayout => !!l);
      if (!ffLayouts.length) return;

      const firstFfMidY = ffLayouts[0].y + FF_H / 2;
      const lastFfMidY  = ffLayouts[ffLayouts.length - 1].y + FF_H / 2;

      connectors.push(hLine(sl.x + SUB_W, subMidY, ffBusX));
      const vTop = Math.min(subMidY, firstFfMidY), vBot = Math.max(subMidY, lastFfMidY);
      if (vTop < vBot) connectors.push(vLine(ffBusX, vTop, vBot));

      sub.failures.forEach(fail => {
        const fl = map[fail.id];
        if (!fl) return;
        const ffMidY = fl.y + FF_H / 2;
        connectors.push(hLine(ffBusX, ffMidY, fl.x));

        if (!treeExpanded.has(fail.id) || !fail.modes.length) return;

        const fmBusX    = fl.x + FF_W + H_GAP / 2;
        const fmLayouts = fail.modes.map(m => map[m.id]).filter((l): l is NodeLayout => !!l);
        if (!fmLayouts.length) return;

        const firstFmMidY = fmLayouts[0].y + FM_H / 2;
        const lastFmMidY  = fmLayouts[fmLayouts.length - 1].y + FM_H / 2;

        connectors.push(hLine(fl.x + FF_W, ffMidY, fmBusX));
        const fmVTop = Math.min(ffMidY, firstFmMidY), fmVBot = Math.max(ffMidY, lastFmMidY);
        if (fmVTop < fmVBot) connectors.push(vLine(fmBusX, fmVTop, fmVBot));

        fail.modes.forEach(mode => {
          const ml = map[mode.id];
          if (!ml) return;
          connectors.push(hLine(fmBusX, ml.y + FM_H / 2, ml.x));
        });
      });
    });
  }

  // ── Tooltip portal ────────────────────────────────────────────────────────
  const tooltipEl = tooltip && ReactDOM.createPortal(
    <div
      style={{
        position: 'fixed',
        zIndex: 9999,
        ...(tooltip.rect.top > window.innerHeight / 2 
           ? { bottom: Math.max(10, window.innerHeight - tooltip.rect.bottom) }
           : { top: Math.max(10, tooltip.rect.top) }),
        ...(tooltip.rect.right + 320 > window.innerWidth
          ? { right: Math.max(10, window.innerWidth - tooltip.rect.left + 10) }
          : { left: tooltip.rect.right + 10 }),
        maxWidth: 300,
      }}
      className={`bg-white border border-slate-200 rounded-xl shadow-2xl p-4 ${tooltip.type === 'sys' ? 'pointer-events-auto overflow-y-auto max-h-[50vh] scroll-thin' : 'pointer-events-none'}`}
      onMouseEnter={tooltip.type === 'sys' ? cancelHide : undefined}
      onMouseLeave={tooltip.type === 'sys' ? () => endHover('sys') : undefined}
    >
      {tooltip.type === 'sys' ? (() => {
        const p = tooltip.data as Project;
        return <>
          <div className="font-bold text-slate-800 text-sm mb-2 leading-snug">{p.name}</div>
          {p.desc && <div className="mb-2"><div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-0.5">Description</div><div className="text-xs text-slate-600 leading-relaxed">{p.desc}</div></div>}
        </>;
      })() : tooltip.type === 'sub' ? (() => {
        const s = tooltip.data as Subsystem;
        return <>
          <div className="font-bold text-slate-800 text-sm mb-2 leading-snug">{s.name}</div>
          {s.func  && <div className="mb-2"><div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-0.5">Function</div><div className="text-xs text-slate-600 leading-relaxed">{s.func}</div></div>}
          {s.specs && <div><div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-0.5">Specs</div><div className="text-xs text-slate-500 leading-relaxed">{s.specs}</div></div>}
        </>;
      })() : tooltip.type === 'ff' ? (() => {
        const f = tooltip.data as Failure;
        return <>
          <div className="font-bold text-slate-800 text-sm mb-2 leading-snug">{f.desc}</div>
        </>;
      })() : (() => {
        const m = tooltip.data as Mode;
        const rpn = calcRpn(m);
        return <>
          <div className="font-bold text-slate-800 text-sm mb-2 leading-snug">{m.mode}</div>
          {m.effect     && <div className="text-xs text-red-500 font-bold mb-1 leading-snug">{m.effect}</div>}
          {m.cause      && <div className="text-xs text-slate-500 italic mb-2 leading-snug">{m.cause}</div>}
          {m.mitigation && <div className="text-xs bg-green-50 text-green-700 px-2 py-1.5 rounded border border-green-100 font-semibold mb-2 leading-snug">{m.mitigation}</div>}
          {rpn          && <div className="text-xs text-slate-400">RPN: <span className="font-bold text-slate-600 text-sm">{rpn}</span></div>}
        </>;
      })()}
    </div>,
    document.body
  );

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="hybrid-map-canvas" style={{ position:'relative', width:canvasW, height:canvasH, background:'#f8fafc' }}>
      {connectors}

      {/* System card */}
      {sysLayout && (
        <div style={{ position:'absolute', left:sysLayout.x, top:sysLayout.y, width:SYS_W, zIndex:20 }}
          className="bg-slate-900 text-white border border-slate-800 rounded-xl px-6 py-4 shadow-lg text-center select-none cursor-default transition-all hover:scale-[1.02] hover:shadow-2xl hover:z-50"
          onMouseEnter={e => startHover(e, 'sys', project)}
          onMouseLeave={() => endHover('sys')}
        >
          <div className="font-bold text-base leading-tight">{project.name}</div>
          {project.desc && <div className="text-xs text-slate-400 mt-1" style={clamp(2)}>{project.desc}</div>}
        </div>
      )}

      {/* Sub cards */}
      {project.subsystems.map(sub => {
        const sl = map[sub.id];
        if (!sl) return null;
        const isExp = treeExpanded.has(sub.id), isSel = treeSelected === sub.id;
        return (
          <div key={sub.id}
            style={{ position:'absolute', left:sl.x, top:sl.y, width:SUB_W, height:SUB_H, zIndex:20 }}
            className={`bg-white border border-slate-200 border-l-[5px] border-l-brand-500 rounded-lg p-3 shadow-sm cursor-pointer select-none transition-all hover:scale-105 hover:shadow-lg hover:z-50${isSel?' ring-2 ring-brand-500':''}`}
            onClick={() => { onToggle(sub.id); onSelect(sub.id); }}
            onMouseEnter={e => startHover(e, 'sub', sub)}
            onMouseLeave={endHover}
          >
            <div className="font-bold text-sm text-slate-700 leading-tight" style={clamp(1)}>{sub.name}</div>
            {sub.func && <div className="text-xs text-slate-500 mt-1 leading-tight sub-func-desc" style={clamp(2)}>{sub.func}</div>}
            <div className="text-[10px] text-slate-400 mt-1 flex items-center gap-1">
              <span>{sub.failures.length} FF</span><span>{isExp?'▲':'▼'}</span>
            </div>
          </div>
        );
      })}

      {/* FF cards */}
      {project.subsystems.flatMap(sub =>
        treeExpanded.has(sub.id) ? sub.failures.map(fail => {
          const fl = map[fail.id];
          if (!fl) return null;
          const isExp = treeExpanded.has(fail.id), isSel = treeSelected === fail.id;
          return (
            <div key={fail.id}
              style={{ position:'absolute', left:fl.x, top:fl.y, width:FF_W, height:FF_H, zIndex:20 }}
              className={`bg-white border border-slate-200 border-l-[5px] border-l-amber-500 rounded-lg p-2 shadow-sm cursor-pointer select-none transition-all hover:scale-105 hover:shadow-lg hover:z-50 overflow-hidden${isSel?' ring-2 ring-amber-400':''}`}
              onClick={() => { onToggle(fail.id); onSelect(fail.id); }}
              onMouseEnter={e => startHover(e, 'ff', fail)}
              onMouseLeave={endHover}
            >
              <div className="font-bold text-xs text-slate-700 leading-tight" style={clamp(2)}>
                {fail.desc || <span className="text-slate-300 italic">Unnamed</span>}
              </div>
              <div className="text-[10px] text-slate-400 mt-1 flex items-center gap-1">
                <span>{fail.modes.length} FM</span><span>{isExp?'▲':'▼'}</span>
              </div>
            </div>
          );
        }) : []
      )}

      {/* FM cards */}
      {project.subsystems.flatMap(sub =>
        treeExpanded.has(sub.id) ? sub.failures.flatMap(fail =>
          treeExpanded.has(fail.id) ? fail.modes.map(mode => {
            const ml = map[mode.id];
            if (!ml) return null;
            const isSel = treeSelected === mode.id;
            const rpn = calcRpn(mode);
            return (
              <div key={mode.id}
                style={{ position:'absolute', left:ml.x, top:ml.y, width:FM_W, height:FM_H, zIndex:20 }}
                className={`bg-white border border-slate-200 border-l-[5px] border-l-red-500 rounded-lg p-2 shadow-sm cursor-pointer select-none transition-all hover:scale-105 hover:shadow-lg hover:z-50 overflow-hidden${isSel?' ring-2 ring-red-400':''}`}
                onClick={() => onSelect(mode.id)}
                onMouseEnter={e => startHover(e, 'fm', mode)}
                onMouseLeave={endHover}
              >
                <div className="font-bold text-xs text-slate-700 mb-1 leading-tight" style={clamp(2)}>
                  {mode.mode || <span className="text-slate-300 italic">Unnamed</span>}
                </div>
                {mode.effect     && <div className="text-[10px] text-red-500 font-bold mb-1 leading-tight" style={clamp(1)}>{mode.effect}</div>}
                {mode.cause      && <div className="text-[10px] text-slate-500 italic mb-1 leading-tight" style={clamp(1)}>{mode.cause}</div>}
                {mode.mitigation && <div className="text-[10px] bg-green-50 text-green-700 px-2 py-1 rounded border border-green-100 font-bold leading-tight" style={clamp(2)}>{mode.mitigation}</div>}
                {rpn             && <div className="text-[10px] text-slate-400 mt-1">RPN: <span className="font-bold text-slate-600">{rpn}</span></div>}
              </div>
            );
          }) : []
        ) : []
      )}

      {tooltipEl}
    </div>
  );
};
