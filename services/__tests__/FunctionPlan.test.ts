import { describe, it, expect } from 'vitest';
import { parseSystemFunctionPlan, buildAllocationBlock, findSubsystemPlan, buildBreakdownRows, RawBreakdownRow, matchAllocatedDuty, keepAllocatedRows, allocationFor } from '../AIService';
import { vi } from 'vitest';

const names = ['Machine A', 'Vessel B', 'Control Panel C'];

const raw = {
    systemDuties: [
        { duty: 'hold header pressure at setpoint', owner: 'control panel c' },
        { duty: 'deliver the service', owner: 'Machine A' },
        { duty: 'unowned duty', owner: 'Not A Subsystem' },
    ],
    subsystems: [
        {
            name: 'machine a',
            includes: ['casing', ''],
            excludes: ['panel'],
            changes: ['pressure'],
            receives: [],
            duties: [
                { function: 'raise stream pressure', functionClass: 'primary', evidence: 'evident', standardSource: '9 barg' },
                { function: 'relieve overpressure', functionClass: 'PROTECTION', evidence: 'hidden', standardSource: '' },
                { function: '', functionClass: 'primary' },
                { function: 'odd class', functionClass: 'nonsense', evidence: 'maybe' },
            ],
            specs: 'Pressure: 9 barg',
        },
        { name: 'Vessel B', receives: [{ property: 'stream pressure', owner: 'MACHINE A' }], duties: [{ function: 'contain stream', functionClass: 'containment', evidence: 'evident' }] },
        { name: 'Invented Subsystem', duties: [{ function: 'x', functionClass: 'primary' }] },
        { name: 'Machine A', duties: [{ function: 'duplicate entry', functionClass: 'primary' }] },
    ],
};

describe('parseSystemFunctionPlan', () => {
    const plan = parseSystemFunctionPlan(raw, names)!;

    it('keeps only subsystems MasterGen created, under their exact names, once each', () => {
        expect(plan.subsystems.map(s => s.name)).toEqual(['Machine A', 'Vessel B']);
        expect(plan.subsystems[0].duties.map(d => d.function)).not.toContain('duplicate entry');
    });

    it('normalises duty class and evidence, and drops empty duties', () => {
        const duties = plan.subsystems[0].duties;
        expect(duties.map(d => d.function)).toEqual(['raise stream pressure', 'relieve overpressure', 'odd class']);
        expect(duties[1]).toMatchObject({ functionClass: 'protection', evidence: 'hidden' });
        expect(duties[2]).toMatchObject({ functionClass: 'primary', evidence: 'evident' });
        expect(plan.subsystems[0].includes).toEqual(['casing']);
    });

    it('resolves owners to exact names and drops system duties with no real owner', () => {
        expect(plan.systemDuties).toEqual([
            { duty: 'hold header pressure at setpoint', owner: 'Control Panel C' },
            { duty: 'deliver the service', owner: 'Machine A' },
        ]);
        expect(plan.subsystems[1].receives).toEqual([{ property: 'stream pressure', owner: 'Machine A' }]);
    });

    it('returns null when nothing usable came back', () => {
        expect(parseSystemFunctionPlan(null, names)).toBeNull();
        expect(parseSystemFunctionPlan({ subsystems: [{ name: 'Elsewhere' }] }, names)).toBeNull();
    });
});

describe('buildAllocationBlock', () => {
    const plan = parseSystemFunctionPlan(raw, names)!;

    it('states owned duties, received properties and duties owned elsewhere', () => {
        const block = buildAllocationBlock(plan, 'Vessel B');
        expect(block).toContain('contain stream [containment, evident]');
        expect(block).toContain('stream pressure (owned by Machine A)');
        expect(block).toContain('hold header pressure at setpoint (owned by Control Panel C)');
        expect(block).toContain('deliver the service (owned by Machine A)');
    });

    it('does not list a subsystem\'s own system duties as owned elsewhere', () => {
        const block = buildAllocationBlock(plan, 'Machine A');
        expect(block).not.toContain('deliver the service (owned by Machine A)');
        expect(block).toContain('hold header pressure at setpoint (owned by Control Panel C)');
    });

    it('is empty for a subsystem with no entry, so the caller falls back to sibling names', () => {
        expect(buildAllocationBlock(plan, 'Control Panel C')).toBe('');
        expect(buildAllocationBlock(undefined, 'Machine A')).toBe('');
    });

    it('finds an entry despite punctuation and case differences', () => {
        expect(findSubsystemPlan(plan, 'machine-a')?.name).toBe('Machine A');
    });
});

