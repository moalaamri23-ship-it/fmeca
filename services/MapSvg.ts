import { Project, Mode } from '../types';
import { combineControlsAndMitigation } from '../components/MitigationBuilder';
import {
  computeLayout, NodeLayout,
  SYS_W, SYS_H, SUB_W, SUB_H, FF_W, FF_H, FM_W, FM_H,
  H_GAP, PADDING, CONN_COLOR, CONN_W,
} from './MapLayout';

// ── Text helpers ──────────────────────────────────────────────────────────────
const esc = (s: string) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * SVG has no line box, so the DOM's `-webkit-line-clamp` has to be reproduced
 * by hand. Inter's average advance is close enough to 0.52em (0.55em bold) for
 * card text; the last kept line is ellipsised when anything was dropped.
 */
function wrapLines(text: string, widthPx: number, fontPx: number, maxLines: number, bold = false): string[] {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const perChar = fontPx * (bold ? 0.55 : 0.52);
  const maxChars = Math.max(4, Math.floor(widthPx / perChar));
  const words = clean.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= maxChars) { line = next; continue; }
    if (line) lines.push(line);
    // A single word longer than the line gets hard-broken rather than overflowing.
    let rest = word;
    while (rest.length > maxChars) { lines.push(rest.slice(0, maxChars)); rest = rest.slice(maxChars); }
    line = rest;
    if (lines.length > maxLines) break;
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = kept[maxLines - 1].slice(0, -1).trimEnd() + '…';
  return kept;
}

function textBlock(
  lines: string[], x: number, y: number, fontPx: number, lineH: number,
  fill: string, opts: { bold?: boolean; italic?: boolean } = {}
): string {
  if (!lines.length) return '';
  const weight = opts.bold ? ' font-weight="700"' : '';
  const style = opts.italic ? ' font-style="italic"' : '';
  const tspans = lines.map((l, i) => `<tspan x="${x}" dy="${i ? lineH : 0}">${esc(l)}</tspan>`).join('');
  return `<text x="${x}" y="${y}" font-size="${fontPx}" fill="${fill}"${weight}${style}>${tspans}</text>`;
}

function rpnValue(mode: Mode): string {
  const vals = [mode.rpn?.s, mode.rpn?.o, mode.rpn?.d];
  if (vals.some(v => String(v ?? '').trim() === '' || Number.isNaN(Number(v)))) return '';
  return String(Number(vals[0]) * Number(vals[1]) * Number(vals[2]));
}

// ── Card primitives ───────────────────────────────────────────────────────────
const line = (x: number, y: number, w: number, h: number) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${CONN_COLOR}"/>`;

const hLine = (x1: number, y: number, x2: number) => {
  const w = Math.abs(x2 - x1);
  return w < 1 ? '' : line(Math.min(x1, x2), Math.round(y) - 1, w, CONN_W);
};
const vLine = (x: number, y1: number, y2: number) => {
  const h = Math.abs(y2 - y1);
  return h < 1 ? '' : line(Math.round(x) - 1, Math.min(y1, y2), CONN_W, h);
};

/**
 * White card with the coloured 5px left border the DOM cards carry. The accent
 * bar is clipped to the card's rounded rect so its corners follow the card
 * instead of poking out square.
 */
let clipSeq = 0;
function card(l: NodeLayout, w: number, h: number, accent: string, body: string): string {
  const id = `mc${clipSeq++}`;
  return `<g transform="translate(${l.x},${l.y})">`
    + `<clipPath id="${id}"><rect width="${w}" height="${h}" rx="8"/></clipPath>`
    + `<rect width="${w}" height="${h}" rx="8" fill="#ffffff"/>`
    + `<rect width="5" height="${h}" fill="${accent}" clip-path="url(#${id})"/>`
    + `<rect width="${w}" height="${h}" rx="8" fill="none" stroke="#e2e8f0" stroke-width="1"/>`
    + body + `</g>`;
}

/**
 * The map as a standalone, self-contained SVG: same layout, same colours, and
 * text as real text so it stays selectable and sharp at any size — which is the
 * point of offering it beside the PNG exports.
 */
