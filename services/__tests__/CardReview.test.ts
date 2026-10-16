import { describe, it, expect } from 'vitest';
import { reviewKnowledge, applyReview, isDecided } from '../CardReview';
import { subsystemsFromKnowledge } from '../KnowledgeCards';

const FILE = `SECTION 3/1 - SUBSYSTEM: Pump
Items: Impeller | P-1 | NOT STATED | 1 | develops head [S1 p.1]
Items: Seal flush cooler | E-1 | NOT STATED | 1 | cools seal flush water [S1 p.2]
Items: Pressure transmitter | PT-1 | NOT STATED | 1 | measures discharge pressure [S1 p.3]
Items: Drain valve | V-9 | NOT STATED | 1 | isolates casing for maintenance [S1 p.3]
Delivers: water at 50 m3/h to Header
Functions:
- primary: develop head to deliver 50 m3/h [S1 p.1]
- protection: stop when the Panel removes the run permissive [S1 p.4]

SECTION 3/2 - SUBSYSTEM: Panel
Items: PLC | UCP | NOT STATED | 1 | decides pump starts [S1 p.5]
Functions:
- control: decide pump start and stop from header pressure [S1 p.5]
`;

describe('card review', () => {
    it('flags uncovered duties but not measurements, maintenance isolation or covered duties', () => {
        const flags = reviewKnowledge(FILE);
        const uncovered = flags.filter(f => f.kind === 'uncovered').map(f => (f as any).item);
        expect(uncovered).toEqual(['Seal flush cooler']);
    });

    it('flags a protective line that names another subsystem as acting', () => {
        const foreign = reviewKnowledge(FILE).filter(f => f.kind === 'foreign');
        expect(foreign).toHaveLength(1);
        expect((foreign[0] as any).owner).toBe('Panel');
    });

    it('applies decisions to the text that MasterGen then reads', () => {
        const flags = reviewKnowledge(FILE);
        const decisions = Object.fromEntries(flags.map(f => [f.id, f.kind === 'uncovered' ? { action: 'add' as const, cls: 'containment' as const } : { action: 'move' as const }]));
        expect(flags.every(f => isDecided(f, decisions))).toBe(true);
        const [pump, panel] = subsystemsFromKnowledge(applyReview(FILE, flags, decisions));
        expect(pump.rows.map(r => r.functionClass)).toEqual(['primary', 'containment']);
        expect(pump.func).toContain('Cools seal flush water.');
        expect(pump.func).not.toContain('engineer review');
        expect(panel.rows.map(r => r.functionClass)).toEqual(['control', 'protection']);
    });

    it('leaves the text unchanged for ignore and keep', () => {
        const flags = reviewKnowledge(FILE);
        const decisions = Object.fromEntries(flags.map(f => [f.id, f.kind === 'uncovered' ? { action: 'ignore' as const } : { action: 'keep' as const }]));
        expect(applyReview(FILE, flags, decisions)).toBe(FILE);
    });
});
