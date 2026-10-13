/**
 * Manual live A/B harness for MasterGen's system function plan. NOT part of
 * `npm run test`: it spends real API calls.
 *
 *   npm run test:live -- live-mastergen
 *
 * Reads COPILOT_URL from the environment or from .env.local (gitignored). Writes
 * one project JSON per system and variant, plus summary.json, to OUT_DIR
 * (default: <os tmpdir>/fmeca-live). SYSTEMS=compressor,pumpset limits the run.
 *
 * For each system the subsystem split is made ONCE and shared by both variants,
 * so the comparison isolates the plan:
 *   - "plan":     planSystemFunctions, then each subsystem gets its allocation block
 *   - "baseline": no plan, each subsystem gets only its siblings' names
 * Only steps 1-4 run (structure, plan, function, breakdown, FFs). Modes and RPN
 * do not change the FF count and would double the cost.
 *
 * Systems deliberately span kinds of equipment (CLAUDE.md): a rotating package,
 * an electrical switchboard, a passive heat exchanger, and a duty/standby pump set.
 * Do not commit the flow URL: it carries a SAS signature.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIService, allocationFor, findSubsystemPlan } from '../AIService';
import { duplicateClaims } from '../CoverageCheck';
import type { Project, SystemFunctionPlan } from '../../types';

// CopilotSession keeps its ledger in localStorage; give node one.
if (!(globalThis as any).localStorage) {
    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, String(v)); },
        removeItem: (k: string) => { store.delete(k); },
        clear: () => store.clear(),
    };
}

const envFromFile = (name: string): string | undefined => {
    if (!existsSync('.env.local')) return undefined;
    // The last assignment wins, as in a shell: appending a corrected line works.
    const line = readFileSync('.env.local', 'utf8').split('\n').filter(l => l.trim().startsWith(`${name}=`)).pop();
    return line?.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '');
};
const URL_ = process.env.COPILOT_URL || envFromFile('COPILOT_URL') || '';
const OUT = process.env.OUT_DIR || join(tmpdir(), 'fmeca-live');
const ONLY = (process.env.SYSTEMS || '').split(',').map(s => s.trim()).filter(Boolean);
const CONCURRENCY = Number(process.env.CONCURRENCY || 8);
// plan: function plan + failure shapes. baseline: neither. plan-noshape: the plan,
// with each row's failure shape stripped before the FF step, to isolate S3.
type Variant = 'plan' | 'baseline' | 'plan-noshape';
const VARIANTS = ((process.env.VARIANTS || 'plan,baseline').split(',').map(v => v.trim()).filter(Boolean)) as Variant[];

const SYSTEMS: Array<{ id: string; name: string; desc: string }> = [
    {
        id: 'compressor',
        name: 'Instrument Air Compressor Package in Thulailat',
        desc: `The Instrument Air Compressor (IAC) system is comprised of two main subsystems: the Air Compressor System and the Air Dryer System, which are supported by two receivers. This setup is engineered to deliver instrument-quality air that meets the required pressure and dew point specifications.

System Configuration:
1. Two oil-flooded screw compressors, each with 100% capacity (1 active, 1 standby).
2. Drive Motor for each Compressor
2. Two heatless air dryer units, each with 100% capacity (1 active, 1 standby).
3. One wet air receiver.
4. One dry air receiver.

Operating Philosophy:
The compressor discharge pressure is maintained using an automatic load/unload control system that adjusts to changing demands for instrument air. Typically, one compressor and one dryer operate continuously under normal conditions. During periods of peak demand, both compressors and dryers operate concurrently in a Lead/Lag configuration, ensuring continuous supply and system redundancy.

The Air Dryer System features two parallel adsorption columns containing Molecular Sieve 4A desiccant. The system operates by absorbing moisture from the compressed air during the drying cycle, while the alternate column regenerates. Control and monitoring of the compressors and dryers are facilitated by a common Unit Control Panel (UCP). The UCP allows for local operations and integrates with the existing Process Control System (PCS) and Safety and Gas System (SGS). Activation of the dedicated pushbutton on the UCP sequentially starts one compressor and one dryer.
The compressor control system is designed to ensure safe and efficient operation through defined statuses, which are governed by motor condition, control sequence activities, pressure setpoints, timers (TK-12, TK-13), and active interlocks.`,
    },
    {
        id: 'switchboard',
        name: '415 V Main LV Switchboard for Water Injection Plant',
        desc: `The 415 V, 50 Hz, 3-phase main low-voltage switchboard distributes power to the plant's motor loads and auxiliaries. It is a double-ended board: two 2500 A incomer air circuit breakers fed from two 11/0.433 kV, 2 MVA transformers, with a normally open 2500 A bus-section breaker. Each bus half is rated 2500 A, 50 kA for 1 s.

Operating Philosophy:
Both incomers are normally closed with the bus-section open. On loss of one incomer the automatic transfer scheme opens the failed incomer and closes the bus-section after a 2 s dead time, provided the healthy transformer can carry the whole load; parallel operation of the transformers is prevented by interlocks. Outgoing feeders are moulded-case circuit breakers and motor starter units (DOL up to 55 kW, soft-starters above) for the injection booster pumps, cooling fans and HVAC. Protection relays on each incomer provide overcurrent, earth fault and undervoltage tripping, and an arc-flash detection system trips the incomers within 50 ms. A 110 V DC battery and charger supply the breaker trip and closing circuits for 8 hours on loss of AC. Multifunction meters on incomers report to the plant DCS over Modbus.`,
    },
    {
        id: 'heatexchanger',
        name: 'Crude Oil Cooler E-201 (Shell and Tube)',
        desc: `E-201 is a single-pass shell and tube exchanger (TEMA AES) cooling stabilised crude oil from 85 deg C to 45 deg C before storage, at a design flow of 320 m3/h on the shell side. Cooling water circulates on the tube side at 450 m3/h, 32 deg C supply, 42 deg C return. Shell side design pressure 16 barg / 120 deg C; tube side design pressure 10 barg / 80 deg C. Fouling allowance 0.0004 m2K/W on both sides.

Operating Philosophy:
The crude outlet temperature is controlled at 45 deg C by temperature controller TIC-2011 modulating a three-way valve TV-2011 that bypasses cooling water around the exchanger. High crude outlet temperature (55 deg C) alarms in the DCS. A thermal relief valve PSV-2012 set at 10 barg protects the tube side when it is blocked in with warm crude flowing. Cooling water outlet conductivity analyser AT-2013 detects tube leaks of crude into the cooling water and alarms at 50 uS/cm. Inlet and outlet isolation valves allow the exchanger to be bypassed for cleaning; there is no installed spare.`,
    },
    {
        id: 'pumpset',
        name: 'Produced Water Transfer Pumps P-301A/B',
        desc: `Two 100% horizontal centrifugal pumps P-301A/B transfer produced water from the degassing tank to the injection header, each rated 180 m3/h at 65 m differential head, driven by a 75 kW, 415 V, 1480 rpm induction motor. Suction strainers protect each pump; a discharge check valve on each pump prevents reverse flow, and a minimum-flow recirculation line with control valve FV-3013 keeps each pump above 45 m3/h. Single mechanical seals with API Plan 11 flush.

Operating Philosophy:
One pump runs (duty) and one is on standby. A local control panel (PLC based) starts and stops the duty pump on degassing tank level (start 70 %, stop 30 %), and automatically starts the standby pump on duty pump trip or on low discharge pressure (PSL-3011 at 4 barg). Duty and standby are swapped weekly to equalise running hours. Pumps trip on low-low tank level (LSLL-3010, 10 %) to protect against dry running, and on high motor winding temperature. The panel reports status and alarms to the plant DCS.`,
    },
];

const runPool = async <T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> => {
    const results: R[] = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const idx = next++;
            results[idx] = await worker(items[idx]);
        }
    }));
    return results;
};

const sid = (tag: string) => `live-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/** Steps 2-4 of MasterGen's worker, with the same arguments App.tsx passes. */
const generateSubsystem = async (sys: { name: string; desc: string }, s: any, all: any[], plan: SystemFunctionPlan | null, shapes = true) => {
    const projectContext = `${sys.name}: ${sys.desc}`;
    const session = sid('sub');
    const siblings = all.filter(o => o !== s).map(o => String(o.name || '').trim()).filter(Boolean);
    const allocation = allocationFor(plan, s.name);
    const allocationBlock = allocation?.block || '';
    const func = (await AIService.generate('Function', '', '', '', 'ai', '', {
        project: sys.name, projectDescription: sys.desc, subsystem: s.name, specs: s.specs, siblingSubsystems: siblings, allocationBlock,
    }, 'copilot', '', '', URL_, session) || '').trim();
    const rows = func
        ? (await AIService.decomposeFunction(func, s.name, projectContext, '', '', 'copilot', '', URL_, '', 'detailed', s.specs || '', session, siblings, allocation))
            .map((r, i) => ({ ...r, id: `${s.name}#${i}`, failureShape: shapes ? r.failureShape : undefined }))
        : [];
    const ff = rows.length
        ? await AIService.generateFFsForBreakdownRows({
            systemName: projectContext, subsystemName: s.name, subsystemSpecs: s.specs || '', funcDesc: func, rows,
            existingFailures: [], key: '', modelName: '', aiProvider: 'copilot', powerAutomateUrl: URL_,
            systemContext: '', sessionId: session, siblingSubsystems: siblings, allocationBlock,
        })
        : { failures: [], rejected: [] };
    return {
        id: s.name, name: s.name, specs: s.specs || '', func,
        imageData: '', imageName: '', imageJson: '', showImageJson: false,
        allocated: Boolean(allocationBlock),
        functionBreakdown: rows,
        rejected: ff.rejected.length,
        failures: ff.failures.map((f, i) => ({
            id: `${s.name}!${i}`, desc: f.desc, modes: [], sourceBreakdownRowId: f.rowId,
            failedState: f.failedState, parameter: f.parameter,
        })),
    };
};