describe('buildBreakdownRows control-subsystem detection', () => {
    const monitoringRow: RawBreakdownRow = {
        function: 'monitor stream temperature',
        standard: 'temperature transmitter reading',
        snippet: 'monitored by a transmitter',
        functionClass: 'primary',
        quantified: false,
        evidence: 'evident',
        standardParameters: [],
    };

    /**
     * MasterGen passes the whole package description as projectName. Any
     * description that mentions a control panel made every subsystem a control
     * subsystem, which switched the monitoring skip off for all of them.
     */
    it('ignores the project text when deciding whether a subsystem is a control subsystem', () => {
        expect(buildBreakdownRows([monitoringRow], 'Heat Exchanger', 'Package: controlled by a local control panel and PLC')).toHaveLength(0);
        expect(buildBreakdownRows([monitoringRow], 'Control Panel', 'Package')).toHaveLength(1);
    });

    /**
     * Live run: a leak-detection subsystem whose name carried no control keyword
     * lost both of its protective rows to the monitoring and safeguard filters,
     * leaving the subsystem with no functions and no failures at all.
     */
    it('never drops a row the model declared protection, whatever the subsystem is called', () => {
        const detect: RawBreakdownRow = {
            ...monitoringRow,
            function: 'detect leakage into the cooling stream',
            standard: 'conductivity alarm at 50 uS/cm from the analyser',
            functionClass: 'protection',
            evidence: 'hidden',
        };
        expect(buildBreakdownRows([detect], 'Tube Leak Detection', 'Cooler')).toHaveLength(1);
    });
});

describe('allocated row set', () => {
    const duties = ['Convert electrical power to shaft power to drive the compressor', 'Contain lubricating oil within the frame'];

    it('matches a reworded duty and rejects a different one', () => {
        expect(matchAllocatedDuty('converts electrical power into shaft power driving the compressor', duties)).toBe(0);
        expect(matchAllocatedDuty('contains lubricating oil within the frame', duties)).toBe(1);
        expect(matchAllocatedDuty('Drive compressor shaft', duties)).toBe(0);
        expect(matchAllocatedDuty('Maintain drive availability when standby unit is called', duties)).toBe(-1);
        expect(matchAllocatedDuty('', duties)).toBe(-1);
    });

    /**
     * Live run: the plan gave a driver one duty, but its description restated the
     * package's duty/standby arrangement and the breakdown made that a hidden
     * row -- the standby takeover the plan had allocated to another subsystem.
     */
    it('keeps an allocated monitoring duty that the keyword skips would delete', () => {
        const report: RawBreakdownRow = {
            function: 'report incomer measurements to the DCS', standard: 'Modbus link to the plant DCS', snippet: 'reports to the DCS',
            functionClass: 'control', quantified: false, evidence: 'evident', standardParameters: [],
        };
        expect(buildBreakdownRows([report], 'Metering & Communication', 'Board')).toHaveLength(0);
        expect(buildBreakdownRows([report], 'Metering & Communication', 'Board', 'detailed', true)).toHaveLength(1);
    });

    it('drops a row that elaborates no owned duty, and says so', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const out = keepAllocatedRows([
            { row: 'drive', duty: 'Convert electrical power to shaft power to drive the compressor' },
            { row: 'standby', duty: 'Maintain drive availability on standby demand' },
            { row: 'unnamed', duty: '' },
        ], duties, 'Motor');
        expect(out).toEqual(['drive']);
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });

    it('fails open when no row names an owned duty, so an ignored field loses nothing', () => {
        expect(keepAllocatedRows([{ row: 'a', duty: '' }, { row: 'b', duty: 'something else' }], duties, 'Motor')).toEqual(['a', 'b']);
    });

    it('keeps every row when there is no allocation', () => {
        expect(keepAllocatedRows([{ row: 'a', duty: '' }], [], 'Motor')).toEqual(['a']);
    });

    it('allocationFor carries the block and the owned duty names', () => {
        const plan = parseSystemFunctionPlan(raw, names)!;
        const a = allocationFor(plan, 'Machine A')!;
        expect(a.block).toContain('Duties this subsystem owns');
        expect(a.duties).toEqual(['raise stream pressure', 'relieve overpressure', 'odd class']);
        expect(allocationFor(plan, 'Control Panel C')).toBeNull();
    });
});
