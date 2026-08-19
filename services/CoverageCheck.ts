import { BreakdownRow, Failure, StandardParameter, Project, Subsystem } from '../types';

/**
 * Coverage checking for a subsystem's function breakdown and its functional
 * failures.
 *
 * This module reports. It never writes, and nothing here may be wired to a
 * generator that closes a gap automatically.
 *
 * That restraint is the point. The pipeline's worst failure was a template that
 * filled an empty functional failure with the function restated — plausible,
 * auditable-looking, and wrong. Anything that fills a reported gap on its own
 * recreates that: a gap closed by a machine reads exactly like a gap that was
 * never there. Whether a missing direction is a real omission or a correct
 * judgement about the equipment is an engineering question, and the engineer is
 * the one who can answer it. So the output of this file is a list of questions,
 * not a list of edits.
 */

export type CoverageSeverity = 'gap' | 'conflict' | 'info';

export interface CoverageFinding {
    rowId: string;
    severity: CoverageSeverity;
    /** Short label for the chip in the breakdown table. */
    label: string;
    /** One sentence the engineer can act on. */
    detail: string;
}

/** Fahrenheit/Celsius pairs that do not convert, and similar within-standard contradictions. */
const F_TO_C = (f: number) => (f - 32) * 5 / 9;

/**
 * A standard often states the same quantity twice: "198.2 deg F (59 deg C)", or
 * "12 barg (13.8 barg design)". When the two disagree, every failure derived
 * from the parameter quantifies against whichever one the model picked. Worth
 * surfacing before it becomes a maintenance limit.
 */
function findUnitConflict(text: string): string | null {
    const pair = text.match(/(-?\d+(?:\.\d+)?)\s*(?:deg\s*)?F\b[^)]*?\(?\s*(-?\d+(?:\.\d+)?)\s*(?:deg\s*)?C\b/i);
    if (!pair) return null;
    const f = Number(pair[1]);
    const c = Number(pair[2]);
    if (!Number.isFinite(f) || !Number.isFinite(c)) return null;
    const expected = F_TO_C(f);
    // 1 degree of slack absorbs honest rounding.
    if (Math.abs(expected - c) <= 1) return null;
    return `${f} deg F is ${expected.toFixed(1)} deg C, but the standard says ${c} deg C.`;
}

/**
 * Two bare magnitudes in one value, far enough apart that they cannot be the
 * same number rounded. Catches the disputed-value case that findUnitConflict
 * misses because both figures carry the same unit -- the source documents for
 * one package stated design pressure as both 12 barg and 13.8 barg, and the
 * pipeline turned the disagreement into separate functional failures instead of
 * one disputed requirement.
 */
function findValueConflict(value: string, unit?: string | null): string | null {
    const nums = Array.from(String(value).matchAll(/-?\d+(?:\.\d+)?/g)).map(m => Number(m[0]));
    if (nums.length < 2) return null;
    const [a, b] = [nums[0], nums[1]];
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    const spread = Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1);
    // 2% absorbs rounding between two statements of one figure. Anything wider is
    // two different figures wearing one requirement.
    if (spread <= 0.02) return null;
    const u = unit ? ` ${unit}` : '';
    return `states both ${a}${u} and ${b}${u}. Which one does the equipment have to meet?`;
}

/** Directions that a parameter's bound makes worth asking about. */
function credibleDirections(p: StandardParameter): string[] {
    switch (p.bound) {
        case 'min': return ['partial'];
        case 'max': return ['upper_limit'];
        case 'spec': return ['partial'];
        case 'range':
        case 'target':
        default: return ['partial', 'upper_limit'];
    }
}

/**
 * Compare one breakdown row against the failures generated for it.
 *
 * `failures` must already be filtered to this row.
 */
