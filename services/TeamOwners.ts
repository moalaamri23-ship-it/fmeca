/**
 * Maintenance team ownership for failure-mode actions.
 *
 * The plant's teams, as the engineer defined them. A PM checklist may hint who
 * does a task, but its section headings ("Motor mechanical maintenance tasks")
 * are never team names: every owner is written as one of these.
 *
 * Current controls carry no owner. A control states that a barrier exists (a
 * trip, an alarm, a PM already in the program); it is not a task to assign.
 * Only mitigations -- recommended actions -- get a team.
 */
export const TEAMS = ['Mechanical', 'Electrical', 'Instrument', 'Automation', 'PRV', 'MI', 'Operations'] as const;
export type Team = typeof TEAMS[number];

export const TEAM_OWNER_RULES = `Owner teams -- write the owner of each mitigation as one of exactly these, in parentheses at the end of the line: (Mechanical team), (Electrical team), (Instrument team), (Automation team), (PRV team), (MI team), (Operations team).
- Mechanical team: mechanical equipment -- compressor and pump blocks, couplings, alignment, bearings and their greasing (electric motor bearings included), seals, filters, non-relief valves, vessels, coolers, drains, oil and lubricant changes, mechanical inspection.
- Electrical team: electric motors (windings, insulation resistance, terminals, earthing, starters, running current; not bearing greasing), power supply, transformers, switchgear, MCC feeders, cables.
- Instrument team: instruments, transmitters, sensors, analyzers, gauges and their wiring -- calibration, loop checks, verification of readings.
- Automation team: PLCs, logic controllers, control panels, HMIs, control logic, sequences, setpoints and interlock logic.
- PRV team: pressure relief and safety valves -- testing, recertification, overhaul.
- MI team (material integrity): inspection of static equipment -- vessels, receivers, columns, separators, piping, exchanger shells, supports -- for corrosion, cracks, pitting, wall thinning and other material degradation (visual integrity inspection, thickness measurement, NDT). Repairing what MI finds is still Mechanical.
- Operations team: operator rounds, routine checks and front-line tasks (visual checks, draining, top-ups, cleaning, resetting after a trip), and watching, logging or trending a reading. The Instrument team maintains and calibrates the instrument; it does not watch its reading.
A PM checklist may show which team performs a task; still write the team name from this list, never the checklist's section heading.
Current controls get NO owner: a control states that a barrier exists, it is not a task.`;

/** The team a free-text owner names, or null when it names none of them. */
export function canonicalTeam(raw: string): Team | null {
    const s = raw.toLowerCase();
    if (/\b(prv|psv)\b|relief|safety valve/.test(s)) return 'PRV';
    if (/\bmi\b|material integrity|integrity|inspection team|\bndt\b/.test(s)) return 'MI';
    if (/operat|front.?line/.test(s)) return 'Operations';
    if (/automation|\bplc\b|\bdcs\b|scada|control system/.test(s)) return 'Automation';
    if (/instrument/.test(s)) return 'Instrument';
    if (/electric/.test(s)) return 'Electrical';
    if (/mechanic|lubric|rotating/.test(s)) return 'Mechanical';
    return null;
}

// The owner sits in the last parenthesis of the line, after any [Tag: ...].
const TRAILING_OWNER = /\s*\(([^()[\]]*)\)\s*\.?\s*$/;

/**
 * Rules the engineer stated that hold whatever the model wrote: greasing a
 * bearing is mechanical even on a motor, and a relief valve's test belongs to
 * the PRV team.
 */
function forcedTeam(action: string): Team | null {
    if (/greas/i.test(action) && /bearing/i.test(action)) return 'Mechanical';
    // Inspecting static equipment for material degradation is the MI team's,
    // whoever the model named. A rotating part's crack (a coupling, a shaft) is
    // not static equipment and stays with its owner.
    const STATIC = /\b(vessel|receiver|tank|column|tower|shell|piping|pipe|pipework|nozzle|drum|separator vessel|exchanger|support|structure|base ?frame|weld)/i;
    const INTEGRITY = /\b(corros|crack|pitting|thickness|wall (loss|thinning)|ndt|ultrason|\but\b|radiograph|dye penetrant|magnetic particle|integrity|external inspection|internal inspection)/i;
    if (STATIC.test(action) && INTEGRITY.test(action) && !/\b(repair|replace|weld repair)\b/i.test(action)) return 'MI';
    // Watching a reading is a round, not instrument maintenance.
    if (/^(monitor|trend|log|record|observe|watch)\b/i.test(action.trim()) && !/\b(calibrat|loop|replace|repair|install)/i.test(action)) return 'Operations';
    // A motor's electrical side is the Electrical team's, whatever heading the
    // checklist filed it under.
    if (/\bmotor/i.test(action) && /\b(winding|insulation|megg|terminal|earth|cable gland|running current|starter|feeder|overload)/i.test(action)) return 'Electrical';
    if (/(relief|safety) valve|\b(psv|prv)\b/i.test(action) && /\b(test|recertif|overhaul|calibrat|pop|bench|set pressure)/i.test(action)) return 'PRV';
    return null;
}

function splitLine(line: string): { prefix: string; body: string } {
    const m = line.match(/^(\d+\s*[-–.)]\s*)(.*)$/);
    return m ? { prefix: m[1], body: m[2] } : { prefix: '', body: line };
}

/** Each mitigation line's owner written as one of the plant's teams. */
export function normalizeMitigationOwners(text: string): string {
    if (!text) return text;
    return text.split('\n').map(line => {
        const { prefix, body } = splitLine(line);
        if (!body.trim()) return line;
        const owner = body.match(TRAILING_OWNER);
        const named = owner ? canonicalTeam(owner[1]) : null;
        const action = owner && named ? body.slice(0, owner.index).trimEnd() : body.trimEnd();
        const team = forcedTeam(action) || named;
        return team ? `${prefix}${action} (${team} team)` : line;
    }).join('\n');
}

/** Control lines with any owner removed: a control is not a task. */
export function stripControlOwners(text: string): string {
    if (!text) return text;
    return text.split('\n').map(line => {
        const { prefix, body } = splitLine(line);
        const owner = body.match(TRAILING_OWNER);
        if (!owner) return line;
        // A checklist heading in that position is an owner too; a limit or
        // reading never sits outside the [Tag: ...] bracket.
        const isOwner = /\b(team|tasks?|maintenance|owner)\b/i.test(owner[1]) || !!canonicalTeam(owner[1]);
        return isOwner ? `${prefix}${body.slice(0, owner.index).trimEnd()}` : line;
    }).join('\n');
}
