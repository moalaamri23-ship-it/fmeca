import { Project, Subsystem, Failure } from '../types';

// ── Layout constants ──────────────────────────────────────────────────────────
// Shared by the on-screen map (HybridMapView), the SVG exporter (MapSvg) and —
// by hand-copied literals — the exported interactive HTML. Change one, change
// all three.
export const SYS_W = 320;
export const SYS_H = 72;
export const SUB_W = 200;
export const SUB_H = 90;
export const FF_W  = 190;
export const FF_H  = 62;
export const FM_W  = 215;
export const FM_H  = 136;
export const H_GAP = 32;      // horizontal gap between card columns within a sub
export const V_GAP = 24;      // vertical gap between FF rows
export const FM_V_GAP = 16;   // vertical gap between FM cards within one FF row
export const COL_GAP = 40;    // horizontal gap between sub columns
export const SYS_BOTTOM_TO_BUS = 28;
export const BUS_TO_SUB = 28;
export const PADDING = 56;
export const CONN_COLOR = '#cbd5e1';
export const CONN_W = 2;

// ── Types ─────────────────────────────────────────────────────────────────────
export interface NodeLayout { x: number; y: number; w: number; h: number; }
export type LayoutMap = Record<string, NodeLayout>;
export interface MapLayout {
  map: LayoutMap;
  canvasW: number;
  canvasH: number;
  busY: number;
  colXs: number[];
}

// ── Height helpers ────────────────────────────────────────────────────────────
export function ffRowHeight(fail: Failure, expanded: Set<string>): number {
  if (!expanded.has(fail.id) || fail.modes.length === 0) return FF_H;
  return Math.max(FF_H, fail.modes.length * FM_H + (fail.modes.length - 1) * FM_V_GAP);
}

export function groupHeight(sub: Subsystem, expanded: Set<string>): number {
  if (!expanded.has(sub.id) || sub.failures.length === 0) return SUB_H;
  let total = 0;
  sub.failures.forEach((f, fi) => {
    total += ffRowHeight(f, expanded);
    if (fi < sub.failures.length - 1) total += V_GAP;
  });
  return Math.max(SUB_H, total);
}

/** Width of one sub column — compact when collapsed, full when expanded. */
export function colWidth(sub: Subsystem, expanded: Set<string>): number {
  if (!expanded.has(sub.id)) return SUB_W;
  return SUB_W + H_GAP + FF_W + H_GAP + FM_W;
}

// ── Layout computation ────────────────────────────────────────────────────────
export function computeLayout(project: Project, expanded: Set<string>): MapLayout {
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