export function buildMapSvg(project: Project, expanded: Set<string>): { svg: string; width: number; height: number } {
  const { map, canvasW, canvasH, busY, colXs } = computeLayout(project, expanded);
  const parts: string[] = [];
  clipSeq = 0;   // deterministic ids: the same project always exports the same file

  const sys = map[project.id];

  // ── Connectors (drawn first so cards sit on top) ───────────────────────────
  if (sys && project.subsystems.length > 0) {
    const sysCx = sys.x + SYS_W / 2;
    parts.push(vLine(sysCx, sys.y + SYS_H, busY));
    const subCxs = project.subsystems.map((_, i) => (colXs[i] ?? PADDING) + SUB_W / 2);
    const busLeft = Math.min(...subCxs, sysCx), busRight = Math.max(...subCxs, sysCx);
    if (busLeft < busRight) parts.push(hLine(busLeft, busY, busRight));

    project.subsystems.forEach(sub => {
      const sl = map[sub.id];
      if (!sl) return;
      parts.push(vLine(sl.x + SUB_W / 2, busY, sl.y));
      if (!expanded.has(sub.id) || sub.failures.length === 0) return;

      const subMidY = sl.y + SUB_H / 2;
      const ffBusX  = sl.x + SUB_W + H_GAP / 2;
      const ffL = sub.failures.map(f => map[f.id]).filter((l): l is NodeLayout => !!l);
      if (!ffL.length) return;
      parts.push(hLine(sl.x + SUB_W, subMidY, ffBusX));
      const vTop = Math.min(subMidY, ffL[0].y + FF_H / 2);
      const vBot = Math.max(subMidY, ffL[ffL.length - 1].y + FF_H / 2);
      if (vTop < vBot) parts.push(vLine(ffBusX, vTop, vBot));

      sub.failures.forEach(fail => {
        const fl = map[fail.id];
        if (!fl) return;
        const ffMidY = fl.y + FF_H / 2;
        parts.push(hLine(ffBusX, ffMidY, fl.x));
        if (!expanded.has(fail.id) || !fail.modes.length) return;

        const fmBusX = fl.x + FF_W + H_GAP / 2;
        const fmL = fail.modes.map(m => map[m.id]).filter((l): l is NodeLayout => !!l);
        if (!fmL.length) return;
        parts.push(hLine(fl.x + FF_W, ffMidY, fmBusX));
        const fmTop = Math.min(ffMidY, fmL[0].y + FM_H / 2);
        const fmBot = Math.max(ffMidY, fmL[fmL.length - 1].y + FM_H / 2);
        if (fmTop < fmBot) parts.push(vLine(fmBusX, fmTop, fmBot));
        fail.modes.forEach(mode => {
          const ml = map[mode.id];
          if (ml) parts.push(hLine(fmBusX, ml.y + FM_H / 2, ml.x));
        });
      });
    });
  }

  // ── System card ────────────────────────────────────────────────────────────
  if (sys) {
    const nameLines = wrapLines(project.name, SYS_W - 48, 16, 1, true);
    const descLines = wrapLines(project.desc || '', SYS_W - 48, 12, 2);
    const nameY = descLines.length ? 30 : 42;
    parts.push(`<g transform="translate(${sys.x},${sys.y})">`
      + `<rect width="${SYS_W}" height="${SYS_H}" rx="12" fill="#0f172a" stroke="#1e293b"/>`
      + nameLines.map(l => `<text x="${SYS_W / 2}" y="${nameY}" font-size="16" font-weight="700" fill="#ffffff" text-anchor="middle">${esc(l)}</text>`).join('')
      + descLines.map((l, i) => `<text x="${SYS_W / 2}" y="${nameY + 18 + i * 15}" font-size="12" fill="#94a3b8" text-anchor="middle">${esc(l)}</text>`).join('')
      + `</g>`);
  }

  // ── Subsystem / FF / FM cards ──────────────────────────────────────────────
  project.subsystems.forEach(sub => {
    const sl = map[sub.id];
    if (!sl) return;
    const isExp = expanded.has(sub.id);
    let body = textBlock(wrapLines(sub.name, SUB_W - 24, 14, 1, true), 14, 26, 14, 17, '#334155', { bold: true });
    body += textBlock(wrapLines(sub.func || '', SUB_W - 24, 12, 2), 14, 46, 12, 15, '#64748b');
    body += `<text x="14" y="${SUB_H - 12}" font-size="10" fill="#94a3b8">${sub.failures.length} FF ${isExp ? '▲' : '▼'}</text>`;
    parts.push(card(sl, SUB_W, SUB_H, '#3b82f6', body));

    if (!isExp) return;

    sub.failures.forEach(fail => {
      const fl = map[fail.id];
      if (!fl) return;
      const fExp = expanded.has(fail.id);
      let fBody = textBlock(wrapLines(fail.desc || 'Unnamed', FF_W - 20, 12, 2, true), 12, 22, 12, 15, '#334155', { bold: true });
      fBody += `<text x="12" y="${FF_H - 10}" font-size="10" fill="#94a3b8">${fail.modes.length} FM ${fExp ? '▲' : '▼'}</text>`;
      parts.push(card(fl, FF_W, FF_H, '#f59e0b', fBody));

      if (!fExp) return;

      fail.modes.forEach(mode => {
        const ml = map[mode.id];
        if (!ml) return;
        const actions = combineControlsAndMitigation(mode.currentControls, mode.mitigation);
        const rpn = rpnValue(mode);
        let y = 22;
        const modeLines = wrapLines(mode.mode || 'Unnamed', FM_W - 20, 12, 2, true);
        let mBody = textBlock(modeLines, 12, y, 12, 14, '#334155', { bold: true });
        y += modeLines.length * 14;
        const effect = wrapLines(mode.effect || '', FM_W - 20, 10, 1, true);
        if (effect.length) { mBody += textBlock(effect, 12, y + 10, 10, 12, '#ef4444', { bold: true }); y += 14; }
        const cause = wrapLines(mode.cause || '', FM_W - 20, 10, 1);
        if (cause.length) { mBody += textBlock(cause, 12, y + 10, 10, 12, '#64748b', { italic: true }); y += 14; }
        const act = wrapLines(actions, FM_W - 32, 10, 2, true);
        if (act.length) {
          const boxH = act.length * 12 + 8;
          mBody += `<rect x="10" y="${y + 2}" width="${FM_W - 22}" height="${boxH}" rx="4" fill="#f0fdf4" stroke="#bbf7d0"/>`
            + textBlock(act, 16, y + 13, 10, 12, '#15803d', { bold: true });
          y += boxH + 4;
        }
        if (rpn) mBody += `<text x="12" y="${Math.min(y + 12, FM_H - 8)}" font-size="10" fill="#94a3b8">RPN: <tspan font-weight="700" fill="#475569">${esc(rpn)}</tspan></text>`;
        parts.push(card(ml, FM_W, FM_H, '#ef4444', mBody));
      });
    });
  });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}" viewBox="0 0 ${canvasW} ${canvasH}" font-family="Inter, system-ui, -apple-system, sans-serif">`
    + `<rect width="100%" height="100%" fill="#f8fafc"/>`
    + parts.join('')
    + `</svg>`;
  return { svg, width: canvasW, height: canvasH };
}
