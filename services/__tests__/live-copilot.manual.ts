/**
 * Manual live-generation harness. NOT part of `npm run test` -- the ".manual.ts"
 * suffix keeps it out of vitest's default glob, because it costs real API calls
 * and needs two environment variables.
 *
 * This is the only thing that can catch a prompt regression. The unit tests cover
 * the deterministic half (cleaners, bucketing, coverage checks) and are blind to
 * whether the rules still produce a sane analysis. Run this after any edit to
 * FUNCTION_BREAKDOWN_TECHNICAL_RULES or JA1011_FAILED_STATE_RULES:
 *
 *   OUT_DIR=/tmp/fmeca-live COPILOT_URL='<power automate flow url>' \
 *     npx vitest run services/__tests__/live-copilot.manual.ts \
 *     --testTimeout=900000 --include '**\/*.manual.ts'
 *
 * Writes rows.json and failures.json to OUT_DIR. Expected for this subsystem:
 * 6 function rows, 12-14 functional failures, zero rejects, no row derived from a
 * design rating, exactly one failure on each protective function.
 *
 * Do not commit the flow URL: it carries a SAS signature.
 */
import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { AIService, buildBreakdownRows } from '../AIService';

const URL_ = process.env.COPILOT_URL!;
const SUB = 'Air Compressor System (66-K-127451/66-K-127452)';
const SPECS = 'Configuration: 2 x 100% (1 duty, 1 standby), Type: oil-flooded screw compressor, Flow at compressor BL: 599 Sm3/hr, Pressure at compressor BL: 9.0 barg, Temperature at compressor BL: 60 deg C, Normal discharge pressure: 130 psig (9 barg), Design pressure: 174 psig (12 barg), Shaft power: 80 kW, Cut out pressure: 9.0 barg, Cut in pressure: 8.5 barg, Rotors casing design pressure: 13.8 barg, Rotors casing design temperature: 150 deg C, Package PSV set point: 12.0 barg, Max discharge temperature: 198.2 deg F (59 deg C), Noise at 1 m: 85 dB(A), Compressor outlet temperature 66-TT-127404/127406: H alarm 115 deg C, HH trip 120 deg C, local reset 66-HS-127507';
const FUNC = 'The Air Compressor System compresses filtered intake air to deliver instrument-quality air at the required capacity of 599 Sm3/hr and a normal discharge pressure of 130 psig (9 barg) at the compressor battery limit. It maintains discharge pressure through automatic load/unload control, unloading at the 9.0 barg cut-out pressure and loading at the 8.5 barg cut-in pressure in response to instrument air demand. Operation is held within the specified envelope, including the 174 psig (12 barg) design pressure, 13.8 barg rotor casing design pressure, 150 deg C rotor casing design temperature, and 198.2 deg F (59 deg C) maximum discharge temperature, while containing compressed air and lubricating oil within the pressurized boundary. Operating in a 2 x 100% duty and standby arrangement, it maintains instrument air supply when the duty unit is unavailable and shares load in lead/lag configuration during peak demand.';
const CONTEXT = `Operating context and source notes:
CONFLICT: S2 compressor normal operating pressure 130 psig (9 barg) and design pressure 174 psig (12 barg); S3 compressor rotors/aftercooler design pressure 13.8 barg and package PSV set point 12.0 barg.
CONFLICT: S3 datasheet states compressor package cut in pressure 8.5 barg; S2 control philosophy states load at SP-03 = 8.0 barg.
Protection setpoints: compressor outlet temperature 66-TT-127404/127406 H = 115 deg C, HH trip = 120 deg C, local reset 66-HS-127507 required after trip. Oil separator pressure 66-PT-127375/127379 H = 10 barg, HH trip = 10.5 barg.
Load/unload: wet air receiver 66-PT-127381 unload SP-14 = 9.0 barg, load SP-15 = 8.0 barg.`;
const SIBLINGS = ['Compressor Drive Motor', 'Air-Oil Cooling and Lubrication System', 'Air Dryer System', 'Dryer Filtration System', 'Wet Air Receiver', 'Dry Air Receiver', 'Control, Instrumentation and Protection System (UCP)'];

