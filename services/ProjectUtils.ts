// Shared project/date/RPN helpers. Extracted from App.tsx so services can reuse the
// exact same logic instead of re-implementing it (App still uses these definitions).

export const nowIso = () => new Date().toISOString();

export const tryIso = (x: any): string | null => {
    try { if (!x) return null; const d = new Date(x); return Number.isNaN(d.getTime()) ? null : d.toISOString(); } catch (e) { return null; }
};

export const normalizeProjectDates = (sp: any) => {
    const now = nowIso();
    const createdAt = sp.createdAt || sp.updatedAt || tryIso(sp.created) || tryIso(sp.updated) || now;
    const updatedAt = sp.updatedAt || tryIso(sp.updated) || createdAt;
    return { ...sp, createdAt, updatedAt };
};

export const hasCompleteRpn = (rpn: any) => [rpn?.s, rpn?.o, rpn?.d].every(v => String(v ?? '').trim() !== '' && !Number.isNaN(Number(v)));

export const rpnTotal = (rpn: any): number | "" => hasCompleteRpn(rpn) ? Number(rpn.s) * Number(rpn.o) * Number(rpn.d) : "";

// ── RPN reasoning ────────────────────────────────────────────────────────────
// The AI scorer stores one flat `rpnReason` string shaped as
//   "S: <n> because ... O: <n> because ... Baseline D: <n> because ... Mitigated D: <n> because ... Confidence: <level>."
// These helpers split it back into per-score segments so the UI and the chatbot can
// attribute each sentence to the score it justifies.

export interface RpnReasonParts {
    s?: string;
    o?: string;
    baselineD?: string;
    mitigatedD?: string;
    confidence?: string;
}

// Leading boundary is captured (not consumed via lookbehind) for Safari compatibility.
const REASON_MARKER_RE = /(^|[\s.;,])(Baseline\s*D|Mitigated\s*D|Confidence|S|O|D)\s*[:=]\s*/gi;

const markerKey = (raw: string, seen: Set<keyof RpnReasonParts>): keyof RpnReasonParts | null => {
    const t = raw.replace(/\s+/g, ' ').trim().toLowerCase();
    if (t === 'baseline d') return 'baselineD';
    if (t === 'mitigated d') return 'mitigatedD';
    if (t === 'confidence') return 'confidence';
    if (t === 's') return 's';
    if (t === 'o') return 'o';
    // A bare "D:" means the baseline when none was named yet, otherwise the mitigated score.
    if (t === 'd') return seen.has('baselineD') ? 'mitigatedD' : 'baselineD';
    return null;
};

export const parseRpnReason = (reason?: string): RpnReasonParts => {
    const text = String(reason || '').trim();
    if (!text) return {};

    const hits: Array<{ key: keyof RpnReasonParts; bodyStart: number; markerStart: number }> = [];
    const seen = new Set<keyof RpnReasonParts>();
    REASON_MARKER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = REASON_MARKER_RE.exec(text)) !== null) {
        const key = markerKey(m[2], seen);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        hits.push({ key, markerStart: m.index + m[1].length, bodyStart: m.index + m[0].length });
    }
    if (!hits.length) return {};

    const parts: RpnReasonParts = {};
    hits.forEach((hit, i) => {
        const end = i + 1 < hits.length ? hits[i + 1].markerStart : text.length;
        const body = text.slice(hit.bodyStart, end).trim().replace(/[.,;\s]+$/, '');
        if (body) parts[hit.key] = body;
    });
    return parts;
};

export interface RpnScoreDelta {
    key: 's' | 'o' | 'd';
    label: string;
    before: number | null;   // baseline — current controls only
    after: number | null;    // stored score — post-mitigation
    changed: boolean;
}

const numOrNull = (v: any): number | null => {
    const s = String(v ?? '').trim();
    if (!s || Number.isNaN(Number(s))) return null;
    return Number(s);
};

/** Baseline (pre-mitigation) vs stored (post-mitigation) score pairs for one mode. */
export const rpnScoreDeltas = (mode: any): RpnScoreDelta[] => {
    const labels: Record<'s' | 'o' | 'd', string> = { s: 'Severity', o: 'Occurrence', d: 'Detection' };
    return (['s', 'o', 'd'] as const).map(key => {
        const after = numOrNull(mode?.rpn?.[key]);
        const before = numOrNull(mode?.rpnBaseline?.[key]);
        return { key, label: labels[key], before, after, changed: before !== null && after !== null && before !== after };
    });
};

/** True when a baseline exists and any of S/O/D moved after mitigation. */
export const hasRpnImprovement = (mode: any) => rpnScoreDeltas(mode).some(d => d.changed);