export function checkRow(row: BreakdownRow, failures: Failure[]): CoverageFinding[] {
    const findings: CoverageFinding[] = [];
    const params = row.standardParameters ?? [];
    const states = new Set(failures.map(f => f.failedState).filter(Boolean) as string[]);
    const covered = new Set(
        failures
            .filter(f => f.parameter && f.failedState)
            .map(f => `${f.parameter}|${f.failedState}`)
    );

    if (failures.length === 0) {
        findings.push({
            rowId: row.id,
            severity: 'gap',
            label: 'No failures',
            detail: 'This function has no functional failures. Generation produced nothing usable, or has not run.',
        });
        // Everything below compares against failures that do not exist.
        return findings;
    }

    if (params.length === 0) {
        findings.push({
            rowId: row.id,
            severity: 'info',
            label: 'Unquantified',
            detail: 'The standard holds no measurable requirement, so only total loss can be derived. Add values to Specs to enumerate against.',
        });
    }

    // Hoisted: loop-invariant. "on_demand" does not count as covering a parameter --
    // it stands in for total loss of a hidden function, so a protective duty whose only
    // failure is "the trip did not fire" still has nothing said about the requirement.
    const directional = Array.from(covered).filter(k => !k.endsWith('|on_demand'));

    for (const p of params) {
        const conflict = findUnitConflict(`${p.value} ${p.unit ?? ''}`) ?? findUnitConflict(row.standard);
        if (conflict) {
            findings.push({
                rowId: row.id,
                severity: 'conflict',
                label: 'Unit conflict',
                detail: `"${p.name}": ${conflict}`,
            });
        }
        // Only when the units agree, so "198.2 deg F (59 deg C)" is reported once as
        // a unit conflict rather than twice.
        const valueConflict = conflict ? null : findValueConflict(p.value, p.unit);
        if (valueConflict) {
            findings.push({
                rowId: row.id,
                severity: 'conflict',
                label: 'Disputed value',
                detail: `"${p.name}" ${valueConflict}`,
            });
        }
        const missing = credibleDirections(p).filter(d => !covered.has(`${p.name}|${d}`));
        // Only report a parameter with NO coverage at all. Reporting each missing
        // direction turns the panel into the same six-per-function checklist the
        // derivation step exists to avoid.
        // A protective function correctly has exactly one failed state: inability to
        // protect (JA1011 5.1.5), carried as "on_demand". Its trip setpoint therefore
        // has no directional failure and must not be reported as an uncovered
        // requirement -- doing so is what pushed the excursion back in as a second row.
        if (row.functionClass === 'protection' && states.has('on_demand')) continue;
        if (missing.length && !directional.some(k => k.startsWith(`${p.name}|`))) {
            findings.push({
                rowId: row.id,
                severity: 'gap',
                label: 'Uncovered requirement',
                detail: `"${p.name}" (${p.value}${p.unit ? ' ' + p.unit : ''}) has no functional failure. Credible omission, or a gap?`,
            });
        }
    }

    if (row.evidence === 'hidden' && !states.has('on_demand')) {
        findings.push({
            rowId: row.id,
            severity: 'gap',
            label: 'Hidden, no on-demand failure',
            detail: 'A hidden function needs a failure discovered on demand; it drives the failure-finding task.',
        });
    }

    if (row.evidence !== 'hidden' && states.has('on_demand')) {
        findings.push({
            rowId: row.id,
            severity: 'conflict',
            label: 'On-demand on an evident function',
            detail: 'An on-demand failure belongs to a function whose failure is not evident in normal operation. Check the evidence classification.',
        });
    }

    if (states.has('total') && states.has('on_demand')) {
        findings.push({
            rowId: row.id,
            severity: 'conflict',
            label: 'Total and on-demand both present',
            detail: 'On demand IS the total loss of a hidden function. One of these two is a duplicate.',
        });
    }

    const placeholders = failures.filter(f => f.needsReview).length;
    if (placeholders) {
        findings.push({
            rowId: row.id,
            severity: 'conflict',
            label: 'Placeholder text',
            detail: `${placeholders} failure${placeholders > 1 ? 's are' : ' is'} template text saved before generation was fixed, not analysis. Regenerate.`,
        });
    }

    return findings;
}

/**
 * Run every row in a breakdown against the subsystem's failures.
 *
 * `matches` is the output of the "Match Failures to Breakdown" step. It is
 * consulted because `sourceBreakdownRowId` is only set when the failure was
 * generated alongside the row: re-decomposing mints fresh row ids and orphans
 * every existing failure, and a failure written by hand never had one. Falling
 * back to the match result keeps the checker working in both cases instead of
 * silently reporting nothing — which is the one failure mode a safety net must
 * not have.
 */