describe('live copilot', () => {
    it('generates the compressor breakdown and failures', { timeout: 900000 }, async () => {
        const rows = await AIService.decomposeFunction(
            FUNC, SUB, 'Instrument Air Compressor Package', '', '', 'copilot', '', URL_, CONTEXT, 'detailed', SPECS,
            `live-${Date.now()}`, SIBLINGS
        );
        const withIds = rows.map((r, i) => ({ ...r, id: `row${i}` }));
        writeFileSync(process.env.OUT_DIR + '/rows.json', JSON.stringify(withIds, null, 2));
        expect(withIds.length).toBeGreaterThan(0);

        const ff = await AIService.generateFFsForBreakdownRows({
            systemName: 'Instrument Air Compressor Package', subsystemName: SUB, subsystemSpecs: SPECS,
            funcDesc: FUNC, rows: withIds, existingFailures: [], key: '', modelName: '',
            aiProvider: 'copilot', powerAutomateUrl: URL_, systemContext: CONTEXT,
            sessionId: `live-${Date.now()}-ff`, siblingSubsystems: SIBLINGS,
        });
        writeFileSync(process.env.OUT_DIR + '/failures.json', JSON.stringify(ff, null, 2));
    });
});

// ---------------------------------------------------------------------------
// Generality case. The rules under test were once tuned against a single screw
// compressor and inflated everything else, so the suite deliberately includes a
// subsystem with no rotating equipment, no process fluid it delivers, and a duty
// that is mostly control and protection.
// ---------------------------------------------------------------------------
const UCP_SUB = 'Control, Instrumentation and Protection System (UCP)';
const UCP_SPECS = 'Unit Control Panel common to both compressors and both dryers. Load/unload sequencing on wet air receiver 66-PT-127381 (unload SP-14 9.0 barg, load SP-15 8.0 barg) and dry air receiver 66-PT-127492 (unload lead SP-12 8.0 barg, unload lag SP-17 7.8 barg, load lead SP-13 7.0 barg, load lag SP-16 6.0 barg). Protective trips: compressor outlet temperature HH 120 deg C, oil separator pressure HH 10.5 barg, local reset 66-HS-127507 required after trip. ESD from Client Master PLC trip signal 66-XS-127520. Emergency stop button causes immediate machine stop. LCP components ATEX Zone 2 rated. Dryer cycle timer: total 10 min, drying 5 min, regeneration 4 min, pressurizing 1 min.';
const UCP_FUNC = 'The Unit Control Panel controls and monitors instrument air production for the package, sequencing compressor load and unload and sharing duty between the two units in lead/lag configuration using wet and dry air receiver pressure transmitters. It executes the protective shutdown functions on high compressor outlet temperature, high oil separator pressure, emergency stop and ESD signal from the client master PLC, requiring a local reset before restart. It sequences the heatless dryer adsorption cycle through drying, regeneration and pressurizing phases on a 10 minute timer, and its enclosure components are rated for the ATEX Zone 2 hazardous area in which the package is installed.';
const UCP_SIBLINGS = ['Air Compressor System', 'Compressor Drive Motor', 'Air-Oil Cooling and Lubrication System', 'Air Dryer System', 'Wet Air Receiver', 'Dry Air Receiver'];

describe('live copilot — generality', () => {
    it('generates the UCP breakdown and failures', { timeout: 900000 }, async () => {
        const rows = await AIService.decomposeFunction(
            UCP_FUNC, UCP_SUB, 'Instrument Air Compressor Package', '', '', 'copilot', '', URL_, '', 'detailed', UCP_SPECS,
            `live-ucp-${Date.now()}`, UCP_SIBLINGS
        );
        const withIds = rows.map((r, i) => ({ ...r, id: `ucp${i}` }));
        writeFileSync(process.env.OUT_DIR + '/ucp-rows.json', JSON.stringify(withIds, null, 2));
        expect(withIds.length).toBeGreaterThan(0);

        const ff = await AIService.generateFFsForBreakdownRows({
            systemName: 'Instrument Air Compressor Package', subsystemName: UCP_SUB, subsystemSpecs: UCP_SPECS,
            funcDesc: UCP_FUNC, rows: withIds, existingFailures: [], key: '', modelName: '',
            aiProvider: 'copilot', powerAutomateUrl: URL_, systemContext: '',
            sessionId: `live-ucp-${Date.now()}-ff`, siblingSubsystems: UCP_SIBLINGS,
        });
        writeFileSync(process.env.OUT_DIR + '/ucp-failures.json', JSON.stringify(ff, null, 2));
    });
});
