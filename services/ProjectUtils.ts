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