export function checkBreakdown(
    rows: BreakdownRow[],
    failures: Failure[],
    matches?: Array<{ rowId: string; failureIds: string[] }> | null,
): CoverageFinding[] {
    const byId = new Map(failures.map(f => [f.id, f]));
    return rows.flatMap(row => {
        const direct = failures.filter(f => f.sourceBreakdownRowId === row.id);
        if (direct.length) return checkRow(row, direct);
        const matched = (matches ?? []).find(m => m.rowId === row.id);
        const viaMatch = (matched?.failureIds ?? []).map(id => byId.get(id)).filter(Boolean) as Failure[];
        return checkRow(row, viaMatch);
    });
}


/**
 * Leading magnitude of a parameter value, for comparing two statements of the
 * same quantity. Returns null when the value is qualitative.
 */
function magnitudeOf(value: string): number | null {
    const m = String(value).match(/-?\d+(?:\.\d+)?/);
    if (!m) return null;
    const n = Number(m[0]);
    return Number.isFinite(n) ? n : null;
}

/** Parameter names normalise loosely so "cut in pressure" and "cut-in pressure" meet. */
function paramKey(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Cross-subsystem consistency.
 *
 * One project's subsystems are analysed independently, so nothing noticed when
 * two of them stated different values for the same quantity. In a real run the
 * compressor's breakdown said the unit loads at 8.5 barg while the wet air
 * receiver said it loads at 8.0 barg. Both values were in the source documents,
 * which contradicted each other; each subsystem quietly picked a side, and the
 * finished FMECA contained two different setpoints for one control action.
 *
 * A conflict is reported against every row that carries the parameter, so it
 * appears in the breakdown modal beside the requirement it disputes. Like
 * everything else in this file it reports and never writes: which value is
 * right is a document-control question, not one a checker can settle.
 */
export function checkProject(project: Project): CoverageFinding[] {
    type Sighting = { subsystem: string; rowId: string; value: string; unit?: string | null; magnitude: number };
    const byParam = new Map<string, Sighting[]>();

    for (const sub of project.subsystems as Subsystem[]) {
        for (const row of sub.functionBreakdown ?? []) {
            for (const p of row.standardParameters ?? []) {
                const magnitude = magnitudeOf(p.value);
                if (magnitude === null) continue;
                const key = paramKey(p.name);
                if (!key) continue;
                if (!byParam.has(key)) byParam.set(key, []);
                byParam.get(key)!.push({ subsystem: sub.name, rowId: row.id, value: p.value, unit: p.unit, magnitude });
            }
        }
    }

    const findings: CoverageFinding[] = [];
    for (const [key, sightings] of byParam) {
        if (sightings.length < 2) continue;
        // Only compare sightings sharing a unit: 9 barg and 130 psig are the same
        // pressure, and flagging them would bury the real disagreements.
        const byUnit = new Map<string, Sighting[]>();
        for (const sight of sightings) {
            const u = (sight.unit ?? '').toLowerCase().trim();
            if (!byUnit.has(u)) byUnit.set(u, []);
            byUnit.get(u)!.push(sight);
        }
        for (const group of byUnit.values()) {
            const subsystems = new Set(group.map(g => g.subsystem));
            if (subsystems.size < 2) continue;
            const magnitudes = new Set(group.map(g => g.magnitude));
            if (magnitudes.size < 2) continue;
            const shown = group
                .map(g => `${g.subsystem}: ${g.value}${g.unit ? ' ' + g.unit : ''}`)
                .join('; ');
            for (const sight of group) {
                findings.push({
                    rowId: sight.rowId,
                    severity: 'conflict',
                    label: 'Cross-subsystem conflict',
                    detail: `"${key}" is stated differently elsewhere in this project — ${shown}. One requirement, two values.`,
                });
            }
        }
    }
    return findings;
}

/** Findings grouped by rowId, for rendering beside each row. */
export function findingsByRow(findings: CoverageFinding[]): Map<string, CoverageFinding[]> {
    const map = new Map<string, CoverageFinding[]>();
    for (const f of findings) {
        if (!map.has(f.rowId)) map.set(f.rowId, []);
        map.get(f.rowId)!.push(f);
    }
    return map;
}