const metrics = (project: Project & { functionPlan?: SystemFunctionPlan | null }) => {
    const subs = project.subsystems as any[];
    const ffs = subs.flatMap(s => s.failures);
    const rows = subs.flatMap(s => s.functionBreakdown || []);
    const byState: Record<string, number> = {};
    ffs.forEach(f => { const k = f.failedState || 'untagged'; byState[k] = (byState[k] || 0) + 1; });
    return {
        subsystems: subs.length,
        allocated: subs.filter(s => s.allocated).length,
        rows: rows.length,
        ffs: ffs.length,
        perSubsystem: Object.fromEntries(subs.map(s => [s.name, `${(s.functionBreakdown || []).length} rows / ${s.failures.length} FFs`])),
        byState,
        protectionRows: rows.filter((r: any) => r.functionClass === 'protection').length,
        hiddenRows: rows.filter((r: any) => r.evidence === 'hidden').length,
        duplicateClaims: duplicateClaims(project).length,
        duplicateDetail: duplicateClaims(project).map(c => `${c.value}: ${c.sightings.map(s => s.subsystem).join(' | ')}`),
        rejected: subs.reduce((n, s) => n + (s.rejected || 0), 0),
    };
};

describe.skipIf(!URL_)('live MasterGen A/B: function plan vs sibling names', () => {
    it('runs every system with and without the plan', { timeout: 3_600_000 }, async () => {
        mkdirSync(OUT, { recursive: true });
        const systems = SYSTEMS.filter(s => !ONLY.length || ONLY.includes(s.id));
        const summary: Record<string, any> = {};

        // Step 1 and the plan per system, in parallel across systems.
        const prepared = await Promise.all(systems.map(async sys => {
            const rawSubs = await AIService.generateMasterStructure(sys.name, sys.desc, '', '', 'ai', '', 'copilot', '', '', URL_, sid('structure'));
            if (!Array.isArray(rawSubs) || !rawSubs.length) throw new Error(`${sys.id}: no subsystems`);
            const plan = await AIService.planSystemFunctions({
                sysName: sys.name, sysDesc: sys.desc, subsystems: rawSubs.map((o: any) => ({ name: o.name, specs: o.specs })),
                key: '', modelName: '', mode: 'ai', refText: '', aiProvider: 'copilot', powerAutomateUrl: URL_, sessionId: sid('plan'),
            });
            const planned = rawSubs.map((o: any) => {
                const specs = findSubsystemPlan(plan, o.name)?.specs;
                return specs ? { ...o, specs } : o;
            });
            console.log(`[${sys.id}] ${rawSubs.length} subsystems; plan ${plan ? 'ok' : 'FAILED'}`);
            return { sys, rawSubs, planned, plan };
        }));

        // Both variants of every system share one pool, so the provider sees a
        // steady load instead of bursts.
        type Job = { sysId: string; variant: Variant; sub: any; all: any[]; plan: SystemFunctionPlan | null; sys: any };
        const jobs: Job[] = prepared.flatMap(p => VARIANTS.flatMap((variant): Job[] => variant === 'baseline'
            ? p.rawSubs.map((sub: any) => ({ sysId: p.sys.id, variant, sub, all: p.rawSubs, plan: null, sys: p.sys }))
            : p.planned.map((sub: any) => ({ sysId: p.sys.id, variant, sub, all: p.planned, plan: p.plan, sys: p.sys }))));
        const results = await runPool(jobs, CONCURRENCY, async job => {
            try {
                const out = await generateSubsystem(job.sys, job.sub, job.all, job.plan, job.variant !== 'plan-noshape');
                console.log(`[${job.sysId}/${job.variant}] ${job.sub.name}: ${out.functionBreakdown.length} rows, ${out.failures.length} FFs`);
                return { job, out, error: undefined as string | undefined };
            } catch (e: any) {
                // Recorded in summary.json too: vitest swallows console output of a
                // passing test, and a silently missing subsystem skews the comparison.
                const error = `${job.sub.name}: ${e?.message || e}`;
                console.warn(`[${job.sysId}/${job.variant}] ${error}`);
                return { job, out: null, error };
            }
        });

        for (const p of prepared) {
            for (const variant of VARIANTS) {
                const subsystems = results.filter(r => r.job.sysId === p.sys.id && r.job.variant === variant && r.out).map(r => r.out!);
                const project = {
                    id: `${p.sys.id}-${variant}`, name: p.sys.name, desc: p.sys.desc, created: '', updated: '',
                    subsystems, functionPlan: variant === 'baseline' ? undefined : p.plan ?? undefined,
                } as any;
                writeFileSync(`${OUT}/${p.sys.id}-${variant}.json`, JSON.stringify(project, null, 2));
                summary[`${p.sys.id}/${variant}`] = {
                    ...metrics(project),
                    errors: results.filter(r => r.job.sysId === p.sys.id && r.job.variant === variant && r.error).map(r => r.error),
                };
            }
        }
        writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2));
        console.log(JSON.stringify(summary, null, 2));
        expect(Object.keys(summary).length).toBeGreaterThan(0);
    });
});
