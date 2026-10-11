import { ContextData, FunctionClass, FailedStateType, StandardParameter } from '../types';
import { RICH_LIBRARY } from '../constants';
import { buildCopilotPrompt, parseCopilotReply, getCopilotSessionId } from './copilotHelper';
import {
    carriesSpreadsheet,
    copilotSessionId,
    looksLikeLostSession,
    markAttachmentsSent,
    pendingAttachments,
    rotateCopilotSession,
} from './CopilotSession';
import { runExclusive } from './CopilotQueue';
import { pngAttachmentName, toPngPayload } from './imagePng';
import type { SystemMode } from './SystemModesService';

/*
  -------------------------------------------------------------------------
  LANGCHAIN HOSTING CONFIGURATION
  -------------------------------------------------------------------------
  To switch to a hosted LangChain backend:
  1. Set `AI_CONFIG.baseUrl` to your backend URL (e.g., "https://my-backend.com").
  2. Ensure the backend implements:
     - POST /api/ai        (accepts AIRequestPayload, returns { content: string })
     - POST /api/ai-vision (accepts AIRequestPayload, returns { content: string })

  Behavior:
  - If `baseUrl` is set, the app attempts REMOTE mode first.
  - If REMOTE fails (or `baseUrl` is empty), it silently falls back to DIRECT mode (client-side calls).
  -------------------------------------------------------------------------
*/

const AI_CONFIG = {
    baseUrl: "", // Leave empty for DIRECT mode. Set to URL for REMOTE mode.
    endpoints: {
        chat: '/api/ai',
        vision: '/api/ai-vision'
    }
};

// Infer provider from API key shape. Anthropic keys also start with "sk-",
// so the more specific prefixes must be checked first.
const inferProvider = (key: string): string =>
    key.startsWith('sk-ant-') ? 'anthropic'
    : key.startsWith('sk-or-') ? 'openrouter'
    : key.startsWith('sk-') ? 'openai'
    : 'gemini';

// Shared S/O/D rating anchors injected into every prompt that produces or
// evaluates RPN values, so scores are comparable across calls and models.
const RPN_ANCHORS = `S/O/D RATING ANCHORS (1-10). Score against these bands — do NOT default to 5:
Severity (S) — rate the END EFFECT at system level:
  1-2: Negligible — no downtime, cosmetic only.
  3-4: Minor — local degradation or brief partial output loss, simple repair.
  5-6: Moderate — notable output loss or partial system outage, planned repair needed.
  7-8: Major — full system outage or significant production loss, costly repair.
  9-10: Hazardous — safety/environmental harm or regulatory breach (9 = with warning, 10 = without warning).
Occurrence (O) — likelihood of this CAUSE producing the mode in typical industrial service:
  1-2: Remote — rarely seen over equipment life (> 5 years between events).
  3-4: Low — isolated events (every 2-5 years).
  5-6: Occasional — every 1-2 years.
  7-8: Frequent — several times per year.
  9-10: Persistent — monthly or continuous problem.
Detection (D) — ability of the controls credited in the scored state to detect or prevent before impact:
  1-2: Near-certain — online monitoring with alarm/trip on this mode.
  3-4: High — condition monitoring or frequent inspection catches onset.
  5-6: Moderate — periodic inspection might catch it in time.
  7-8: Low — usually discovered only at functional failure.
  9-10: None — no stated controls, or purely reactive. Use 9-10 when controls are absent or unknown.`;

// Compact few-shot examples drawn from the built-in failure library. Used to
// anchor vocabulary and granularity of generated FFs/modes (ISO 14224 style).
const LIBRARY_EXAMPLES = (() => {
    const lines: string[] = [];
    Object.entries(RICH_LIBRARY).forEach(([cat, items]) =>
        items.slice(0, 3).forEach(i =>
            lines.push(`- ${cat}: FF "${i.fail}" → Mode "${i.mode}" | Cause "${i.cause}" | Task "${i.task}"`)));
    return `VOCABULARY EXAMPLES (granularity/terminology reference only — adapt to the actual equipment, do not copy):\n${lines.join('\n')}`;
})();

const FMECA_HIERARCHY_RULES = `FMECA hierarchy and field separation:
- System -> Subsystem -> Subsystem Function Description -> Functional Failure -> Failure Mode -> Cause / Effect / Current Controls / Mitigation.
- Subsystem Function Description = intended role of the subsystem only.
- Decomposed Function = smaller intended action derived from the subsystem function, when this workflow uses decomposition.
- Functional Failure = inability to meet the required function or performance standard.
- Failure Mode = specific failed state, degraded condition, or physical mechanism that results in the functional failure.
- Cause = why the failure mode occurs.
- Effect = consequence after the failure mode occurs.
- Current Controls / Mitigation = detection, control, prevention, safeguard, or consequence-reduction content using the existing required format.
- Keep all generated content inside the subsystem boundary. Avoid parent-system, upstream, downstream, or component details unless the input clearly includes them.
- Do not move causes, effects, controls, mitigations, inspections, recommendations, or maintenance tasks into the function, functional failure, failure mode, cause, or effect fields.
- Do not invent design values, operating limits, component names, causes, controls, or operating conditions. Use exact specifications only when provided in the Specs, system description, reference data, or checklist knowledge. Otherwise use "required", "specified", or "operating range".
- Source conflicts are data, not choices. When the reference data flags a CONFLICT, or states two different values for the same quantity, treat the quantity as ONE requirement whose value is disputed. Name both values and say they conflict. Never silently pick a side, and never let one disputed quantity become several separate rows or failures -- that multiplies a documentation problem into an analysis that looks thorough and is wrong.`;

const FMECA_CONCISE_WORDING_RULES = `Professional FMECA wording:
- Return concise, direct engineering statements. Prefer 6-14 words for functional failures, 2-7 words for failure modes, and 2-8 words for causes.
- Avoid explanatory clauses, narratives, stacked adjectives, and long comma chains.
- Do not write generic words such as "failed", "problem", "malfunction", "issue", or "not working" unless a specific failed condition is also stated.
- Never include internal reasoning, uncertainty, self-correction, reviewer notes, or conversational text such as "wait", "let me", "I think", "reconsider", "analysis", or "reasoning".
- Do not add labels, prefixes, numbering, bullets, markdown, or commentary unless the output contract requires them.`;

// Specs are extracted from whole-package datasheets loaded as REFERENCE DATA, so
// without an explicit boundary the model dumps every value in the file onto one
// subsystem. Specs feed every downstream FF/mode prompt, so a leak here cascades.
const SPECS_BOUNDARY_RULES = `Subsystem boundary rules:
- Return ONLY specifications of the named subsystem itself.
- Exclude parent-system, package, skid, or train totals and ratings.
- Exclude anything belonging to another subsystem, upstream or downstream equipment, or a separate component listed elsewhere.
- Include a value only when the reference data attributes it to this subsystem. Ambiguous or package-level values are excluded, not guessed.
- There is no pair limit. Length follows from what the source actually holds for this subsystem: a numeric cap only trades a visible over-extraction for a plausible-looking one that hides the same boundary error.
- Completeness requirement: when the source provides them, always include inlet/suction and outlet/discharge conditions, rated capacity and duty, design pressure and temperature ratings, and protection set points. Those are the values the subsystem's own function is defined against.
- If no specification in the available context can be attributed to this subsystem, return an empty response.`;

const buildSiblingSubsystemBlock = (siblings?: string[], noun: string = 'specifications'): string => {
    const names = (siblings || []).map(n => (n || '').trim()).filter(Boolean);
    if (!names.length) return '';
    return `\nOTHER SUBSYSTEMS IN THIS PROJECT (their ${noun} belong to them, not to the subsystem being generated — do not include them):\n${names.map(n => `- ${n}`).join('\n')}\n`;
};

// The Context field carries operating philosophy: redundancy, standby/lead-lag
// duty, and control behaviour. Without it a standby unit reads as a continuous
// one and "fails to start on demand" can never be derived downstream.
const buildSystemDescriptionBlock = (desc?: string): string => {
    const text = (desc || '').trim();
    if (!text) return '';
    return `\nSYSTEM CONTEXT (operating philosophy, configuration, redundancy and duty of the parent system — use it to establish this subsystem's duty and protective role, not to describe other subsystems):\n"""\n${text}\n"""\n`;
};

// The function description is the seed for every functional failure, and
// decomposeFunction mines it for five separate dimensions. A single sentence
// carries the primary duty only, so containment, protection and standby duties
// -- where the high-severity functional failures live -- were unrecoverable
// downstream. The checklist below is a coverage list, not a menu.
const FUNCTION_DESCRIPTION_TECHNICAL_RULES = `Function description rules:
- Describe intended operation only. Cover each dimension below that the available context supports, and stay silent on the ones it does not:
  1. Mission: the value, service, conversion, movement, or storage the subsystem must provide, with its performance standard.
  2. Controlled performance: variables, setpoints, sequences, or demand response it must maintain.
  3. Operating envelope: measurable ranges, design ratings, or limits within which operation must stay acceptable.
  4. Containment: what the subsystem must hold in or keep separated — process fluid, lubricant, pressure, heat.
  5. Protection and duty: protective functions it must perform, and its operating duty (continuous, standby, lead/lag, load/unload, intermittent) when the system context states one. State the duty as a condition on what the subsystem must deliver — "maintains supply when the duty unit fails", "holds discharge pressure by loading and unloading" — never as a bare arrangement. The duty exists here so a later step can tell which functions are hidden and what their performance standard is; an arrangement written as a deliverable becomes a function that only restates itself.
- Write the performance standard as an exact value whenever Specs provides one. If Specs is empty or generic, do not invent numbers; use "required", "specified", or "operating range".
- Absorbed power, design pressure, design temperature, and set points are ratings, limits, or protection thresholds — never deliverables. Do not write them as something the subsystem "delivers" or "provides".
- Do not include model numbers, serial numbers, or equipment identifiers; they are identity, not function.
- Do not include functional failures, failure modes, causes, effects, alarms, trips, inspections, PM tasks, controls, mitigations, recommendations, or maintenance wording. A protective function is what the subsystem must do; a trip setting or inspection task is not.
- Output 2 to 4 plain sentences, no list formatting. Use one sentence per dimension and merge dimensions that read naturally together. Never pad to reach four.`;

// SAE JA1011 5.1 requires every function to be identified, primary and
// secondary alike, with performance standards quantified where practicable.
// The previous seed set (mission / performance_control / operating_envelope /
// equipment_health) had no class for containment or protection and promoted the
// operating envelope -- a performance standard, not a function -- to its own
// row. Containment and protection carry the highest-severity failures in RCM,
// so their absence was the single largest coverage gap in the analysis.
const FUNCTION_BREAKDOWN_TECHNICAL_RULES = `Function breakdown rules (SAE JA1011 5.1):
- Identify every function the subsystem must perform, primary and secondary alike. Classify each into exactly one class:
  - "primary": the reason the subsystem exists — the value, service, conversion, movement, or storage it delivers.
  - "containment": what it must hold in or keep separated — process fluid, lubricant, pressure, heat.
  - "protection": a protective duty it must perform — relieve overpressure, shut down on an excursion, isolate on demand, prevent reverse flow. The duty belongs here; the device that performs it does not become its own row. JA1011 5.1.5: write a protective function as the CAPABILITY, not the bare duty — "be able to shut down on high discharge temperature", not "limit discharge temperature". The capability phrasing is what makes its failed state come out as inability to protect rather than as the excursion itself.
  - "control": setpoints, bands, sequences, demand response, load/unload, start/stop behaviour it must maintain.
  - "support": structural, mounting, or containment-of-position duties.
  - "efficiency": economy or efficiency duties the description explicitly states.
- Each row is one functional verb plus one object. Do not start with "to" or a gerund.
- The operating envelope is NOT a function. Put measurable ranges, ratings, and limits in the row's "standard" field, which is where JA1011 puts a performance standard.
- Equipment condition and integrity expectations are NOT functions. Do not create rows for vibration, wear, corrosion, or overheating — those are failure modes and belong to a later step.
- A design arrangement is NOT a function. "2 x 100%", duty/standby, lead/lag, N+1, parallel trains, and installed spares describe HOW a duty is met, not what the subsystem does. Write the outcome the arrangement exists to deliver as the function — for a duty/standby pair that outcome is maintaining the service when the duty unit fails — and put the arrangement wording in "standard". A function written as an arrangement produces a functional failure that is only the arrangement restated.
- Installed standby and redundancy are PROTECTION, not primary. A standby unit exists to take over when the duty unit fails, which is a protective duty on the duty unit's failure and is hidden by nature: nobody finds out it will not start until it is asked to. Class it "protection", mark it hidden, and phrase it as the capability — "be able to maintain supply when the duty unit is unavailable".
- Duty rotation, wear equalisation, and run-hour balancing are operating strategies, NOT functions. Their failure accelerates wear, which is a cause of other failure modes; it is not a functional failure. Do not create a row for them.
- A duty that limits, caps, relieves, isolates, or trips is "protection", even when the description states it only as a bare maximum. Control holds a variable at a setpoint during normal running; protection stops an excursion. Classify by what the duty does, not by the grammar of the sentence it appears in, and mark a protective duty hidden when it is exercised only once the process reaches it.
- A protective function's performance standard is its TRIP or SET POINT, not a design rating and not a performance-table maximum. Where the context offers both a rating and an instrumented setpoint for the same quantity, the setpoint is the standard: it is the value the protective device actually acts on. Take the trip.
- Include only functions inside the subsystem boundary and supported by the function description, specs, or system context.
- Do not create rows from causes, effects, alarms, inspections, repairs, tests, tags, personnel instructions, or maintenance tasks.
- Cap the row count by function, not by failure. A function that yields several failed states is still one row.

Performance standard parameters:
- Split each row's standard into its separate measurable requirements and return them in "standardParameters". "599 Sm3/hr at 130 psig (9 barg), 60 deg C" holds three requirements, not one.
- Each parameter carries: "name" (what is required — flow, discharge pressure, air quality), "value" (as written), "unit" (or null when qualitative), and "bound".
- "bound" says which way the parameter can be violated: "min" when only falling below it is a failure, "max" when only exceeding it is, "target" or "range" when both are, "spec" for a conformance requirement with no magnitude such as air quality or cleanliness.
- A quality, grade, or cleanliness requirement stated in the function is a parameter in its own right. Do not fold it into a flow or pressure parameter.
- For a containment function, EACH substance the subsystem must hold in is a parameter with bound "spec". Two substances held in the same envelope are two parameters, not one: they escape by different mechanisms and a release of each has different consequences. A containment row carrying no substance cannot produce a leakage failure at all, and leakage is the whole reason the duty exists.
- Design pressure and design temperature ratings belong in the containment row's "standard" TEXT, never in "standardParameters". A rating states what the envelope withstands, not what the function delivers, so exceeding it is a cause of losing containment rather than a failed state of it. Listing ratings as parameters turns one envelope into several near-identical failures that are really the same event described in different units.
- Take values from Specs verbatim. Do not invent a parameter that the standard does not state, and do not drop one that it does.
- "value" holds the magnitude alone and "unit" holds the unit alone. Do not repeat the unit inside "value".
- A rating that measures what the equipment CONSUMES or WITHSTANDS is not a parameter of the service it delivers. It describes the cost or the envelope of doing the duty, not the duty, so a failure derived from it competes with the output the function exists to produce. Put a consumption rating on an "efficiency" function of its own when the description supports one, and otherwise leave it out. Put a withstand rating in the containment row's standard text.
- Order "standardParameters" with the requirements the function exists to deliver first.
- When the standard is qualitative and holds no measurable requirement, return an empty "standardParameters" array rather than inventing values.`;

// JA1011 5.2 requires all failed states of each FUNCTION -- not of each
// parameter, and the difference is the whole design of this block.
//
// Two wrong versions came before. The first listed six failed-state types and
// asked the model to work through them: a template, so every function came back
// with the same spread whatever the equipment could do, and two compressors in
// different services produced identical failures. The second replaced that with
// a mandatory parameter x direction matrix -- every pair had to appear in
// "failures" or in "skipped" with a written justification, plus a self-check
// counting step. That made declining cost more than complying, which is an
// asymmetric pressure toward output: the model stopped judging and started
// filling cells. One live subsystem went from 7 failures to 18, of which five
// were duplicates or hierarchy violations (three "exceeds design rating" rows,
// a protective excursion double-counted against its own trip, and a second
// erratic row on the same duty).
//
// So: the parameters are EVIDENCE of what "required" means, and the direction
// list is the vocabulary for describing a violation. Neither is a checklist.
// The model enumerates candidates and then SELECTS the ones that leave the user
// in a materially different position. Declining is free again.
const JA1011_FAILED_STATE_RULES = `Failed-state derivation (SAE JA1011 5.2):
JA1011 5.2 requires all failed states of each FUNCTION, not of each parameter. A function is failed when it no longer delivers what its users require. The parameters are evidence of what "required" means; they are not a matrix to fill.

Method, applied per row:
1. Read the function and its standard as one duty in its operating context. Ask what states leave this duty unmet in a way the user would notice and act on.
2. Use "standardParameters" as evidence of what can be violated, and the directions below as the vocabulary for how one requirement goes wrong. They inform the judgement; they do not make it.
   - "total": the function delivers nothing.
   - "partial": delivered below what is required.
   - "upper_limit": delivered above what is required, including failing to stop, unload, or shut down.
   - "intermittent": delivered erratically or only some of the time.
3. SELECT the states that carry a distinct consequence. Two states that differ only in which parameter moved, but leave the user in the same position, are ONE failed state: write it once, against the parameter that best describes it. A parameter nobody would respond to differently produces no row of its own.
4. Set "parameter" and "failedState" on every failure you write, so the analysis can be audited.
5. "skipped" is optional. Use it to record a direction you deliberately considered and rejected. Nothing requires you to account for every combination, and an unlisted combination is not an error.

Hard rules:
- There is no target count, in either direction. Write what this equipment can actually do. A function with four measured parameters may correctly yield two failed states or five; those are right answers about different equipment, not a better and a worse answer about the same one.
- PROTECTIVE FUNCTIONS (JA1011 5.1.5): the failed state of a protective function is its inability to protect, and nothing else. Write the protective action not happening -- "unable to shut down on high discharge temperature", "unable to relieve overpressure at the set pressure", "standby does not start on duty trip". The excursion the device guards against is a failed state of the function being PROTECTED, usually in another subsystem, and it does not belong here. Never write both.
- At most ONE "intermittent" failure per function. Erratic delivery is one failed state of the duty, not one per parameter.
- A design rating or withstand limit is not something the function delivers, so exceeding it is never a failed state. It is a cause of losing containment or integrity. Do not write it as a functional failure.
- When a requirement appears in a flagged source CONFLICT, write ONE failure for it and name the conflict in the text. Never one failure per conflicting value.
- Do not emit "lower_limit". Below the requirement is "partial"; the distinction was never real.
- "on_demand" is not a direction. Emit it only for a row whose "evidence" is "hidden", where it REPLACES that row's "total" failure -- a hidden function's total loss is discovered on demand. Never emit both "total" and "on_demand" for the same row, and never "on_demand" for an evident function.
- Use the parameter's own value in the failure text, and make the wording agree with the direction. "partial" reads as below/insufficient, "upper_limit" reads as above/exceeds. A failure tagged "upper_limit" whose text says "below" is a contradiction and will be rejected.
- When the row has no parameters, the standard is qualitative. Emit total loss only, and do not invent values to enumerate against.
- Two failures on the same row must differ in parameter or in direction. Identical states reworded are duplicates.`;

/**
 * Verb forms folded to one stem before a function phrase is used as a key.
 *
 * The pattern is derived from these keys rather than written out separately.
 * It used to be a hand-maintained regex listing the same words a second time,
 * and the two drifted: "contains" was in neither, so "contain compressed air"
 * and "contains compressed air" produced different bucket keys and the same
 * containment function survived decomposition twice — once quantified, once
 * not.
 */
const FUNCTION_VERB_FORMS: Record<string, string> = {
    supplies: 'supply', supplying: 'supply',
    delivers: 'deliver', delivering: 'deliver',
    provides: 'provide', providing: 'provide',
    contains: 'contain', containing: 'contain',
    compresses: 'compress', compressing: 'compress',
    relieves: 'relieve', relieving: 'relieve',
    isolates: 'isolate', isolating: 'isolate',
    prevents: 'prevent', preventing: 'prevent',
    holds: 'hold', holding: 'hold',
    retains: 'retain', retaining: 'retain',
    separates: 'separate', separating: 'separate',
    generates: 'generate', generating: 'generate',
    stores: 'store', storing: 'store',
    transfers: 'transfer', transferring: 'transfer',
    circulates: 'circulate', circulating: 'circulate',
    conditions: 'condition', conditioning: 'condition',
    maintains: 'maintain', maintaining: 'maintain',
    filters: 'filter', filtering: 'filter',
    limits: 'limit', limiting: 'limit',
    lubricates: 'lubricate', lubricating: 'lubricate',
    cools: 'cool', cooling: 'cool',
    seals: 'seal', sealing: 'seal',
    protects: 'protect', protecting: 'protect',
    controls: 'control', controlling: 'control',
    regulates: 'regulate', regulating: 'regulate',
    measures: 'measure', measuring: 'measure',
    supports: 'support', supporting: 'support',
};
const FUNCTION_VERB_PATTERN = new RegExp(`\\b(${Object.keys(FUNCTION_VERB_FORMS).join('|')})\\b`, 'gi');

const FUNCTIONAL_FAILURE_TECHNICAL_RULES = `Functional failure rules:
- Describe required performance not achieved, not a physical mechanism.
- Link directly to the subsystem function or decomposed function.
- State the failed condition plainly. Openings such as "Fails to ...", "Unable to ...", "Does not ...", "Delivers below ...", "Supplies above ...", "Operates intermittently ...", or "Operates when not required" all work; choose whichever states this particular failure most directly rather than forcing every failure into one opening.
- Never restate the function with "Fails to" prefixed to it. "Fails to supply air 599 Sm3/hr at 130 psig" is the function negated, not a failed state. Name what was not achieved and by which direction: "Supplies instrument air below 599 Sm3/hr".
- Do not name the device that performs the duty — the duty fails, not the valve or the starter. Write "Does not relieve overpressure at 12.0 barg on demand", not "PSV fails to open".
- Do not include causes, effects, failure modes, controls, mitigations, maintenance tasks, tags, equipment IDs, downstream narrative, or invented values.`;

const FAILURE_MODE_TECHNICAL_RULES = `Failure mode / cause / effect rules:
- "mode": concise failed-state wording only, such as no flow, low pressure, high temperature, intermittent signal, external leakage, internal leakage, blocked path, restricted path, stuck open, stuck closed, seized, worn, cracked, ruptured, corroded, eroded, contaminated, misaligned, signal lost, signal drifted, false high reading, or false low reading.
- "mode" must be more specific than the functional failure and must not include cause wording: due to, because of, caused by, resulting from, as a result of.
- "mode" must not include effect/control wording: equipment shutdown, production loss, trip, alarm, inspection, PM, maintenance, mitigation, recommendation, or monitoring action.
- "cause": why the mode occurs; do not repeat the mode unless no deeper cause is available; do not write an effect or mitigation.
- "effect": consequence after the mode occurs; preserve the required Local/End format; do not write a cause, control, or mitigation.`;

const OPERATIONAL_HISTORY_GUIDANCE_RULES = `Operational failure history rules:
- Treat component-scoped history as advisory occurrence evidence, never as an output template or naming authority.
- Derive every Failure Mode from the current Functional Failure and subsystem function first.
- Rewrite any useful historical concept into the required concise failed-state format; do not copy CMMS event wording.
- Do not output Unknown, Review Required, No Fault Found, Non-Equipment Activity, replacement/repair actions, or maintenance activities as Failure Modes.
- Do not generate a mode merely because it appears in history, and do not omit a credible mode merely because it is absent.
- Existing FMECA hierarchy, field-separation, uniqueness, and wording rules override historical labels.`;

const FAILURE_MODE_BARRIER_FILTER = `Failure-mode-specific barrier filter:
- Use Functional Failure, Failure Mode, Cause, and Effect as hard anchors.
- Keep only barriers that directly prevent the stated cause, detect the stated cause, detect the failure signature specific to this failure mode, or reduce/limit the stated effect.
- Reject subsystem-generic tasks unless rewritten as a specific barrier for this exact failure mode.
- Reject controls/actions that belong more strongly to sibling failure modes.
Silent barrier test for every candidate line:
- Which exact cause does this address?
- Which exact failure signature does this detect?
- Which exact effect does this reduce?
- Does it belong more strongly to another failure mode?
Keep the line only if it directly matches this failure mode's cause/effect chain.
Sibling-exclusion examples for pump vibration:
- Pump imbalance: keep impeller deposits/damage, dynamic balance, imbalance-specific 1x radial vibration trend, impeller cleaning/inspection.
- Exclude laser alignment/coupling alignment unless failure mode/cause is misalignment.
- Exclude bearing lubrication/bearing temperature unless failure mode/cause is bearing degradation.
- Exclude suction pressure/NPSH unless failure mode/cause is cavitation or hydraulic starvation.
- Exclude foundation/bolt looseness unless failure mode/cause is looseness.`;

/**
 * Uploaded knowledge files — reference data and the PM checklist — go to the model whole.
 *
 * Each caller used to slice its own copy at its own limit (6000 / 7000 / 10000 / 15000),
 * so the same instrument index was cut at different points depending on which feature
 * asked: a tag near the end of the file was visible to Auto-Fill and invisible to the
 * Current Controls wand, which looks exactly like the model ignoring a deployed
 * protection. There is no cap of our own now — the model's context window is the only
 * boundary, so an oversized file fails loudly with a provider error instead of quietly
 * producing an answer built on half the evidence. Do not reintroduce a slice here.
 */
const buildSiblingFailureModeBlock = (siblings: any): string => {
    if (!Array.isArray(siblings) || siblings.length === 0) return '';
    const rows = siblings
        .slice(0, 12)
        .map((m: any, i: number) => {
            const mode = String(m?.mode ?? m ?? '').trim();
            const cause = String(m?.cause ?? '').trim();
            const effect = String(m?.effect ?? '').trim();
            const parts = [`Mode "${mode || 'Unknown'}"`];
            if (cause) parts.push(`Cause "${cause}"`);
            if (effect) parts.push(`Effect "${effect}"`);
            return `${i + 1}. ${parts.join(' | ')}`;
        })
        .join('\n');
    return `\nSibling failure modes in the same analysis context (exclude barriers that fit these better):\n${rows}`;
};

const buildModeFieldRules = (controlsKnowledgeAvailable: boolean, generatedLabel = 'THIS generated failure mode'): string => `Field rules per mode:
- Apply these shared rules to every generated row:
${FMECA_HIERARCHY_RULES}
${FMECA_CONCISE_WORDING_RULES}
${FAILURE_MODE_TECHNICAL_RULES}
- "mode": specific failed state or mechanism for ${generatedLabel}; keep it short and do not include cause, effect, control, mitigation, alarm, trip, or maintenance wording.
- "effect": format "Local: <effect at this subsystem>; End: <effect at system level>".
- "cause": the dominant root cause of this mode.
${controlsKnowledgeAvailable
    ? `- "currentControls": ONLY controls currently deployed/evidenced for ${generatedLabel} in PM CHECKLIST KNOWLEDGE or REFERENCE DATA, and only if they directly prevent the stated cause, detect the stated cause, detect this mode's specific failure signature, or limit the stated effect. Include relevant PM/checklist tasks plus deployed instrument/protection controls (temperature, pressure, level, flow, vibration, speed, alarms, trips, interlocks, transmitters/switches/tags and limits where stated). Reject subsystem-generic controls and controls for sibling failure modes. Do NOT invent or recommend new controls here. Empty string if no evidence applies. Never prefix a line with "Existing control".`
    : '- "currentControls": always return an empty string "" — current controls require checklist or reference evidence, which is not available.'}
- "mitigation": RECOMMENDED actions (not yet implemented) for ${generatedLabel} that close gaps NOT covered by currentControls in the same cause/effect chain. Use checklist/reference recommendations when present, then add reliability-knowledge tasks or controls for remaining gaps in Hybrid/AI generation. Never duplicate a task already listed in currentControls and never bring tasks for sibling failure modes.
${LIBRARY_EXAMPLES}`;

const MODE_ACTION_FORMAT_RULES = `Current controls format — return as a numbered string per mode without the words "Existing control":
"1- [Tag: TAGNO (limit if stated)] (Owner)" or "1- Action [Tag: TAGNO (limit if stated)] (Owner)\\n2- ..."
Mitigation format — return as a numbered string per mode:
"1- Action [Tag: TAGNO (Hi: X, Hi-Hi: Y) if applicable] (Owner)\\n2- ..."
Owner rules: sensor/transmitter/tag → (Instrument team) | lubrication/mechanical → (Mechanical team) | PLC/interlock/control → (Automation team) | rounds/monitoring → (Operation team)
Use checklist knowledge for PM tasks and reference data for instrument tags and limits only when they pass the failure-mode-specific barrier filter.
${FAILURE_MODE_BARRIER_FILTER}`;

const blankGeneratedRpn = () => ({ s: "", o: "", d: "" });

export interface AIMessage {
    role: string;
    content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
}

export interface ToolDefinition {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, { type: string; description?: string }>;
        required: string[];
    };
}

export interface ToolCall {
    id: string;
    name: string;
    args: Record<string, any>;
}

export interface ToolChatResult {
    type: 'text' | 'tool_calls';
    content?: string;
    calls?: ToolCall[];
}

/**
 * A real file handed to a transport that can open one for itself. Only the
 * Power Automate flow behind the Copilot provider has such a channel; every
 * other provider takes images inline instead.
 */
export interface FilePayload {
    name: string;
    contentType: string;
    /** Base64, without a data-URL prefix. */
    contentBytes: string;
}

export interface AIRequestPayload {
    sessionId?: string;
    feature: string; // Identifier for the feature calling the service
    provider: 'openai' | 'gemini' | 'anthropic' | 'azure' | 'openrouter' | 'copilot';
    azureEndpoint?: string;
    powerAutomateUrl?: string; // HTTP trigger endpoint for Power Automate (Copilot provider)
    model: string;
    messages: AIMessage[];
    mode: 'ai' | 'file' | 'hybrid';
    refText?: string;
    contextData?: any;
    responseFormat?: 'json' | 'text';
    apiKey: string;
    /** Files for the Copilot flow's attachment input. Ignored by other providers. */
    attachments?: FilePayload[];
}

type SystemModeRow = Pick<SystemMode, 'component' | 'mode' | 'count'>;

type SystemModeOccurrenceEvidence = {
    component: string;
    mode: string;
    count: number;
    rank: number;
    totalModes: number;
    maxCount: number;
    occurrenceScore: number;
    matchType: 'exact' | 'contains' | 'token-overlap';
};

// Vision-specific payload extension (handled via contextData or standardized logic in contract)
// The contract requires a unified interface. We will map vision specific fields into the payload structure.

/**
 * A breakdown row before it is given an id.
 *
 * Deliberately not the `BreakdownRow` in types.ts: that one carries an `id`,
 * which is minted by the caller once the row survives merging. Shared between
 * decomposeFunction and buildBreakdownRows so the extraction stays type-checked.
 */
export type RawBreakdownRow = {
    function: string;
    standard: string;
    snippet: string;
    functionClass: FunctionClass;
    quantified: boolean;
    evidence: 'evident' | 'hidden';
    standardParameters: StandardParameter[];
};

/**
 * Bucket, merge, and cap the raw rows a model returned for one subsystem.
 *
 * Extracted from decomposeFunction so it can be tested without an API call.
 * Everything here is deterministic: given the same rows and names it returns the
 * same breakdown, which is the property the golden fixtures assert.
 */
export function buildBreakdownRows(
    rawRows: RawBreakdownRow[],
    subsystemName: string,
    projectName: string,
    detailLevel: 'normal' | 'detailed' = 'detailed',
): RawBreakdownRow[] {
    const isControlSubsystem = /transmitter|sensor|instrument|control|panel|plc|ucp|pcs|sgs|logic|controller/i.test(`${subsystemName} ${projectName}`);
    const compact = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const textOf = (r: RawBreakdownRow) => compact(`${r.function} ${r.standard} ${r.snippet}`);
    const includesAny = (text: string, terms: RegExp[]) => terms.some(re => re.test(text));
    const rows: RawBreakdownRow[] = [];
    const usedKeys = new Set<string>();
    // Cap functions, not failures. Each row now yields several failed states,
    // so the analysis grows through JA1011 5.2 enumeration rather than row count.
    const maxRows = detailLevel === 'normal' ? 6 : 8;
    // Keyed on the FUNCTION alone, not function+standard.
    //
    // Including the standard meant one duty stated twice with different
    // standards — "contain air and oil / 13.8 barg, 150 deg C" beside
    // "contain air and oil / retained within pressure envelope" — produced
    // two keys and survived as two rows, one of them unquantified. They are
    // the same function; the second is just a worse description of the same
    // standard. Merging them and unioning the parameters keeps the measured
    // requirements and drops the duplicate.
    const rowKey = (row: RawBreakdownRow) => compact(row.function)
        // Fold verb inflections before keying. a65c305 rebuilt FUNCTION_VERB_FORMS to
        // stop "contain" and "contains" producing different keys, but wired it only
        // into the failure-phrase normaliser -- this key, the one that actually
        // decides whether two rows are the same duty, never saw it. So "contain air
        // and oil" and "contains air and oil" still survived as two rows, one of them
        // unquantified.
        .replace(FUNCTION_VERB_PATTERN, m => FUNCTION_VERB_FORMS[m.toLowerCase()] || m)
        .replace(/\b(leaks?|leakage)\b/g, 'leak')
        .replace(/\b(properly|correctly|adequately|reliably)\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    // Keyed on the caller's bucket key, not on rowKey(row).
    //
    // bucketOf deliberately prefixes the class, so "limit discharge temperature"
    // classified protection survives alongside the same phrase classified control.
    // Re-deriving a bare rowKey here collided them again and dropped the second
    // silently, taking its parameters with it -- the merge decided to keep two
    // rows and this line overruled it without telling anyone. When a key does
    // repeat, union the parameters instead of discarding the loser.
    const addRow = (row: RawBreakdownRow, key: string) => {
        const cleaned = {
            function: row.function.trim(),
            standard: row.standard.trim(),
            snippet: (row.snippet || row.function).trim(),
            functionClass: row.functionClass,
            quantified: row.quantified,
            evidence: row.evidence,
            standardParameters: row.standardParameters,
        };
        if (!cleaned.function || !cleaned.standard) return;
        if (usedKeys.has(key)) {
            const existing = rows.find(r => rowKey(r) === rowKey(cleaned) && r.functionClass === cleaned.functionClass);
            if (existing) {
                const seen = new Set((existing.standardParameters ?? []).map(pp => pp.name));
                for (const pp of cleaned.standardParameters ?? []) {
                    if (seen.has(pp.name)) continue;
                    seen.add(pp.name);
                    (existing.standardParameters ??= []).push(pp);
                }
            }
            return;
        }
        usedKeys.add(key);
        rows.push(cleaned);
    };

    const weakOnly = /^(reliable|efficient|safe|available|continuous|proper|properly|as required|normal|normal operation|good condition|acceptable|adequate|within limits|per design)$/i;
    // "maintain" is deliberately absent. It is the ordinary verb for a primary
    // duty ("maintain discharge pressure", "maintain lubrication"), so matching
    // on it pulled primary rows into the control bucket, where merging then
    // deleted them.
    const controlTerms = [/\b(control|regulate|stabilize|modulate|sequence|start|stop|load|unload|setpoint|set point|feedback|demand response)\b/];
    const envelopeTerms = [/\b(operating envelope|envelope|range|limit|rated|design|maximum|minimum|temperature|pressure|flow|speed|capacity|level)\b/];
    const serviceFunctionTerms = [/\b(deliver|supply|provide|pump|transfer|convert|heat|cool|filter|separate|store|contain|generate)\b/];
    const ppeTerms = [/\b(hearing protection|ppe|personnel|operator exposure|protective equipment)\b/];
    const safeguardTerms = [/\b(safety valve|relief valve|rupture disc|interlock|trip|alarm|shutdown|protection device|overpressure protection|set pressure)\b/];
    const monitoringTerms = [/\b(transmitter|sensor|indicator|feedback|monitored|monitoring|control panel|plc|dcs|scada|ucp|pcs|sgs)\b/];
    const designOnlyTerms = [/\b(material|construction|casing|housing|frame|skid|designed for)\b/];

    const isNoiseExposureOnly = (text: string) =>
        /\b(noise|sound)\b/.test(text) && /\b(db|decibel|hearing|personnel|operator|meter|metre)\b/.test(text);
    const isFunctionalVerb = (fn: string) =>
        /\b(operate|run|maintain|deliver|supply|provide|contain|control|regulate|protect|store|transfer|generate)\b/.test(compact(fn));
    const isProtectiveFunction = (fn: string) =>
        /\b(protect|limit|relieve|contain|isolate|prevent|restrict|shut|trip|stop)\b/.test(compact(fn));
    const shouldSkip = (row: RawBreakdownRow) => {
        const text = textOf(row);
        if (weakOnly.test(row.standard.trim())) return true;
        if (includesAny(text, ppeTerms)) return true;
        if (!/noise|sound|acoustic/i.test(`${subsystemName} ${projectName}`) && isNoiseExposureOnly(text)) return true;
        // A relief or isolation DUTY is a protection function under JA1011 5.1 and
        // must survive; only a row describing the device itself is dropped. The
        // blanket skip here was what erased overpressure-limiting failures.
        if (!isControlSubsystem && includesAny(text, safeguardTerms) && !isProtectiveFunction(row.function)) return true;
        if (!isControlSubsystem && includesAny(text, monitoringTerms)) return true;
        if (includesAny(text, designOnlyTerms) && !isFunctionalVerb(row.function)) return true;
        return false;
    };

    // The synthesised "operates within equipment condition limits" rows are gone.
    // Vibration, wear, corrosion and overheating are failure modes, not functions,
    // and a row built from them produced a functional failure that was really a
    // mode -- the exact field confusion FMECA_HIERARCHY_RULES forbids elsewhere.
    const candidateRows: RawBreakdownRow[] = rawRows.filter(row => !shouldSkip(row));

    // Bucket by declared JA1011 class so distinct secondary functions are never
    // merged into one another. Two rows only collapse when they share a class
    // AND would fail the same way.
    //
    // Every bucket key is now per-row. Control and envelope used to return the
    // literal strings 'control' and 'envelope', so EVERY control function in a
    // subsystem landed in one bucket and mergeBucket kept exactly one of them.
    // A compressor that supplies air and also holds pressure by loading and
    // unloading lost the load/unload function outright, and it was invisible:
    // the survivor looked like a complete answer.
    const bucketOf = (row: RawBreakdownRow) => {
        if (shouldSkip(row)) return '';
        const text = textOf(row);
        const fn = compact(row.function);
        if (row.functionClass === 'containment' || row.functionClass === 'protection') return `${row.functionClass}:${rowKey(row)}`;
        if (row.functionClass === 'control' || includesAny(text, controlTerms)) return `control:${rowKey(row)}`;
        if (includesAny(text, envelopeTerms) && !includesAny(fn, serviceFunctionTerms)) return `envelope:${rowKey(row)}`;
        return `row:${rowKey(row)}`;
    };
    // Merging used to overwrite the standard with fixed prose, which deleted the
    // measured value JA1011 5.1.2 requires. Keep the most quantified member instead.
    const mergeBucket = (_bucket: string, group: RawBreakdownRow[]): RawBreakdownRow => {
        if (group.length === 1) return group[0];
        const quantified = group.filter(r => r.quantified);
        // Prefer the member carrying the most parsed requirements: that is the
        // one the FF step can enumerate against. Standard length is only the
        // tiebreak, since a long qualitative standard beats a short measured one
        // on characters while being worth less.
        const richest = (a: RawBreakdownRow, b: RawBreakdownRow) => {
            const byParams = (b.standardParameters?.length ?? 0) - (a.standardParameters?.length ?? 0);
            if (byParams !== 0) return byParams < 0 ? a : b;
            return b.standard.length > a.standard.length ? b : a;
        };
        const winner = quantified.length
            ? quantified.reduce(richest)
            : group[0];
        // Union the parameters across the group. Keeping only the winner's
        // would silently drop a measured requirement that the losing row
        // was the one to state.
        const mergedParameters: StandardParameter[] = [];
        const seenParam = new Set<string>();
        for (const member of [winner, ...group]) {
            for (const p of member.standardParameters ?? []) {
                if (seenParam.has(p.name)) continue;
                seenParam.add(p.name);
                mergedParameters.push(p);
            }
        }
        return {
            ...winner,
            standardParameters: mergedParameters,
            quantified: winner.quantified || mergedParameters.some(p => /\d/.test(p.value)),
            snippet: winner.snippet || winner.function,
            // A hidden member makes the merged function hidden: the stricter
            // classification is the safe one, since it drives failure-finding.
            evidence: group.some(r => r.evidence === 'hidden') ? 'hidden' : winner.evidence,
        };
    };

    const bucketOrder: string[] = [];
    const buckets = new Map<string, RawBreakdownRow[]>();
    candidateRows.forEach(row => {
        const bucket = bucketOf(row);
        if (!bucket) return;
        if (!buckets.has(bucket)) {
            buckets.set(bucket, []);
            bucketOrder.push(bucket);
        }
        buckets.get(bucket)!.push(row);
    });

    bucketOrder.forEach(bucket => addRow(mergeBucket(bucket, buckets.get(bucket)!), bucket));
    if (rows.length > maxRows) {
        // Say what was dropped. A subsystem with more real duties than the cap
        // silently lost the tail, and the survivors read as a complete answer.
        console.warn(
            `[decomposeFunction] "${subsystemName}": ${rows.length - maxRows} function row(s) dropped by the ${maxRows}-row cap.`,
            rows.slice(maxRows).map(r => r.function)
        );
    }
    return rows.slice(0, maxRows);
}

export const AIService = {
    // -------------------------------------------------------------------------
    // PUBLIC CONTRACT (Used by all features)
    // -------------------------------------------------------------------------

    async chat(req: AIRequestPayload): Promise<string> {
        if (req.provider === 'copilot') {
            return this._powerAutomateRequest(req);
        }
        if (AI_CONFIG.baseUrl) {
            try {
                return await this._remoteRequest(AI_CONFIG.endpoints.chat, req);
            } catch (e) {
                console.warn(`[AIService] Remote chat failed, falling back to DIRECT mode.`, e);
            }
        }
        return this._directChat(req);
    },

    /**
     * Streaming chat — emits text deltas via onChunk as they arrive (ChatGPT-style).
     * Returns the full concatenated text when done.
     *
     * Copilot (Power Automate) cannot stream and remote/proxy mode is non-streaming,
     * so both fall back to a single onChunk with the full reply. Any streaming error
     * falls back to a non-streaming chat() so the user still gets an answer.
     *
     * Built for the chatbot final-answer call (feature: 'chatbot') — messages are
     * sent as-is (system + conversation), like _directChat's chatbot branch.
     */
    async chatStream(req: AIRequestPayload, onChunk: (delta: string) => void): Promise<string> {
        // No real streaming for Copilot or remote-proxy mode — emit the full reply once.
        if (req.provider === 'copilot' || AI_CONFIG.baseUrl) {
            const full = await this.chat(req);
            if (full) onChunk(full);
            return full;
        }

        try {
            const sys = () => req.messages
                .filter(m => m.role === 'system')
                .map(m => typeof m.content === 'string' ? m.content : '')
                .join('\n\n');

            let url: string;
            let headers: Record<string, string>;
            let body: any;
            let parser: 'openai' | 'anthropic' | 'gemini';

            if (req.provider === 'anthropic') {
                parser = 'anthropic';
                const convMsgs = req.messages
                    .filter(m => m.role !== 'system')
                    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: typeof m.content === 'string' ? m.content : '' }));
                url = 'https://api.anthropic.com/v1/messages';
                headers = { 'Content-Type': 'application/json', 'x-api-key': req.apiKey, 'anthropic-version': '2023-06-01' };
                body = { model: (req.model && req.model.trim()) || 'claude-sonnet-4-20250514', max_tokens: 4096, system: sys() || 'You are a helpful FMECA consultant.', messages: convMsgs, stream: true };
            } else if (req.provider === 'gemini') {
                parser = 'gemini';
                const contents = req.messages
                    .filter(m => m.role !== 'system')
                    .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: typeof m.content === 'string' ? m.content : '' }] }));
                const model = (req.model && req.model.trim()) || 'gemini-2.0-flash';
                url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${req.apiKey}`;
                headers = { 'Content-Type': 'application/json' };
                body = { contents, systemInstruction: { parts: [{ text: sys() || 'You are a helpful FMECA consultant.' }] } };
            } else {
                // openai | openrouter | azure — OpenAI-compatible SSE
                parser = 'openai';
                if (req.provider === 'azure') {
                    const endpoint = (req.azureEndpoint || '').replace(/\/$/, '');
                    url = `${endpoint}/openai/deployments/${req.model}/chat/completions?api-version=2024-02-01`;
                    headers = { 'Content-Type': 'application/json', 'api-key': req.apiKey };
                    body = { messages: req.messages, stream: true };
                } else if (req.provider === 'openrouter') {
                    url = 'https://openrouter.ai/api/v1/chat/completions';
                    headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${req.apiKey}` };
                    body = { model: (req.model && req.model.trim()) || 'openai/gpt-4o-mini', messages: req.messages, stream: true };
                } else {
                    url = 'https://api.openai.com/v1/chat/completions';
                    headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${req.apiKey}` };
                    body = { model: (req.model && req.model.trim()) || 'gpt-4o-mini', messages: req.messages, stream: true };
                }
            }

            const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
            if (!res.ok || !res.body) {
                const errText = await res.text().catch(() => '');
                throw new Error(`API error ${res.status}${errText ? ` — ${errText}` : ''}`);
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let full = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data:')) continue;
                    const payloadStr = trimmed.slice(5).trim();
                    if (!payloadStr || payloadStr === '[DONE]') continue;

                    try {
                        const json = JSON.parse(payloadStr);
                        let delta = '';
                        if (parser === 'openai') {
                            delta = json.choices?.[0]?.delta?.content || '';
                        } else if (parser === 'gemini') {
                            delta = (json.candidates?.[0]?.content?.parts || []).map((p: any) => p.text || '').join('');
                        } else { // anthropic
                            if (json.type === 'content_block_delta') delta = json.delta?.text || '';
                            else if (json.type === 'error') throw new Error(json.error?.message || 'Anthropic stream error');
                        }
                        if (delta) { full += delta; onChunk(delta); }
                    } catch (parseErr) {
                        // Re-throw real stream errors; ignore unparseable keep-alive lines.
                        if (parseErr instanceof Error && parseErr.message.includes('stream error')) throw parseErr;
                    }
                }
            }
            return full;
        } catch (e) {
            // Fall back to non-streaming so the user still gets an answer.
            console.warn('[AIService] Streaming failed, falling back to non-streaming chat.', e);
            const full = await this.chat(req);
            if (full) onChunk(full);
            return full;
        }
    },

    /**
     * Sends a chat request with tool definitions.
     * Returns either tool_calls (AI wants to call tools) or text (final answer).
     * Supports: openai, azure, openrouter (tools param), gemini (function_declarations).
     * Falls back to plain chat() for anthropic and on any error.
     */
    async chatWithTools(req: AIRequestPayload, tools: ToolDefinition[]): Promise<ToolChatResult> {
        try {
            // Copilot has no native function-calling — emulate it over text.
            // buildCopilotPrompt appends a TOOL PROTOCOL teaching the model to
            // reply with a ```tool fence; parseCopilotReply converts it back into
            // the same tool_calls shape the native providers produce.
            if (req.provider === 'copilot') {
                if (!req.powerAutomateUrl) {
                    throw new Error('Power Automate URL is required for Copilot provider.');
                }
                const postPrompt = async (messages: AIMessage[]): Promise<string> => {
                    const res = await fetch(req.powerAutomateUrl as string, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            sessionId: req.sessionId ?? getCopilotSessionId(),
                            prompt: buildCopilotPrompt(messages, tools),
                            responseFormat: 'text'
                        })
                    });
                    if (!res.ok) {
                        const errText = await res.text();
                        throw new Error(`Power Automate Error: ${res.statusText}${errText ? ` — ${errText}` : ''}`);
                    }
                    return res.text();
                };

                const raw = await postPrompt(req.messages);
                let parsed = parseCopilotReply(raw);

                // A ```tool fence with broken JSON would otherwise surface a
                // half-answer as final — give the model one repair round-trip.
                if (parsed.malformedToolFence) {
                    const repaired = await postPrompt([
                        ...req.messages,
                        { role: 'assistant', content: raw },
                        {
                            role: 'user',
                            content: 'Your ```tool fence contained invalid JSON and could not be executed. ' +
                                'Re-send the tool call as ONE valid ```tool fence (a JSON object with "name" and "arguments"), and nothing else.'
                        }
                    ]);
                    parsed = parseCopilotReply(repaired);
                }

                return parsed.calls.length > 0
                    ? { type: 'tool_calls', calls: parsed.calls }
                    : { type: 'text', content: parsed.content };
            }

            if (req.provider === 'openai' || req.provider === 'azure' || req.provider === 'openrouter') {
                const openAITools = tools.map(t => ({
                    type: 'function' as const,
                    function: { name: t.name, description: t.description, parameters: t.parameters }
                }));

                let url: string;
                let headers: Record<string, string>;
                if (req.provider === 'azure') {
                    const endpoint = (req.azureEndpoint || '').replace(/\/$/, '');
                    url = `${endpoint}/openai/deployments/${req.model}/chat/completions?api-version=2024-02-01`;
                    headers = { 'Content-Type': 'application/json', 'api-key': req.apiKey };
                } else if (req.provider === 'openrouter') {
                    url = 'https://openrouter.ai/api/v1/chat/completions';
                    headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${req.apiKey}` };
                } else {
                    url = 'https://api.openai.com/v1/chat/completions';
                    headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${req.apiKey}` };
                }

                const body = {
                    model: (req.model && req.model.trim()) || 'gpt-4o-mini',
                    messages: req.messages,
                    tools: openAITools,
                    tool_choice: 'auto'
                };

                const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
                const data = await res.json();
                if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

                const msg = data.choices[0].message;
                if (msg.tool_calls && msg.tool_calls.length > 0) {
                    return {
                        type: 'tool_calls',
                        calls: msg.tool_calls.map((tc: any) => ({
                            id: tc.id,
                            name: tc.function.name,
                            args: (() => { try { return JSON.parse(tc.function.arguments || '{}'); } catch { return {}; } })()
                        }))
                    };
                }
                return { type: 'text', content: msg.content || '' };
            }

            if (req.provider === 'gemini') {
                const functionDeclarations = tools.map(t => ({
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters
                }));

                const systemMsg = req.messages.find(m => m.role === 'system');
                const contents = req.messages
                    .filter(m => m.role !== 'system')
                    .map(m => ({
                        role: m.role === 'assistant' ? 'model' : 'user',
                        parts: [{ text: typeof m.content === 'string' ? m.content : '' }]
                    }));

                const body: any = {
                    contents,
                    tools: [{ functionDeclarations }],
                    toolConfig: { functionCallingConfig: { mode: 'AUTO' } }
                };
                if (systemMsg) {
                    body.systemInstruction = { parts: [{ text: typeof systemMsg.content === 'string' ? systemMsg.content : '' }] };
                }

                const model = (req.model && req.model.trim()) || 'gemini-2.0-flash';
                const res = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${req.apiKey}`,
                    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
                );
                const data = await res.json();
                if (data.error) throw new Error(data.error.message);

                const parts: any[] = data.candidates?.[0]?.content?.parts || [];
                const funcCallParts = parts.filter((p: any) => p.functionCall);
                if (funcCallParts.length > 0) {
                    return {
                        type: 'tool_calls',
                        calls: funcCallParts.map((p: any) => ({
                            id: p.functionCall.name,
                            name: p.functionCall.name,
                            args: p.functionCall.args || {}
                        }))
                    };
                }
                const textPart = parts.find((p: any) => p.text);
                return { type: 'text', content: textPart?.text || '' };
            }

            // Fallback for anthropic and unknown providers: plain chat
            const content = await this.chat(req);
            return { type: 'text', content };
        } catch {
            // On any error fall back to plain chat so the user still gets a response
            try {
                const content = await this.chat(req);
                return { type: 'text', content };
            } catch (e2) {
                throw e2;
            }
        }
    },

    /**
     * Retries an async op with exponential backoff + jitter. Built for bulk
     * generation against rate-limited providers (free OpenRouter, Copilot): the
     * burst of calls trips per-minute caps, so retries must spread out (jitter
     * stops them colliding) and back off far enough to clear the window.
     * Throwing inside `fn` (API error, bad/empty parse) triggers a retry.
     */
    async _withRetry<T>(fn: () => Promise<T>, attempts: number = 4, baseMs: number = 2000): Promise<T> {
        let lastErr: any;
        for (let attempt = 1; attempt <= attempts; attempt++) {
            try {
                return await fn();
            } catch (e) {
                lastErr = e;
                if (attempt < attempts) {
                    const delay = Math.min(baseMs * 2 ** (attempt - 1), 20000) + Math.floor(Math.random() * 1000);
                    await new Promise(r => setTimeout(r, delay));
                }
            }
        }
        throw lastErr;
    },

    async vision(req: AIRequestPayload): Promise<string> {
        if (AI_CONFIG.baseUrl) {
            try {
                return await this._remoteRequest(AI_CONFIG.endpoints.vision, req);
            } catch (e) {
                console.warn(`[AIService] Remote vision failed, falling back to DIRECT mode.`, e);
            }
        }
        return this._directVision(req);
    },

    // -------------------------------------------------------------------------
    // HELPERS
    // -------------------------------------------------------------------------

    attachContext(prompt: string, mode: string, refText: string, responseFormat?: string): string {
        if (!refText || !refText.trim()) return prompt;
        const refBlock = `REFERENCE DATA:\n"""\n${refText}\n"""\n`;
        if (mode === 'file') {
            // For JSON tasks "say N/A" would break the parser — keep the output
            // shape intact and signal missing data through empty fields instead.
            const missingRule = responseFormat === 'json'
                ? 'Use ONLY Reference Data. The output MUST still be the requested JSON: omit or leave empty any items not supported by Reference Data — never reply with prose like "N/A".'
                : 'Use ONLY Reference Data. If not found, say "N/A".';
            return `${refBlock}${missingRule}\nTASK: ${prompt}`;
        }
        if (mode === 'hybrid') return `${refBlock}Use Reference Data as primary. Supplement with general knowledge.\nTASK: ${prompt}`;
        return prompt;
    },

    extractJSON(text: string): any {
        try { return JSON.parse(text); } catch (e) {
            // Strip markdown code fences (Copilot/chatty models wrap JSON in ```json ... ```)
            let t = text.replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '').trim();
            const tryRange = (open: string, close: string) => {
                const start = t.indexOf(open); const end = t.lastIndexOf(close);
                if (start !== -1 && end > start) { try { return JSON.parse(t.substring(start, end + 1)); } catch { return undefined; } }
                return undefined;
            };
            const obj = tryRange('{', '}');
            if (obj !== undefined) return obj;
            const arr = tryRange('[', ']');
            if (arr !== undefined) return arr;
            throw new Error("No JSON");
        }
    },

    cleanSingleFieldText(text: string): string {
        return String(text || '')
            .replace(/```[a-zA-Z]*\s*/g, '')
            .replace(/```/g, '')
            .replace(/\*\*(.*?)\*\*/g, '$1')
            .replace(/__(.*?)__/g, '$1')
            .replace(/^\s*(?:Function(?: Description)?|Functional Failure|Failure Mode|Failure Effect|Failure Cause|Cause|Effect|Specs?|Specifications?)\s*:\s*/i, '')
            .replace(/\s+/g, ' ')
            .trim();
    },

    normalizeFunctionPhraseForFailure(text: string): string {
        let s = this.cleanSingleFieldText(text)
            .replace(/^(?:to|and)\s+/i, '')
            // Trim only a vague trailing envelope ("... within acceptable limits").
            // A tail carrying digits IS the quantified performance standard JA1011
            // 5.1.2 asks for, and stripping it made every failure unauditable.
            .replace(/\bwithin\b.*$/i, m => (/\d/.test(m) ? m : ''))
            .replace(/\s+/g, ' ')
            .trim();
        s = s.replace(FUNCTION_VERB_PATTERN, m => FUNCTION_VERB_FORMS[m.toLowerCase()] || m);
        return s.replace(/\s+/g, ' ').trim();
    },

    /**
     * Demo-mode fixture ONLY.
     *
     * This is the function restated as a failure, which is the textbook bad FF.
     * It is acceptable in the keyless demo path, where there is no real analysis
     * for it to be confused with and the rows are flagged needsReview. It must
     * never be used to paper over a rejected generation on a real run — see
     * cleanFunctionalFailureText for what that cost.
     */
    fallbackFunctionalFailure(row?: { function?: string; standard?: string }): string {
        const fn = this.normalizeFunctionPhraseForFailure(row?.function || 'perform required function');
        const standard = this.cleanSingleFieldText(row?.standard || '');
        const combined = standard && !fn.toLowerCase().includes(standard.toLowerCase())
            ? `${fn} ${standard}`
            : fn;
        return `Fails to ${combined}`.replace(/\s+/g, ' ').trim();
    },

    /**
     * Clean a generated functional failure, or reject it.
     *
     * Returns null when the text is unusable. It used to return a template built
     * from the row instead, and that was the single most damaging line in the
     * generation chain:
     *
     *   - The template is the function with "Fails to" glued on the front, which
     *     is exactly the FMECA error the rest of these rules exist to prevent.
     *     When generation broke, the output did not degrade toward nothing, it
     *     degraded toward a confident wrong answer.
     *   - It reads as real work. Right values, right register, grammatical. It is
     *     optimised for surviving review, which is the opposite of what a failure
     *     signal should do.
     *   - Every reject for one row produced the SAME string, so the later dedupe
     *     collapsed them to one. A row that lost three of four failures looked
     *     like a row that only had two.
     *   - Substitution happens after _withRetry, so a rejected generation looked
     *     like a successful call and nothing retried.
     *
     * The old accept test was an allowlist of eight openings, which only covered
     * total and partial loss. Every excess-side, erratic, and containment-leak
     * wording the failed-state rules ask for was rejected on arrival. The test is
     * now inverted: reject text that is a failure MODE, a cause, or an effect,
     * and accept anything that states unmet performance however it opens.
     */
    cleanFunctionalFailureText(text: string, _row?: { function?: string; standard?: string }): string | null {
        let s = this.cleanSingleFieldText(text);
        const leakPattern = /\b(?:wait|let me|i need|i should|i think|i will|reconsider|analysis|reasoning|scratchpad|thought process|internal note|actually)\b/i;
        if (leakPattern.test(s)) {
            const candidates = Array.from(s.matchAll(/\b(?:Fails to|Unable to|Does not|Provides insufficient|Provides excessive|Delivers|Supplies|Operates|Leaks|Releases|Performs)\b[^.;!?]*/gi))
                .map(m => this.cleanSingleFieldText(m[0]))
                .filter(Boolean);
            s = candidates.length ? candidates[candidates.length - 1] : '';
        }
        s = s
            .replace(/^(?:here(?:'s| is)|the functional failure is|functional failure)\s*[:\-]?\s*/i, '')
            .replace(/\b(?:wait|let me|i need|i should|i think|i will|reconsider|analysis|reasoning|scratchpad|thought process|internal note|actually)\b.*$/i, '')
            .replace(/\s+/g, ' ')
            .trim();

        if (!s || leakPattern.test(s)) return null;
        const words = s.split(/\s+/).filter(Boolean);
        if (words.length < 3 || words.length > 22) return null;

        // A cause explains why; a functional failure states what was not achieved.
        if (/\b(?:due to|because of|caused by|resulting from|as a result of|owing to)\b/i.test(s)) return null;
        // An effect or a maintenance action is a later column, not this one.
        if (/\b(?:production loss|downtime|requires? (?:repair|replacement|inspection)|inspection|preventive maintenance|pm task|mitigation|recommend(?:ed|ation)?)\b/i.test(s)) return null;
        // A bare mechanism with no statement of unmet performance is a failure mode.
        if (/^(?:seized|worn|cracked|ruptured|corroded|eroded|contaminated|misaligned|blocked|restricted|stuck|fouled|leaking|broken|loose|damaged)\b/i.test(s)) return null;

        return s;
    },

    /**
     * Normalise the parameters parsed out of a performance standard.
     *
     * A parameter with no name or no value cannot be enumerated against, so it
     * is dropped rather than carried as an empty slot that later reads as a
     * coverage gap. The bound falls back to "target" — the permissive choice,
     * which asks about both directions — because guessing "min" would silently
     * suppress the excess-side failure.
     */
    cleanStandardParameters(raw: unknown): StandardParameter[] {
        if (!Array.isArray(raw)) return [];
        const validBounds: StandardParameter['bound'][] = ['min', 'max', 'target', 'range', 'spec'];
        const seen = new Set<string>();
        return raw
            .map((p: any) => {
                const name = this.cleanSingleFieldText(String(p?.name ?? '')).toLowerCase();
                const value = this.cleanSingleFieldText(String(p?.value ?? ''));
                const unitRaw = this.cleanSingleFieldText(String(p?.unit ?? ''));
                const claimed = String(p?.bound ?? '').toLowerCase().trim() as StandardParameter['bound'];
                // Models routinely answer { value: "130 psig (9 barg)", unit: "psig" },
                // and the chip then renders "130 psig (9 barg) psig". The value is the
                // authoritative text, so drop a unit it already carries.
                //
                // Token-wise, not a \b-anchored regex and not a plain substring.
                //
                // \b needs a word character on the boundary, so every symbol unit failed
                // that test: "40%" with unit "%" rendered "40% %". A plain includes()
                // fixes those but still misses the composite units models emit against a
                // dual-unit value -- a live run returned { value: "130 psig (9 barg)",
                // unit: "psig (barg)" } and rendered "130 psig (9 barg) psig (barg)".
                // So: the unit is redundant when every one of its meaningful tokens is
                // already somewhere in the value.
                const unit = unitRaw && unitRaw.toLowerCase() !== 'null' ? unitRaw : null;
                const unitTokens = unit ? (unit.toLowerCase().match(/[\p{L}\p{N}%°]+/gu) ?? []) : [];
                const lowerValue = value.toLowerCase();
                const unitRedundant = Boolean(unit) && (
                    unitTokens.length > 0
                        ? unitTokens.every(t => lowerValue.includes(t))
                        : lowerValue.includes(unit!.toLowerCase())
                );
                return {
                    name,
                    value,
                    unit: unitRedundant ? null : unit,
                    bound: validBounds.includes(claimed) ? claimed : 'target',
                };
            })
            .filter(p => {
                if (!p.name || !p.value) return false;
                if (seen.has(p.name)) return false;
                seen.add(p.name);
                return true;
            });
    },

    cleanBreakdownRow(row: { function: string; standard: string; snippet: string; functionClass?: string; quantified?: boolean; evidence?: string; standardParameters?: unknown }): { function: string; standard: string; snippet: string; functionClass: FunctionClass; quantified: boolean; evidence: 'evident' | 'hidden'; standardParameters: StandardParameter[] } {
        const fn = this.normalizeFunctionPhraseForFailure(row.function);
        const standard = this.cleanSingleFieldText(row.standard)
            .replace(/^(?:to|and)\s+/i, '')
            .replace(/\s+/g, ' ')
            .trim();
        const validClasses: FunctionClass[] = ['primary', 'containment', 'protection', 'control', 'support', 'efficiency'];
        const claimedClass = String(row.functionClass || '').toLowerCase().trim() as FunctionClass;
        const standardParameters = this.cleanStandardParameters(row.standardParameters);
        return {
            function: fn,
            standard,
            snippet: this.cleanSingleFieldText(row.snippet || row.function),
            functionClass: validClasses.includes(claimedClass) ? claimedClass : 'primary',
            // Trust a digit in the standard over the model's own claim — JA1011 5.1.2
            // asks for a measurable standard, and "quantified: true" on prose is worthless.
            // A parsed parameter also counts: "instrument grade" carries no digit but is
            // a real, auditable requirement.
            quantified: /\d/.test(standard) || standardParameters.some(p => /\d/.test(p.value)),
            evidence: String(row.evidence || '').toLowerCase().trim() === 'hidden' ? 'hidden' : 'evident',
            standardParameters,
        };
    },

    normalizeFailureModeKey(text: string): string {
        return String(text || '')
            .toLowerCase()
            .replace(/["'`]/g, '')
            .replace(/\b(?:failure|mode|fault|issue|problem|the|a|an|of|to|from|with|and|or|system|subsystem)\b/g, ' ')
            .replace(/[^a-z0-9]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    },

    occurrenceScoreFromSystemModeCount(count: number, maxCount: number, rank: number, totalModes: number): number {
        let score = count >= 100 ? 10
            : count >= 50 ? 9
            : count >= 21 ? 8
            : count >= 11 ? 7
            : count >= 6 ? 6
            : count >= 4 ? 5
            : count >= 2 ? 4
            : count >= 1 ? 3
            : 2;
        const topQuintileRank = Math.max(1, Math.ceil(totalModes * 0.2));
        if (rank === 1 && count >= 5) score = Math.max(score, 7);
        if (rank <= topQuintileRank && count >= 3) score = Math.max(score, 6);
        if (maxCount > 0 && count / maxCount >= 0.75 && count >= 5) score = Math.max(score, 7);
        return Math.min(10, Math.max(1, score));
    },

    findSystemModeOccurrenceEvidence(failureMode: string, cause: string, systemModes?: SystemModeRow[]): SystemModeOccurrenceEvidence | null {
        if (!Array.isArray(systemModes) || systemModes.length === 0) return null;
        const sorted = systemModes
            .map(row => ({ component: String(row?.component || '').trim(), mode: String(row?.mode || '').trim(), count: Number(row?.count) || 0 }))
            .filter(row => row.mode)
            .sort((a, b) => b.count - a.count);
        if (!sorted.length) return null;

        const target = this.normalizeFailureModeKey(failureMode);
        const causeKey = this.normalizeFailureModeKey(cause);
        const targetTokens = new Set(target.split(' ').filter(t => t.length > 2));
        const maxCount = sorted[0]?.count || 0;
        let best: { row: SystemModeRow; rank: number; score: number; matchType: SystemModeOccurrenceEvidence['matchType'] } | null = null;

        sorted.forEach((row, idx) => {
            const key = this.normalizeFailureModeKey(row.mode);
            if (!key || !target) return;
            let score = 0;
            let matchType: SystemModeOccurrenceEvidence['matchType'] = 'token-overlap';
            if (key === target) {
                score = 100;
                matchType = 'exact';
            } else if (key.includes(target) || target.includes(key)) {
                score = 80;
                matchType = 'contains';
            } else {
                const modeTokens = key.split(' ').filter(t => t.length > 2);
                const overlap = modeTokens.filter(t => targetTokens.has(t)).length;
                const causeOverlap = causeKey ? modeTokens.filter(t => causeKey.includes(t)).length : 0;
                const denom = Math.max(1, Math.min(modeTokens.length, targetTokens.size));
                score = Math.round((overlap / denom) * 60) + Math.min(causeOverlap * 5, 15);
            }
            if (score < 35) return;
            if (!best || score > best.score || (score === best.score && row.count > best.row.count)) {
                best = { row, rank: idx + 1, score, matchType };
            }
        });

        if (!best) return null;
        return {
            component: best.row.component,
            mode: best.row.mode,
            count: best.row.count,
            rank: best.rank,
            totalModes: sorted.length,
            maxCount,
            occurrenceScore: this.occurrenceScoreFromSystemModeCount(best.row.count, maxCount, best.rank, sorted.length),
            matchType: best.matchType,
        };
    },

    confidenceFromRpnInputs(effect: string, cause: string, currentControls: string, mitigation: string, systemModeEvidence: SystemModeOccurrenceEvidence | null): 'high' | 'medium' | 'low' {
        let points = 0;
        if (/Local:\s*.+;\s*End:\s*.+/i.test(effect)) points += 2;
        else if (effect.trim()) points += 1;
        if (cause.trim() && !/^(unknown|n\/a|none|aging|wear|failure)$/i.test(cause.trim())) points += 1;
        if (currentControls.trim()) points += 1;
        if (mitigation.trim()) points += 1;
        if (systemModeEvidence) points += 2;
        return points >= 6 ? 'high' : points >= 3 ? 'medium' : 'low';
    },

    cleanNumberedActionList(text: string): string {
        const lines = (text || '')
            .replace(/```[a-zA-Z]*\s*/g, '')
            .replace(/```/g, '')
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean);

        const actions: string[] = [];
        let sawList = false;
        for (const line of lines) {
            const numbered = line.match(/^\d+\s*[-–.)]\s*(.+)$/);
            const bulleted = line.match(/^[-*•]\s*(.+)$/);
            if (numbered || bulleted) {
                sawList = true;
                actions.push((numbered?.[1] || bulleted?.[1] || '').trim());
                continue;
            }
            if (sawList && actions.length) {
                if (/^(based on|here(?:\s+are|\s+is)?|these|note|summary|in summary|from my|i found|the following)\b/i.test(line)) break;
                actions[actions.length - 1] = `${actions[actions.length - 1]} ${line}`.trim();
            }
        }

        if (!actions.length) return '';
        return actions.map((action, i) => {
            const cleaned = action
                .replace(/^(?:existing|current)\s+controls?\s*[:\-]?\s*/i, '')
                .replace(/\s+/g, ' ')
                .trim();
            return `${i + 1}- ${cleaned}`;
        }).join('\n');
    },

    /**
     * Post-processing only — it changes nothing about which controls the model decides to
     * report, it just stops a null answer from landing in the field as text.
     *
     * The prompt asks for the `<no_evidence/>` marker. A tag shape cannot occur inside a
     * genuine control line, so it is safe to match anywhere in the reply even when the model
     * wraps it in commentary — unlike a bare word such as NONE, which occurs naturally in
     * control text ("no-flow alarm", "none installed"). A model that narrates the absence
     * instead usually wraps it in the numbered format it was also given, which
     * `cleanNumberedActionList` would otherwise keep, so that shape is caught too.
     */
    cleanControlsList(text: string): string {
        if (/<\s*no_evidence\s*\/?\s*>/i.test(text || '')) return '';
        const cleaned = this.cleanNumberedActionList(text);
        const lines = cleaned.split('\n').filter(Boolean);
        if (!lines.length) return '';
        // A real control names a tag or an owning team; a narrated null answer names neither.
        const looksLikeControl = (l: string) => /\[Tag:/i.test(l) || /\([^)]*team\)/i.test(l);
        // Anchored to the start of the line so an action that merely contains "no" —
        // "Verify no blockage in strainer" — is never mistaken for a null answer.
        const readsAsNothingFound = (l: string) =>
            /^\d+-\s*(?:none|n\/a)\b[\s.]*$/i.test(l) ||
            /^\d+-\s*(?:none|no|not|nothing|n\/a)\b[^\n]*\b(?:control|controls|barrier|barriers|evidence|task|tasks|match|matched|matching|found|identified|applicable|available|documented|listed|deployed|specified)\b/i.test(l);
        const isNullLine = (l: string) => !looksLikeControl(l) && readsAsNothingFound(l);
        return lines.every(isNullLine) ? '' : cleaned;
    },

    // -------------------------------------------------------------------------
    // FEATURE IMPLEMENTATIONS (Refactored to use contract)
    // -------------------------------------------------------------------------

    async generate(prompt: string, currentText: string, key: string, modelName: string, mode: string = 'ai', refText: string = '', contextData: ContextData = {}, aiProvider: string = '', azureEndpoint: string = '', systemContext: string = '', powerAutomateUrl: string = '', sessionId?: string): Promise<string> {
        if ((!key || key.length < 10) && aiProvider !== 'copilot') { await new Promise(r => setTimeout(r, 600)); const wc = currentText ? currentText.trim().split(/\s+/).filter(Boolean).length : 0; return currentText && wc > 5 ? currentText + " [Enhanced]" : currentText && wc > 0 ? currentText + " [Spell-checked]" : "AI Suggested Text"; }

        const fieldLabel = prompt || "text";
        const lowerLabel = fieldLabel.toLowerCase();
        let corePrompt = "";

        const wordCount = currentText ? currentText.trim().split(/\s+/).filter(Boolean).length : 0;
        const isFunctionalFailureField = lowerLabel.includes("functional failure");
        const isFailureModeField = lowerLabel.includes("failure mode") || lowerLabel === "mode";
        const isEffectField = lowerLabel.includes("effect");
        const isCauseField = lowerLabel.includes("cause");
        const isFunctionDescriptionField = lowerLabel.includes("function") && !isFunctionalFailureField;
        const isFMECAContentField = isFunctionDescriptionField || isFunctionalFailureField || isFailureModeField || isEffectField || isCauseField;
        const failureContext = `Context:
- System: "${contextData.project || 'Unknown'}"
- Subsystem: "${contextData.subsystem || 'Unknown'}"
- Specs: "${contextData.specs || 'N/A'}"
- Subsystem Function: "${(contextData as any).subsystemFunction || (contextData as any).function || 'Unknown'}"
- Functional Failure: "${contextData.functionalFailure || 'Unknown'}"
- Failure Mode: "${contextData.failureMode || 'Unknown'}"
- Effect: "${contextData.failureEffect || 'Unknown'}"
- Cause: "${contextData.failureCause || 'Unknown'}"`;
        const siblingBlock = buildSiblingFailureModeBlock((contextData as any).siblingFailureModes);

        // --- CURRENT CONTROLS SPECIALIST ---
        // Evidence only: current controls are already deployed checklist tasks or
        // instrument/protection controls from the loaded knowledge files.
        if (lowerLabel.includes("current controls")) {
            const checklistContent = (contextData.checklistText as string) ?? '';
            const hasKnowledge = (mode === 'file' || mode === 'hybrid') && (checklistContent.trim() || refText.trim());
            if (!hasKnowledge) return currentText || '';
            const existingNote = currentText?.trim() ? `Current field text to revise against the checklist:\n"""${currentText}"""\n` : '';
            const checklistBlock = checklistContent.trim()
                ? `PM CHECKLIST KNOWLEDGE (plant's EXISTING PM program, organized by team and interval):\n"""\n${checklistContent}\n"""\n\n`
                : '';
            const referenceBlock = refText.trim()
                ? `REFERENCE DATA (deployed equipment, instruments, alarms, trips, interlocks, limits):\n"""\n${refText}\n"""\n\n`
                : '';
            const controlsPrompt = `${referenceBlock}${checklistBlock}${failureContext}${siblingBlock}
${existingNote}Task: List ONLY existing controls that are currently deployed for THIS failure mode.
${FMECA_HIERARCHY_RULES}
${FMECA_CONCISE_WORDING_RULES}
Include:
- Relevant PM/checklist tasks that directly prevent the stated cause, detect the stated cause, detect this mode's specific failure signature, or limit the stated effect. Use the checklist section name as owner.
- Deployed instrument/protection controls from the reference data, such as temperature, pressure, level, flow, vibration, speed, differential pressure, alarms, trips, interlocks, shutdowns, transmitters, switches, or monitoring points. Include tag numbers and alarm/trip limits when stated. Use (Instrument team) for instrument controls unless the source states another owner.
Rules:
- Match controls to THIS Functional Failure + Failure Mode + Cause + Effect only.
- Do NOT include tasks for sibling failure modes in the checklist.
- Do NOT invent controls, tags, setpoints, alarms, trips, or tasks.
- Do NOT include recommendations, upgrades, "install", "add", or "consider" actions.
- If nothing is evidenced for this failure mode, reply with exactly <no_evidence/> and nothing else. Do not describe the absence in words.
${FAILURE_MODE_BARRIER_FILTER}
Output contract:
- Return ONLY numbered lines. Use "1- [Tag: TAGNO (limit if stated)] (Owner)" for tag-only controls, or "1- Action description [Tag: TAGNO (limit if stated)] (Owner)" when task text is needed.
- Never write the words "Existing control".
- No introduction, no summary, no "based on", no "here are", no reference/source commentary, no markdown.`;
            const controlsOutputContract = `FINAL OUTPUT CONTRACT:
- Return ONLY numbered lines. Use "1- [Tag: TAGNO (limit if stated)] (Owner)" for tag-only controls, or "1- Action description [Tag: TAGNO (limit if stated)] (Owner)" when task text is needed.
- Never write the words "Existing control".
- No introduction, no summary, no "based on", no "here are", no reference/source commentary, no markdown.`;
            const controlsContent = controlsPrompt + '\n\n' + controlsOutputContract;
            const controlsRes = await this.chat({
                feature: 'field-generation',
                provider: (aiProvider || inferProvider(key)) as any,
                azureEndpoint: azureEndpoint || undefined,
                powerAutomateUrl: powerAutomateUrl || undefined,
                sessionId,
                model: modelName,
                messages: [{ role: 'user', content: controlsContent }],
                mode: 'ai',
                apiKey: key,
                responseFormat: 'text'
            });
            return this.cleanControlsList(controlsRes);
        }
        // --- END CURRENT CONTROLS SPECIALIST ---

        if (!isFMECAContentField && currentText && wordCount > 0 && wordCount <= 5) {
            return this.chat({
                feature: 'field-generation',
                provider: (aiProvider || inferProvider(key)) as any,
                azureEndpoint: azureEndpoint || undefined,
                powerAutomateUrl: powerAutomateUrl || undefined,
                sessionId,
                model: modelName,
                messages: [{ role: 'user', content: `Fix only the grammar and spelling of the following text. Return only the corrected text with no explanations or changes to meaning. Original: """${currentText}"""` }],
                mode: 'ai',
                apiKey: key,
                responseFormat: 'text'
            });
        }

        // --- MITIGATION SPECIALIST ---
        if (lowerLabel.includes("mitigation")) {
            const d = (contextData.detectionScore as number) ?? 5;
            const checklistContent = (contextData.checklistText as string) ?? '';
            const count = d >= 7 ? '4-6' : d >= 4 ? '3-4' : '2-3';
            const detectionNote = d >= 7
                ? `Detection score is HIGH (D=${d}/10). Prioritize adding monitoring instruments and detection barriers to reduce this score.`
                : d <= 3
                ? `Detection is already good (D=${d}/10). Focus on preventive maintenance actions.`
                : `Detection score is moderate (D=${d}/10). Balance preventive tasks with detection controls.`;
            const ownerRules = `Owner assignment (add team in parentheses after each action):\n- Sensor, transmitter, switch, monitor, level/pressure/vibration/flow tag → (Instrument team)\n- Lubrication, alignment, bearing, seal, coupling, mechanical inspection → (Mechanical team)\n- Control system, PLC, SCADA, interlock, delay, communication → (Automation team)\n- Operational round, manual monitoring, log, operator check → (Operation team)`;
            const formatRule = `Output contract:
- Return ONLY numbered lines in this exact form: "1- Action description [Tag: TAGNO (Hi: X unit, Hi-Hi: Y unit) if applicable] (Owner)".
- No introduction, no summary, no "based on", no "here are", no reference/source commentary, no markdown.`;
            const existingNote = currentText?.trim() ? `Existing mitigations to enhance and expand:\n"""${currentText}"""\n` : '';
            const controlsCovered = (contextData.currentControls as string)?.trim()
                ? `CURRENT CONTROLS already in place (these failure aspects are COVERED — do NOT recommend them again; recommend only actions that close the remaining gaps):\n"""\n${(contextData.currentControls as string).trim()}\n"""\n` : '';
            let mitigationPrompt: string;
            if (mode === 'file' || mode === 'hybrid') {
                const refSection = refText?.trim() ? `REFERENCE DATA (P&IDs, datasheets, safeguarding instruments with tag numbers and alarm limits):\n"""\n${refText}\n"""\n\n` : '';
                const checkSection = checklistContent?.trim() ? `PM CHECKLIST KNOWLEDGE (organized by team and PM interval):\n"""\n${checklistContent}\n"""\n\n` : '';
                mitigationPrompt = `${refSection}${checkSection}${failureContext}${siblingBlock}
Mitigation wand rule: File-only and Hybrid settings both act as Hybrid here: use loaded knowledge first, then add reliability-engineering actions for remaining gaps.
${FMECA_HIERARCHY_RULES}
${FMECA_CONCISE_WORDING_RULES}
${detectionNote}
${controlsCovered}${existingNote}
Generate ${count} mitigation actions for THIS failure mode using this priority:
1. Extract PM tasks or controls recommended/evidenced in CHECKLIST KNOWLEDGE or REFERENCE DATA that close gaps in THIS failure mode's stated cause/effect chain and are NOT already listed in current controls.
2. If reference data shows available safeguarding instruments (tags like VXIT, PT, TT, LT/LE, FIT, vibration, speed, pressure, temperature, level, flow), recommend using, alarming, testing, calibrating, or adding logic for them only when they detect/prevent this exact cause, detect this mode's signature, or limit this effect, and only when not already covered by current controls.
3. Add reliability-knowledge mitigations only for remaining gaps, especially when D > 6.
Rules:
- Never duplicate an action already covered by current controls.
- Do NOT bring tasks for sibling failure modes.
- Mitigation is proposed work, not existing current controls.
${FAILURE_MODE_BARRIER_FILTER}
${ownerRules}
${formatRule}`;
            } else {
                mitigationPrompt = `${failureContext}${siblingBlock}
${FMECA_HIERARCHY_RULES}
${FMECA_CONCISE_WORDING_RULES}
${detectionNote}
${controlsCovered}${existingNote}
Generate ${count} maintenance mitigation actions for THIS failure mode using reliability engineering knowledge. Never duplicate an action already covered by current controls. Do NOT bring tasks for other failure modes.
${FAILURE_MODE_BARRIER_FILTER}
${ownerRules}
${formatRule}`;
            }
            const mitigationContent = mitigationPrompt + '\n\n' + formatRule.replace('Output contract:', 'FINAL OUTPUT CONTRACT:');
            const mitigationRes = await this.chat({
                feature: 'field-generation',
                provider: (aiProvider || inferProvider(key)) as any,
                azureEndpoint: azureEndpoint || undefined,
                powerAutomateUrl: powerAutomateUrl || undefined,
                sessionId,
                model: modelName,
                messages: [{ role: 'user', content: mitigationContent }],
                mode: 'ai',
                refText: '',
                contextData,
                apiKey: key,
                responseFormat: 'text'
            });
            return this.cleanNumberedActionList(mitigationRes);
        }
        // --- END MITIGATION SPECIALIST ---

        if (currentText && (wordCount > 5 || isFMECAContentField)) {
            if (isFunctionDescriptionField) {
                corePrompt = `Context: System "${contextData.project || 'Unknown'}", Subsystem "${contextData.subsystem}", Specs "${contextData.specs || 'N/A'}".
                ${buildSystemDescriptionBlock((contextData as any).projectDescription)}
                ${buildSiblingSubsystemBlock((contextData as any).siblingSubsystems, 'functions')}
                The user wrote this Function Description: """${currentText}"""
                Task: Rewrite and enhance it as a proper Function Description.
                ${FMECA_HIERARCHY_RULES}
                ${FMECA_CONCISE_WORDING_RULES}
                ${FUNCTION_DESCRIPTION_TECHNICAL_RULES}
                Preserve the user's core meaning and any specific values they provided.
                Output strictly the description text only.`;
            } else if (isFunctionalFailureField) {
                corePrompt = `${failureContext}
                The user wrote this Functional Failure: """${currentText}"""
                Task: Rewrite it as ONE professional Functional Failure.
                ${FMECA_HIERARCHY_RULES}
                ${FMECA_CONCISE_WORDING_RULES}
                ${FUNCTIONAL_FAILURE_TECHNICAL_RULES}
                If the user's text is a physical mechanism, cause, effect, alarm, trip, or task, convert it to the required performance not achieved when context supports that conversion.
                Output strictly the Functional Failure text only.`;
            } else if (isFailureModeField) {
                corePrompt = `${failureContext}
                The user wrote this Failure Mode: """${currentText}"""
                Task: Rewrite it as ONE concise Failure Mode.
                ${FMECA_HIERARCHY_RULES}
                ${FMECA_CONCISE_WORDING_RULES}
                ${FAILURE_MODE_TECHNICAL_RULES}
                Output strictly the Failure Mode text only.`;
            } else if (isEffectField) {
                corePrompt = `${failureContext}
                The user wrote this Effect: """${currentText}"""
                Task: Rewrite it as ONE concise Failure Effect.
                ${FMECA_HIERARCHY_RULES}
                ${FMECA_CONCISE_WORDING_RULES}
                ${FAILURE_MODE_TECHNICAL_RULES}
                Format exactly: "Local: <subsystem consequence>; End: <system consequence>".
                Output strictly the Failure Effect text only.`;
            } else if (isCauseField) {
                corePrompt = `${failureContext}
                The user wrote this Cause: """${currentText}"""
                Task: Rewrite it as ONE concise Failure Cause.
                ${FMECA_HIERARCHY_RULES}
                ${FMECA_CONCISE_WORDING_RULES}
                ${FAILURE_MODE_TECHNICAL_RULES}
                Output strictly the Failure Cause text only.`;
            } else if (lowerLabel.includes("spec")) {
                corePrompt = `Context: System "${contextData.project || 'Unknown'}", Subsystem "${contextData.subsystem}", Subsystem Function: "${(contextData as any).subsystemFunction || 'Unknown'}".
                ${buildSiblingSubsystemBlock((contextData as any).siblingSubsystems)}
                The user wrote these specifications: """${currentText}"""
                Task: Rewrite and enhance them in the correct format.
                Format: Comma-separated list of "Key: Value Unit".
                Example: Power: 400 W, Voltage: 415 V, Speed: 3590 RPM, Material: SS316, Protection: IP55.
                ${SPECS_BOUNDARY_RULES}
                Precedence: the user's own text is always preserved, even where it looks package-level or exceeds the pair limit. The boundary rules above restrict only what you may ADD from reference data or context.
                Requirements: Preserve all values the user provided. Do not add values, ratings, materials, limits, or equipment details not present in the user's text. Keep it technical and concise. Do not include the word "Specs:" at the start.
                Output strictly the specifications text only.`;
            } else {
                corePrompt = `Context: System "${contextData.project || 'Unknown'}", Subsystem "${contextData.subsystem}".
                The user wrote the following for the field "${fieldLabel}": """${currentText}"""
                Task: Rewrite and enhance this as ONE concise phrase for the field "${fieldLabel}" from a reliability engineering perspective.
                Requirements:
                1. Return ONLY the field value — no prefixes, no labels, no explanations, no discussion.
                2. Preserve the user's core meaning and any specific technical details.
                3. Use proper reliability engineering terminology.
                Output strictly the field value only.`;
            }
        } else {
            if (isFunctionDescriptionField) {
                corePrompt = `Context: System "${contextData.project || 'Unknown'}", Subsystem "${contextData.subsystem}", Specs "${contextData.specs || 'N/A'}".
                ${buildSystemDescriptionBlock((contextData as any).projectDescription)}
                ${buildSiblingSubsystemBlock((contextData as any).siblingSubsystems, 'functions')}
                Task: Write a Function Description for the subsystem "${contextData.subsystem}".
                ${FMECA_HIERARCHY_RULES}
                ${FMECA_CONCISE_WORDING_RULES}
                ${FUNCTION_DESCRIPTION_TECHNICAL_RULES}
                Output strictly the description text only.`;
            } else if (isFunctionalFailureField) {
                corePrompt = `${failureContext}
                Task: Write ONE Functional Failure for this subsystem context.
                ${FMECA_HIERARCHY_RULES}
                ${FMECA_CONCISE_WORDING_RULES}
                ${FUNCTIONAL_FAILURE_TECHNICAL_RULES}
                Output strictly the Functional Failure text only.`;
            } else if (isFailureModeField) {
                corePrompt = `${failureContext}
                Task: Write ONE Failure Mode that results in this Functional Failure.
                ${FMECA_HIERARCHY_RULES}
                ${FMECA_CONCISE_WORDING_RULES}
                ${FAILURE_MODE_TECHNICAL_RULES}
                Output strictly the Failure Mode text only.`;
            } else if (isEffectField) {
                corePrompt = `${failureContext}
                Task: Write ONE concise Failure Effect for this Failure Mode.
                ${FMECA_HIERARCHY_RULES}
                ${FMECA_CONCISE_WORDING_RULES}
                ${FAILURE_MODE_TECHNICAL_RULES}
                Format exactly: "Local: <subsystem consequence>; End: <system consequence>".
                Output strictly the Failure Effect text only.`;
            } else if (isCauseField) {
                corePrompt = `${failureContext}
                Task: Write ONE concise Failure Cause for this Failure Mode.
                ${FMECA_HIERARCHY_RULES}
                ${FMECA_CONCISE_WORDING_RULES}
                ${FAILURE_MODE_TECHNICAL_RULES}
                Output strictly the Failure Cause text only.`;
            } else if (lowerLabel.includes("spec")) {
                corePrompt = `Context: System "${contextData.project || 'Unknown'}", Subsystem "${contextData.subsystem}", Subsystem Function: "${(contextData as any).subsystemFunction || 'Unknown'}".
                ${buildSiblingSubsystemBlock((contextData as any).siblingSubsystems)}
                Task: Generate the technical specifications of the subsystem "${contextData.subsystem}" only.
                Format: Comma-separated list of "Key: Value Unit".
                Example: Power: 400 W, Voltage: 415 V, Speed: 3590 RPM, Material: SS316, Protection: IP55.
                ${SPECS_BOUNDARY_RULES}
                Requirements: Use only values, ratings, materials, limits, or equipment details already present in the project context or reference data. Do not extract or restate the full contents of the reference data. Keep it technical and concise. Do not include the word "Specs:" at the start.
                Output strictly the specifications text only.`;
            } else if (lowerLabel.includes("subsystem")) {
                corePrompt = `Context: System "${contextData.project || 'Unknown'}".
                Task: Suggest a Subsystem Name logically related to this System (e.g., if System is Boiler, Subsystem could be Feed Water Pump).
                Output: One short name only. No prefixes.`;
            } else {
                corePrompt = `Context: System "${contextData.project || 'Unknown'}", Subsystem "${contextData.subsystem}".
                Task: Write ONE concise phrase filling the field "${fieldLabel}". Reliability perspective.
                Constraint: Return ONLY the value. No prefixes, no labels.`;
            }
        }

        const content = corePrompt + (isFailureModeField && systemContext
            ? `\n\n${OPERATIONAL_HISTORY_GUIDANCE_RULES}\n\n${systemContext}`
            : '');

        const generated = await this.chat({
            feature: 'field-generation',
            provider: (aiProvider || inferProvider(key)) as any,
            azureEndpoint: azureEndpoint || undefined,
            powerAutomateUrl: powerAutomateUrl || undefined,
            sessionId,
            model: modelName,
            messages: [{ role: 'user', content: content }],
            mode: mode as 'ai'|'file'|'hybrid',
            refText,
            contextData,
            apiKey: key,
            responseFormat: 'text'
        });
        // This is the single-field wand behind a text box the user is editing. A
        // rejected clean leaves the box untouched rather than writing a template
        // into it — the user asked for a suggestion, not a placeholder.
        if (isFunctionalFailureField) return this.cleanFunctionalFailureText(generated) ?? '';
        // Specs was the only text field with no cleaner, so fences, bold markers and a
        // "Specs:" prefix reached state, the Excel cell, the map view, and every
        // downstream prompt that interpolates it.
        if (isFMECAContentField || lowerLabel.includes("spec")) return this.cleanSingleFieldText(generated);
        return generated;
    },

    async generateMasterStructure(sysName: string, sysDesc: string, key: string, modelName: string, mode: string, refText: string, aiProvider: string = '', azureEndpoint: string = '', systemContext: string = '', powerAutomateUrl: string = '', sessionId?: string): Promise<any> {
        // An empty list here reads to MasterGen as "generation failed", so demo
        // mode could never reach a generated FMECA. A handful of named skeletons
        // lets the keyless path run the same pool and the same five steps.
        if((!key || key.length < 10) && aiProvider !== 'copilot') {
            await new Promise(r => setTimeout(r, 1200));
            return ['Drive Unit', 'Lubrication System', 'Cooling System', 'Control & Protection'].map(name => ({
                name,
                specs: `Simulated specs for ${name} in "${sysName || 'the system'}"`,
                func: ''
            }));
        }
        // Skeletons only — function, failures and modes are generated by the
        // dedicated downstream steps in masterGen; anything more here is discarded.
        const corePrompt = `Act as Senior Reliability Engineer. Analyze System "${sysName}" (${sysDesc}).
        ${FMECA_HIERARCHY_RULES}
        ${FMECA_CONCISE_WORDING_RULES}
        Identify the critical Subsystems for a formal FMECA. Scale the count to the system's complexity and criticality (simple package: 3-4, complex train: up to 8).
        For each subsystem, generate 'specs' using format "Key: Value Unit, Key: Value Unit" only when exact specs are present in the system description or reference data. Do not invent realistic values. If no exact specs are available for a subsystem, return an empty string for specs.
        Output strictly valid JSON object:
        { "subsystems": [ {
            "name": "string (Subsystem Name)",
            "specs": "string (Key: Value Unit, ...)"
        } ] }`;

        const content = corePrompt + (systemContext
            ? '\n\nOperational component catalog may guide subsystem boundaries and names only. It must not create specifications or failure-mode wording.\n\n' + systemContext
            : '');

        try {
            const res = await this.chat({
                feature: 'master-structure',
                provider: (aiProvider || inferProvider(key)) as any,
                azureEndpoint: azureEndpoint || undefined,
                powerAutomateUrl: powerAutomateUrl || undefined,
                sessionId,
                model: modelName,
                messages: [{ role: 'user', content: content }],
                mode: mode as 'ai'|'file'|'hybrid',
                refText,
                apiKey: key,
                responseFormat: 'json'
            });
            const parsed = this.extractJSON(res);
            return parsed.subsystems || [];
        } catch(e) { return []; }
    },

    async generateModesForFailure(failDesc: string, subName: string, subSpecs: string, subFunc: string, project: string, key: string, modelName: string, mode: string = 'ai', refText: string = '', aiProvider: string = '', azureEndpoint: string = '', systemContext: string = '', checklistText: string = '', powerAutomateUrl: string = '', existingModes: string[] = [], sessionId?: string): Promise<any[]> {
        // eslint-disable-next-line
        const generateId = () => Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
        if ((!key || key.length < 10) && aiProvider !== 'copilot') { await new Promise(r => setTimeout(r, 1000)); return [{ id: generateId(), mode: "Simulated", effect: "Local: Effect; End: System effect", cause: "Cause", currentControls: "", mitigation: "1- Scheduled inspection (Mechanical team)", rpn: blankGeneratedRpn(), rpnStatus: "unscored" }]; }
        const checklistBlock = (checklistText?.trim() && (mode === 'file' || mode === 'hybrid'))
            ? `PM CHECKLIST KNOWLEDGE (use section names as team owners for mitigation tasks):\n"""\n${checklistText}\n"""\n\n` : '';
        const controlsKnowledgeAvailable = (mode === 'file' || mode === 'hybrid') && (Boolean(checklistText?.trim()) || Boolean(refText?.trim()));
        const existingBlock = existingModes.length > 0
            ? `Failure Modes already defined in this subsystem (DO NOT repeat or closely resemble any of them; reject controls/mitigations that belong more strongly to these sibling modes):\n${existingModes.map((m, i) => `${i + 1}. ${m}`).join('\n')}\n\n` : '';
        // Retry with backoff — bulk generation can hit provider rate limits.
        const MODE_ATTEMPTS = 5;
        const mitigationInstruction = `\n${MODE_ACTION_FORMAT_RULES}`;
        const corePrompt = `${checklistBlock}${existingBlock}Context: System "${project}", Subsystem "${subName}", Specs "${subSpecs}". Function: "${subFunc}". Functional Failure: "${failDesc}".
        Task: Generate 2-3 specific Failure Modes that result in this Functional Failure. Fewer is acceptable if the failure only has one or two credible modes — do not invent filler modes.
        ${buildModeFieldRules(controlsKnowledgeAvailable)}
        Do NOT generate or include RPN/S/O/D values. RPN is scored later by the dedicated RPN scorer.
        Return JSON object: { "modes": [ { "mode": "string", "effect": "string", "cause": "string", "currentControls": "string", "mitigation": "string" } ] }${mitigationInstruction}`;

        const content = corePrompt + (systemContext
            ? `\n\n${OPERATIONAL_HISTORY_GUIDANCE_RULES}\n\n${systemContext}`
            : '');

        let lastErr: any;
        for (let attempt = 1; attempt <= MODE_ATTEMPTS; attempt++) {
            try {
                const res = await this.chat({
                    feature: 'mode-generation',
                    provider: (aiProvider || inferProvider(key)) as any,
                    azureEndpoint: azureEndpoint || undefined,
                    powerAutomateUrl: powerAutomateUrl || undefined,
                    sessionId,
                    model: modelName,
                    messages: [{ role: 'user', content: content }],
                    mode: mode as 'ai'|'file'|'hybrid',
                    refText,
                    apiKey: key,
                    responseFormat: 'json'
                });
                const parsed = this.extractJSON(res);
                // Tolerate alternate shapes some models return (bare array / different key).
                const modes = parsed?.modes ?? parsed?.failure_modes ?? (Array.isArray(parsed) ? parsed : []);
                // Empty result is treated as a transient failure → retry (the prompt always asks for ≥1 mode).
                if (!modes.length) throw new Error('mode-generation: empty result');
                // currentControls require checklist/reference evidence — forced empty otherwise.
                if (!controlsKnowledgeAvailable) modes.forEach((m: any) => { m.currentControls = ''; });
                modes.forEach((m: any) => { m.rpn = blankGeneratedRpn(); m.rpnStatus = 'unscored'; });
                return modes;
            } catch(e) {
                lastErr = e;
                if (attempt < MODE_ATTEMPTS) {
                    const delay = Math.min(2000 * 2 ** (attempt - 1), 20000) + Math.floor(Math.random() * 1000);
                    await new Promise(r => setTimeout(r, delay));
                }
            }
        }
        console.warn('[generateModesForFailure] failed after retries:', lastErr);
        return [];
    },

    async generateFFsForBreakdownRows(args: {
        systemName: string;
        subsystemName: string;
        subsystemSpecs: string;
        funcDesc: string;
        rows: Array<{ id: string; function: string; standard: string; snippet: string; functionClass?: FunctionClass; quantified?: boolean; evidence?: 'evident' | 'hidden'; standardParameters?: StandardParameter[] }>;
        existingFailures: string[];
        key: string;
        modelName: string;
        aiProvider?: string;
        azureEndpoint?: string;
        powerAutomateUrl?: string;
        systemContext?: string;
        sessionId?: string;
        siblingSubsystems?: string[];
    }): Promise<{
        failures: Array<{ rowId: string; desc: string; sourceSnippet?: string; failedState?: FailedStateType; parameter?: string; needsReview?: boolean }>;
        /** Generations thrown away by the cleaner, keyed by rowId. Reported, never replaced with a template. */
        rejected: Array<{ rowId: string; raw: string; reason?: string }>;
    }> {
        const { systemName, subsystemName, subsystemSpecs, funcDesc, rows, existingFailures, key, modelName, aiProvider = '', azureEndpoint = '', powerAutomateUrl = '', systemContext = '', sessionId, siblingSubsystems = [] } = args;
        if (!rows.length) return { failures: [], rejected: [] };
        if ((!key || key.length < 10) && aiProvider !== 'copilot') {
            return {
                failures: rows.map(r => ({ rowId: r.id, desc: this.fallbackFunctionalFailure(r), sourceSnippet: r.snippet, failedState: 'total' as FailedStateType, needsReview: true })),
                rejected: []
            };
        }
        const existingBlock = existingFailures.length > 0
            ? `Existing Functional Failures already defined (DO NOT repeat or closely resemble):\n${existingFailures.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n\n`
            : '';
        const rowBlock = JSON.stringify(rows.map(r => ({
            rowId: r.id,
            function: r.function,
            standard: r.standard,
            standardParameters: r.standardParameters ?? [],
            functionClass: r.functionClass || 'primary',
            evidence: r.evidence || 'evident',
            snippet: r.snippet,
        })), null, 2);

        const prompt = `Context: System "${systemName}", Subsystem "${subsystemName}".
Subsystem Specs: "${subsystemSpecs || 'N/A'}"
Subsystem Function: "${funcDesc}"
${buildSiblingSubsystemBlock(siblingSubsystems, 'functional failures')}
Function breakdown rows:
${rowBlock}

${existingBlock}Task: For EACH breakdown row, judge which failed states that row's own duty can actually reach, and write those. Completeness means every failed state a user would respond to differently; it does not mean every combination of parameter and direction.
${FMECA_HIERARCHY_RULES}
${FMECA_CONCISE_WORDING_RULES}
${FUNCTIONAL_FAILURE_TECHNICAL_RULES}
${JA1011_FAILED_STATE_RULES}
Each row's "standardParameters" is the list of requirements to enumerate against. Where it is empty the standard is qualitative: emit total loss only and do not invent values.
"evidence" tells you how the failure is discovered, not how many failures there are. A hidden row's total loss is written as an on-demand failure and REPLACES the total row; it is not an extra one.
Use the full subsystem function only to resolve ambiguity, not to add extra details.
Write short professional FMECA failure states, not narratives.
Length per failure: 6-14 words.
Repeat the same rowId once per failure generated for that row.

Return ONLY strict JSON. "parameter" names the standardParameters entry the failure violates, or "" when the row has no parameters. "skipped" is OPTIONAL — use it only to record a direction worth showing as deliberately considered and rejected; leaving a combination out of both arrays is not an error:
{
  "failures": [ { "rowId": "same rowId from input", "parameter": "discharge pressure", "failedState": "total|partial|upper_limit|intermittent|on_demand", "desc": "Functional Failure", "sourceSnippet": "source snippet from row" } ],
  "skipped": [ { "rowId": "...", "parameter": "...", "failedState": "...", "reason": "why this direction is not credible here" } ]
}`;

        // systemContext carries the operating philosophy — redundancy, duty, and
        // control behaviour. It used to be accepted and then dropped on the floor
        // here, which is why a standby duty had nothing to establish itself
        // against at the step that decides whether a failure is discovered on
        // demand.
        const content = prompt + (systemContext ? '\n\n' + systemContext : '');

        const validRowIds = new Set(rows.map(r => r.id));
        const validStates: FailedStateType[] = ['total', 'partial', 'upper_limit', 'lower_limit', 'intermittent', 'on_demand'];

        const callOnce = (messages: Array<{ role: string; content: string }>) => this._withRetry(async () => {
            const res = await this.chat({
                feature: 'ff-batch-generation',
                provider: (aiProvider || inferProvider(key)) as any,
                azureEndpoint: azureEndpoint || undefined,
                powerAutomateUrl: powerAutomateUrl || undefined,
                sessionId,
                model: modelName,
                messages: messages as any,
                mode: 'ai',
                refText: '',
                apiKey: key,
                responseFormat: 'json'
            });
            return this.extractJSON(res);
        });

        type Kept = { rowId: string; desc: string; sourceSnippet?: string; failedState?: FailedStateType; parameter?: string };
        const kept: Kept[] = [];
        const rejected: Array<{ rowId: string; raw: string; reason?: string }> = [];
        // Uniqueness is rowId + parameter + failed state. Text alone was wrong in
        // both directions: it let the same state through twice reworded, and — once
        // every reject collapsed to one template string — it deleted the evidence
        // that anything had been lost.
        const seen = new Set<string>();

        const absorb = (parsed: any) => {
            const list = Array.isArray(parsed?.failures) ? parsed.failures : [];
            for (const f of list) {
                const rowId = String(f?.rowId ?? f?.row_id ?? '').trim();
                if (!validRowIds.has(rowId)) continue;
                const raw = String(f?.desc ?? f?.failure ?? f?.functionalFailure ?? '').trim();
                const desc = this.cleanFunctionalFailureText(raw);
                if (!desc) {
                    if (raw) rejected.push({ rowId, raw });
                    continue;
                }
                const claimed = String(f?.failedState ?? f?.failed_state ?? '').toLowerCase().trim() as FailedStateType;
                // "lower_limit" never meant anything distinct from "partial".
                const failedState = claimed === 'lower_limit'
                    ? 'partial'
                    : validStates.includes(claimed) ? claimed : undefined;
                // A failure tagged upper_limit whose text says "below" is not a
                // wording nit: the chip and the sentence disagree, and whichever the
                // reader trusts, the other one is wrong. Send it back to be restated.
                // "under" and "over" only count as direction words when a number follows.
                // Bare "under" is usually conditional -- "fails to shut down under high
                // discharge temperature" is an upper_limit failure that was being rejected
                // as contradictory, burning the repair pass on a correct sentence.
                const saysBelow = /\b(below|insufficient|less than|fails to reach|short of)\b/i.test(desc)
                    || /\bunder\s+[\d.]/i.test(desc);
                const saysAbove = /\b(above|exceeds?|excessive|greater than|beyond|high|excess)\b/i.test(desc)
                    || /\bover\s+[\d.]/i.test(desc);
                if ((failedState === 'upper_limit' && saysBelow && !saysAbove) ||
                    (failedState === 'partial' && saysAbove && !saysBelow)) {
                    rejected.push({ rowId, raw, reason: `text direction contradicts failedState "${failedState}"` });
                    continue;
                }
                const parameter = this.cleanSingleFieldText(String(f?.parameter ?? '')).toLowerCase() || undefined;
                const dedupeKey = `${rowId}|${parameter ?? ''}|${failedState ?? desc.toLowerCase()}`;
                if (seen.has(dedupeKey)) continue;
                seen.add(dedupeKey);
                kept.push({
                    rowId,
                    desc,
                    failedState,
                    parameter,
                    sourceSnippet: String(f?.sourceSnippet ?? f?.source_snippet ?? '').trim(),
                });
            }
        };

        try {
            absorb(await callOnce([{ role: 'user', content }]));

            // One repair pass. Rejects are almost always a wording mismatch rather
            // than a reasoning failure, and the old code could never retry them: it
            // substituted a template after _withRetry had already seen a successful
            // call, so the loss was invisible to the retry logic and to the user.
            //
            // The repair is ONE self-contained user message, not a three-message
            // conversation. _powerAutomateTurn sends only the last user message for
            // any non-chatbot feature, so a repair that relied on the earlier turns
            // would reach Copilot stripped of the breakdown rows it is meant to be
            // repairing — it would arrive as a list of rejected sentences with no
            // idea what they described.
            if (rejected.length) {
                const repairList = rejected
                    .map(r => `- rowId "${r.rowId}"${r.reason ? ` [${r.reason}]` : ''}: ${r.raw}`)
                    .join('\n');
                const repair = `Function breakdown rows:
${rowBlock}

Some functional failures written for these rows were rejected as unusable:

${repairList}

A failure is rejected when it states a cause ("due to", "caused by"), an effect or a maintenance action, or a bare mechanism ("seized", "worn", "leaking") instead of performance that was not achieved; when it runs past 22 words; or when its wording contradicts its failedState.
${FMECA_CONCISE_WORDING_RULES}
${FUNCTIONAL_FAILURE_TECHNICAL_RULES}

Restate ONLY the rejected failures above, as failed states. Keep each one's rowId, parameter, and failedState. Make the wording agree with the failedState: "partial" reads as below or insufficient, "upper_limit" reads as above or exceeds.

These failures are already accepted — do not repeat them and do not add anything new:
${kept.map(k => `- ${k.desc}`).join('\n') || '(none)'}

Return ONLY strict JSON: { "failures": [ { "rowId": "...", "parameter": "...", "failedState": "...", "desc": "...", "sourceSnippet": "..." } ] }`;
                const before = rejected.length;
                const recovered = await callOnce([{ role: 'user', content: repair }]);
                rejected.length = 0;
                absorb(recovered);
                if (rejected.length) console.warn(`[generateFFsForBreakdownRows] ${rejected.length}/${before} still unusable after repair`);
            }

            return { failures: kept, rejected };
        } catch (e) {
            console.warn('[generateFFsForBreakdownRows] failed:', e);
            return { failures: kept, rejected };
        }
    },

    async generateModesForFailuresBatch(args: {
        project: string;
        subName: string;
        subSpecs: string;
        subFunc: string;
        failures: Array<{ id: string; desc: string }>;
        key: string;
        modelName: string;
        mode?: string;
        refText?: string;
        aiProvider?: string;
        azureEndpoint?: string;
        systemContext?: string;
        checklistText?: string;
        powerAutomateUrl?: string;
        existingModes?: string[];
        sessionId?: string;
    }): Promise<{ failures: Array<{ failureId: string; modes: any[] }> }> {
        const { project, subName, subSpecs, subFunc, failures, key, modelName, mode = 'ai', refText = '', aiProvider = '', azureEndpoint = '', systemContext = '', checklistText = '', powerAutomateUrl = '', existingModes = [], sessionId } = args;
        if (!failures.length) return { failures: [] };
        if ((!key || key.length < 10) && aiProvider !== 'copilot') {
            return { failures: failures.map(f => ({ failureId: f.id, modes: [{ mode: "Simulated", effect: "Local: Effect; End: System effect", cause: "Cause", currentControls: "", mitigation: "1- Scheduled inspection (Mechanical team)", rpn: blankGeneratedRpn(), rpnStatus: "unscored" }] })) };
        }
        const checklistBlock = (checklistText?.trim() && (mode === 'file' || mode === 'hybrid'))
            ? `PM CHECKLIST KNOWLEDGE (use section names as team owners for mitigation tasks):\n"""\n${checklistText}\n"""\n\n` : '';
        const controlsKnowledgeAvailable = (mode === 'file' || mode === 'hybrid') && (Boolean(checklistText?.trim()) || Boolean(refText?.trim()));
        const existingBlock = existingModes.length > 0
            ? `Failure Modes already defined in this subsystem (DO NOT repeat or closely resemble any of them; reject controls/mitigations that belong more strongly to these sibling modes):\n${existingModes.map((m, i) => `${i + 1}. ${m}`).join('\n')}\n\n` : '';
        const prompt = `${checklistBlock}${existingBlock}Context: System "${project}", Subsystem "${subName}", Specs "${subSpecs}". Function: "${subFunc}".

Functional Failures to expand:
${JSON.stringify(failures.map(f => ({ failureId: f.id, desc: f.desc })), null, 2)}

Task: For each Functional Failure, generate 2-3 specific Failure Modes that result in that failure. Fewer is acceptable if the failure only has one or two credible modes — do not invent filler modes.
Failure modes must be unique across the whole subsystem. Treat all generated modes as siblings; do not share generic controls or actions across them.
${buildModeFieldRules(controlsKnowledgeAvailable, 'EACH generated failure mode')}
Do NOT generate or include RPN/S/O/D values. RPN is scored later by the dedicated RPN scorer.
${MODE_ACTION_FORMAT_RULES}

Return ONLY strict JSON:
{ "failures": [ { "failureId": "same failureId from input", "modes": [ { "mode": "string", "effect": "string", "cause": "string", "currentControls": "string", "mitigation": "string" } ] } ] }`;
        const content = prompt + (systemContext
            ? `\n\n${OPERATIONAL_HISTORY_GUIDANCE_RULES}\n\n${systemContext}`
            : '');
        try {
            const parsed = await this._withRetry(async () => {
                const res = await this.chat({
                    feature: 'mode-batch-generation',
                    provider: (aiProvider || inferProvider(key)) as any,
                    azureEndpoint: azureEndpoint || undefined,
                    powerAutomateUrl: powerAutomateUrl || undefined,
                    sessionId,
                    model: modelName,
                    messages: [{ role: 'user', content }],
                    mode: mode as 'ai'|'file'|'hybrid',
                    refText,
                    apiKey: key,
                    responseFormat: 'json'
                });
                return this.extractJSON(res);
            });
            const validFailureIds = new Set(failures.map(f => f.id));
            const rows = Array.isArray(parsed?.failures) ? parsed.failures : [];
            return {
                failures: rows
                    .map((row: any) => {
                        const failureId = String(row?.failureId ?? row?.failure_id ?? '').trim();
                        const modes = Array.isArray(row?.modes) ? row.modes : [];
                        modes.forEach((m: any) => {
                            if (!controlsKnowledgeAvailable) m.currentControls = '';
                            m.rpn = blankGeneratedRpn();
                            m.rpnStatus = 'unscored';
                        });
                        return { failureId, modes };
                    })
                    .filter((row: any) => validFailureIds.has(row.failureId))
            };
        } catch (e) {
            console.warn('[generateModesForFailuresBatch] failed:', e);
            return { failures: [] };
        }
    },

async evaluateRpnFromText(
  args: {
    project: string;
    subName: string;
    subSpecs: string;
    subFunc: string;
    failDesc: string;
    mode: string;
    effect: string;
    cause: string;
    currentControls?: string;
    mitigation: string;
    key: string;
    modelName: string;
    modeSource?: 'ai' | 'file' | 'hybrid';
    refText?: string;
    aiProvider?: string;
    azureEndpoint?: string;
    systemContext?: string;
    systemType?: string;
    systemModes?: SystemModeRow[];
    powerAutomateUrl?: string;
    sessionId?: string;
  }
): Promise<{ s: number; o: number; d: number; reason?: string; confidence?: 'high' | 'medium' | 'low'; baseline?: { s: number; o: number; d: number }; improvement?: { baselineRpn: number; mitigatedRpn: number; detectionImprovement: number; rpnReduction: number; summary: string } }> {
  const {
    project, subName, subSpecs, subFunc, failDesc,
    mode, effect, cause, currentControls = '', mitigation,
    key, modelName, modeSource = 'ai', refText = '',
    aiProvider = '', azureEndpoint = '', systemContext = '', systemType = '', systemModes = [], powerAutomateUrl = '', sessionId
  } = args;

  if ((!key || key.length < 10) && aiProvider !== 'copilot') {
    // Safe offline fallback (keeps app usable)
    await new Promise(r => setTimeout(r, 600));
    return {
      s: 5,
      o: 5,
      d: 5,
      baseline: { s: 5, o: 5, d: 8 },
      improvement: { baselineRpn: 200, mitigatedRpn: 125, detectionImprovement: 3, rpnReduction: 75, summary: "Simulated mitigation improves detection and reduces RPN." },
      confidence: 'low',
      reason: "S: 5 because simulated moderate end effect. O: 5 because no system mode count was scored in demo mode. Baseline D: 8 because current controls are unknown. Mitigated D: 5 because simulated mitigation improves detection. Confidence: low."
    };
  }

  const systemModeEvidence = this.findSystemModeOccurrenceEvidence(mode, cause, systemModes);
  const inputConfidence = this.confidenceFromRpnInputs(effect, cause, currentControls, mitigation, systemModeEvidence);
  const systemModeBlock = systemModeEvidence
    ? `Operational Failure Data Match:
- System Type: "${systemType || 'N/A'}"
- Matched Component: "${systemModeEvidence.component || 'N/A'}"
- Matched System Mode: "${systemModeEvidence.mode}"
- Match Type: ${systemModeEvidence.matchType}
- Failure Mode Count: ${systemModeEvidence.count}
- Rank: ${systemModeEvidence.rank} of ${systemModeEvidence.totalModes}
- Max Count in uploaded system modes: ${systemModeEvidence.maxCount}
- Count-based Occurrence Score: ${systemModeEvidence.occurrenceScore}
Use this matched system mode count as the primary evidence for baseline Occurrence (O).`
    : `Operational Failure Data Match:
- System Type: "${systemType || 'N/A'}"
- Matched System Mode: none
- Count-based Occurrence Score: unavailable
No uploaded system mode matched this Failure Mode; use mode/cause likelihood and standard industrial practice for Occurrence.`;

  const corePrompt = `
Act strictly as a Senior Reliability Engineer performing formal FMECA.
You must behave conservatively, consistently, and logically.
Your task is to assign Severity (S), Occurrence (O), and Detection (D) ratings on a 1–10 scale
based ONLY on the provided information and standard industrial reliability practice.
The main returned S/O/D score is the post-mitigation score after the mitigation actions are added to the system.
You must also estimate a baseline score before mitigation, using current controls only.

Context:
- System: "${project}"
- Subsystem: "${subName}"
- Specs: "${subSpecs}"
- Intended Function: "${subFunc}"
- Functional Failure: "${failDesc}"

Failure Details:
- Failure Mode: "${mode}"
- Effect: "${effect}"
- Root Cause: "${cause}"
- CURRENT Controls (already in place): "${currentControls || 'None stated'}"
- MITIGATION Actions to be added to the system: "${mitigation || 'None stated'}"

${systemModeBlock}

${RPN_ANCHORS}

Mandatory Scoring Logic (DO NOT VIOLATE):

Severity (S):
- Rate the consequence of the EFFECT only, not the cause. If the effect states both a local and an end (system-level) effect, rate the END effect.
- Safety, environmental harm, and total production loss dominate Severity.
- If the effect is local, reversible, or causes minor performance degradation, Severity MUST be LOW.
- If the effect description is vague or mild, do NOT assume worst-case.
- High Severity (8–10) is allowed ONLY if the effect clearly implies safety risk, regulatory breach, or major system outage.

Occurrence (O):
- If Operational Failure Data has a matched system mode, baseline Occurrence MUST be driven by the matched Failure Mode Count and Count-based Occurrence Score.
- If matched count exists, set baseline.o equal to the Count-based Occurrence Score unless a severe contradiction exists in the field text.
- Main returned "o" is post-mitigation occurrence. Keep it equal to baseline.o unless mitigation contains concrete preventive actions that reduce the stated cause likelihood.
- Do NOT reduce Occurrence for detection-only actions such as alarms, monitoring, trips, inspections, proof tests, or diagnostics; those affect Detection only.
- If no matched system mode exists, estimate likelihood using typical industrial experience for the stated FAILURE MODE and CAUSE.
- Mention the matched system mode and count in the O reasoning whenever available.

Detection (D):
- Main returned "d": score Detection using BOTH CURRENT Controls and MITIGATION Actions, assuming mitigation is added to the system.
- Also provide "baseline.d" using CURRENT Controls only, before mitigation.
- Better current controls or mitigation detection barriers → LOWER D value.
- Poor, reactive, or absent controls/mitigations → HIGHER D value (8-10).
- If current controls or mitigation include condition monitoring, alarms, trips, inspections, diagnostics, proof testing, or specific detection tasks, D decreases accordingly.
- Never assign low Detection unless detection capability is explicitly stated in CURRENT Controls or MITIGATION Actions.
- Do not credit vague mitigation text; only concrete barriers should improve Detection.

Consistency Rules:
- Mild effects must NEVER result in high Severity.
- When genuinely uncertain between two adjacent bands, choose the HIGHER-RISK band (higher S or D) — but never jump bands beyond what the stated information supports.
- Avoid clustering all values at 5 unless justified.
- Main S should equal baseline S unless mitigation clearly reduces the end consequence severity.
- Main O should not be lower than baseline O unless mitigation prevents or reduces the stated cause.
- Main D should not be lower than baseline D unless mitigation adds concrete detection/prevention controls.
- If mitigation is absent or vague, main S/O/D should equal baseline S/O/D except where current controls already justify baseline detection.

Output Requirements:
- Return strictly valid JSON only.
- Values must be integers from 1 to 10.
- Main "s", "o", "d" are post-mitigation scores using current controls plus mitigation.
- Include "baseline" S/O/D using current controls only.
- Calculate baselineRpn = baseline.s * baseline.o * baseline.d.
- Calculate mitigatedRpn = s * o * d.
- Calculate detectionImprovement = baseline.d - d.
- Calculate rpnReduction = baselineRpn - mitigatedRpn.
- Include structured reasoning in exactly this format:
  S: [score] because [end effect] plus, if applicable, production + safety + asset + cost impacts. O: [score] because [mode/cause likelihood] plus the system mode failure count. Baseline D: [score] because [current controls]. Mitigated D: [score] because [credited mitigation]. Confidence: [high|medium|low].
- Confidence should reflect input quality and evidence: use "${inputConfidence}" unless the scoring evidence clearly supports another level.

Output format:
{
  "s": <1–10>,
  "o": <1–10>,
  "d": <1–10>,
  "baseline": { "s": <1–10>, "o": <1–10>, "d": <1–10> },
  "confidence": "high" | "medium" | "low",
  "improvement": {
    "baselineRpn": <number>,
    "mitigatedRpn": <number>,
    "detectionImprovement": <number>,
    "rpnReduction": <number>,
    "summary": "One sentence describing how mitigation improves D and RPN."
  },
  "reason": "S: ... O: ... Baseline D: ... Mitigated D: ... Confidence: ..."
}
`.trim();

  const rpnContent = corePrompt + (systemContext ? '\n\n' + systemContext : '');

  const parsed = await this._withRetry(async () => {
    const res = await this.chat({
      feature: 'rpn-evaluation',
      provider: (aiProvider || inferProvider(key)) as any,
      azureEndpoint: azureEndpoint || undefined,
      powerAutomateUrl: powerAutomateUrl || undefined,
      sessionId,
      model: modelName,
      messages: [{ role: 'user', content: rpnContent }],
      mode: modeSource,
      refText,
      apiKey: key,
      responseFormat: 'json'
    });
    return this.extractJSON(res);
  });

  return this.normalizeRpnResult(parsed, {
    mode, effect, cause, currentControls, mitigation, systemModeEvidence, inputConfidence
  });
},

/**
 * Turn one raw scoring reply into the stored S/O/D.
 *
 * Shared by the single-mode scorer and the batch one so a mode scored during
 * generation and the same mode re-scored later by the robot button go through
 * exactly the same clamping, mitigation-credit gating and reason repair. The
 * model's numbers are never stored as-is: mitigation only earns a reduction
 * when the text names a concrete barrier, which is what stops "improve
 * maintenance" from buying a lower Detection.
 */
normalizeRpnResult(
  parsed: any,
  ctx: {
    mode: string;
    effect: string;
    cause: string;
    currentControls: string;
    mitigation: string;
    systemModeEvidence: SystemModeOccurrenceEvidence | null;
    inputConfidence: 'high' | 'medium' | 'low';
  }
): { s: number; o: number; d: number; reason: string; confidence: 'high' | 'medium' | 'low'; baseline: { s: number; o: number; d: number }; improvement: { baselineRpn: number; mitigatedRpn: number; detectionImprovement: number; rpnReduction: number; summary: string } } {
  const { mode, effect, cause, currentControls, mitigation, systemModeEvidence, inputConfidence } = ctx;

  // Normalize and clamp
  const clamp = (n: any) => Math.min(10, Math.max(1, Math.round(Number(n) || 5)));

  const hasConcreteMitigation = mitigation.trim() && !/^(none|n\/a|unknown|improve maintenance|regular maintenance|inspect regularly|monitor condition)$/i.test(mitigation.trim());
  const preventiveMitigation = /\b(replace|redesign|upgrade|modify|prevent|eliminate|filter|clean|balance|align|lubricat|seal|tighten|torque|calibrat|flush|change oil|oil analysis|contamination control|root cause)\b/i.test(mitigation);
  const detectionMitigation = /\b(alarm|trip|monitor|sensor|transmitter|switch|inspect|inspection|test|proof|diagnostic|vibration|temperature|pressure|flow|level|analysis|sample|trend|detect)\b/i.test(mitigation);
  const severityMitigation = /\b(relief|contain|secondary containment|shutdown|trip|isolate|interlock|protect|fire|blast|spill|consequence)\b/i.test(mitigation);

  const parsedS = clamp(parsed?.s);
  const parsedO = clamp(parsed?.o);
  const parsedD = clamp(parsed?.d);
  const baseline = {
    s: clamp(parsed?.baseline?.s ?? parsed?.baseline_s ?? parsedS),
    o: systemModeEvidence ? systemModeEvidence.occurrenceScore : clamp(parsed?.baseline?.o ?? parsed?.baseline_o ?? parsedO),
    d: clamp(parsed?.baseline?.d ?? parsed?.baseline_d ?? parsedD)
  };

  const s = (hasConcreteMitigation && severityMitigation) ? Math.min(parsedS, baseline.s) : baseline.s;
  const o = (hasConcreteMitigation && preventiveMitigation) ? Math.min(parsedO, baseline.o) : baseline.o;
  const d = (hasConcreteMitigation && (detectionMitigation || preventiveMitigation)) ? Math.min(parsedD, baseline.d) : baseline.d;
  const confidence = (['high', 'medium', 'low'].includes(String(parsed?.confidence || '').toLowerCase())
    ? String(parsed.confidence).toLowerCase()
    : inputConfidence) as 'high' | 'medium' | 'low';
  const baselineRpn = baseline.s * baseline.o * baseline.d;
  const mitigatedRpn = s * o * d;
  const detectionImprovement = baseline.d - d;
  const rpnReduction = baselineRpn - mitigatedRpn;
  const summary = typeof parsed?.improvement?.summary === 'string' && parsed.improvement.summary.trim()
    ? this.cleanSingleFieldText(parsed.improvement.summary)
    : `RPN changes from ${baselineRpn} to ${mitigatedRpn} based on credited mitigation.`;
  const systemModeReason = systemModeEvidence
    ? `matched system mode "${systemModeEvidence.mode}" has ${systemModeEvidence.count} occurrence(s), rank ${systemModeEvidence.rank}/${systemModeEvidence.totalModes}`
    : 'no matching uploaded system mode count was available';
  const fallbackReason = `S: ${s} because ${this.cleanSingleFieldText(effect || 'end effect is not clearly stated')} with production, safety, asset, and cost impact reflected where stated. O: ${o} because ${this.cleanSingleFieldText(mode || 'failure mode')} / ${this.cleanSingleFieldText(cause || 'cause not stated')} likelihood is anchored by ${systemModeReason}. Baseline D: ${baseline.d} because ${this.cleanSingleFieldText(currentControls || 'current controls are not stated')}. Mitigated D: ${d} because ${this.cleanSingleFieldText(hasConcreteMitigation ? mitigation : 'no concrete mitigation is credited')}. Confidence: ${confidence}.`;
  const rawReason = typeof parsed?.reason === 'string' ? this.cleanSingleFieldText(parsed.reason) : '';
  // `[\s\S]` rather than `.` — a multi-line reason is still a valid one, and `.` would
  // reject every such reply and silently swap in the templated fallback below.
  const reasonShapeOk = /S\s*[:=]\s*\d+[\s\S]*\bO\s*[:=]\s*\d+[\s\S]*Baseline\s*D\s*[:=]\s*\d+[\s\S]*Mitigated\s*D\s*[:=]\s*\d+[\s\S]*Confidence\s*[:=]\s*(high|medium|low)/i.test(rawReason);
  // Scores are clamped after parsing (mitigation credit is gated on the regexes above), so
  // the numbers the model wrote into its prose can disagree with what actually gets stored.
  // Re-stamp the headline numbers onto the model's own wording.
  const alignReasonScores = (text: string) => text
    .replace(/(^|[\s.;,])S\s*[:=]\s*\d+/i, `$1S: ${s}`)
    .replace(/(^|[\s.;,])O\s*[:=]\s*\d+/i, `$1O: ${o}`)
    .replace(/(^|[\s.;,])Baseline\s*D\s*[:=]\s*\d+/i, `$1Baseline D: ${baseline.d}`)
    .replace(/(^|[\s.;,])Mitigated\s*D\s*[:=]\s*\d+/i, `$1Mitigated D: ${d}`)
    .replace(/(^|[\s.;,])Confidence\s*[:=]\s*(high|medium|low)/i, `$1Confidence: ${confidence}`);
  const reason = reasonShapeOk ? alignReasonScores(rawReason) : fallbackReason;

  return {
    s,
    o,
    d,
    confidence,
    baseline,
    improvement: { baselineRpn, mitigatedRpn, detectionImprovement, rpnReduction, summary },
    reason
  };
},

/**
 * Score every failure mode of one subsystem in a single call.
 *
 * RPN used to be a call per mode, which is why it was taken out of MasterGen
 * and Auto-Fill altogether: fifteen modes meant fifteen round trips stacked on
 * the end of a generation that was already slow. As a batch it costs one more
 * step in the chain, which under the concurrent pool is about one call-time
 * across the whole run — cheap enough to put scoring back where it belongs.
 *
 * The scoring itself is unchanged. The occurrence evidence is matched locally
 * per mode (no AI call) and inlined per mode, and every reply goes through
 * `normalizeRpnResult`, so a mode scored here and the same mode re-scored later
 * by the robot button are treated identically.
 *
 * A mode the model does not return is left out rather than defaulted. An
 * unscored row is honest; a fabricated 5/5/5 is not.
 */
async evaluateRpnBatch(
  args: {
    project: string;
    subName: string;
    subSpecs: string;
    subFunc: string;
    modes: Array<{
      modeId: string;
      failDesc: string;
      mode: string;
      effect: string;
      cause: string;
      currentControls?: string;
      mitigation: string;
    }>;
    key: string;
    modelName: string;
    modeSource?: 'ai' | 'file' | 'hybrid';
    refText?: string;
    aiProvider?: string;
    azureEndpoint?: string;
    systemContext?: string;
    systemType?: string;
    systemModes?: SystemModeRow[];
    powerAutomateUrl?: string;
    sessionId?: string;
  }
): Promise<Array<{
  modeId: string;
  s: number;
  o: number;
  d: number;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
  baseline: { s: number; o: number; d: number };
  improvement: { baselineRpn: number; mitigatedRpn: number; detectionImprovement: number; rpnReduction: number; summary: string };
}>> {
  const {
    project, subName, subSpecs, subFunc, modes,
    key, modelName, modeSource = 'ai', refText = '',
    aiProvider = '', azureEndpoint = '', systemContext = '', systemType = '',
    systemModes = [], powerAutomateUrl = '', sessionId
  } = args;

  if (!modes.length) return [];

  // Evidence and input confidence are pure local lookups, so every mode keeps
  // the operational-history occurrence anchor it would have had on its own.
  const prepared = modes.map(m => {
    const currentControls = m.currentControls || '';
    const evidence = this.findSystemModeOccurrenceEvidence(m.mode, m.cause, systemModes);
    return {
      ...m,
      currentControls,
      evidence,
      inputConfidence: this.confidenceFromRpnInputs(m.effect, m.cause, currentControls, m.mitigation, evidence)
    };
  });

  if ((!key || key.length < 10) && aiProvider !== 'copilot') {
    await new Promise(r => setTimeout(r, 800));
    return prepared.map(p => ({
      modeId: p.modeId,
      ...this.normalizeRpnResult(
        { s: 5, o: 5, d: 5, baseline: { s: 5, o: 5, d: 8 }, confidence: 'low' },
        { mode: p.mode, effect: p.effect, cause: p.cause, currentControls: p.currentControls, mitigation: p.mitigation, systemModeEvidence: p.evidence, inputConfidence: p.inputConfidence }
      )
    }));
  }

  // Long subsystems are split so one prompt never carries thirty modes' worth
  // of evidence. The chunks are independent questions, so each takes a
  // conversation of its own and they run side by side rather than queueing.
  const CHUNK = 12;
  if (prepared.length > CHUNK) {
    const chunks: typeof prepared[] = [];
    for (let i = 0; i < prepared.length; i += CHUNK) chunks.push(prepared.slice(i, i + CHUNK));
    const settled = await Promise.all(chunks.map((chunk, i) => this.evaluateRpnBatch({
      ...args,
      modes: chunk,
      sessionId: i === 0 ? sessionId : crypto.randomUUID()
    })));
    return settled.flat();
  }

  const modeBlocks = prepared.map((p, i) => {
    const evidenceBlock = p.evidence
      ? `  Operational Failure Data Match: matched system mode "${p.evidence.mode}" (${p.evidence.matchType}), component "${p.evidence.component || 'N/A'}", count ${p.evidence.count}, rank ${p.evidence.rank} of ${p.evidence.totalModes}, max count ${p.evidence.maxCount}, Count-based Occurrence Score ${p.evidence.occurrenceScore}. Use this count as the primary evidence for baseline Occurrence.`
      : `  Operational Failure Data Match: none. Use mode/cause likelihood and standard industrial practice for Occurrence.`;
    return `${i + 1}. modeId: "${p.modeId}"
  Functional Failure: "${p.failDesc}"
  Failure Mode: "${p.mode}"
  Effect: "${p.effect}"
  Root Cause: "${p.cause}"
  CURRENT Controls (already in place): "${p.currentControls || 'None stated'}"
  MITIGATION Actions to be added: "${p.mitigation || 'None stated'}"
${evidenceBlock}
  Suggested confidence from input quality: ${p.inputConfidence}`;
  }).join('\n\n');

  const corePrompt = `
Act strictly as a Senior Reliability Engineer performing formal FMECA.
You must behave conservatively, consistently, and logically.
Score EVERY failure mode listed below independently, assigning Severity (S), Occurrence (O), and Detection (D) on a 1–10 scale
based ONLY on the provided information and standard industrial reliability practice.
The main returned S/O/D score is the post-mitigation score after the mitigation actions are added to the system.
You must also estimate a baseline score before mitigation, using current controls only.

Context:
- System: "${project}"
- Subsystem: "${subName}"
- Specs: "${subSpecs}"
- Intended Function: "${subFunc}"

Failure Modes to score (${prepared.length}):
${modeBlocks}

${RPN_ANCHORS}

Mandatory Scoring Logic (DO NOT VIOLATE):

Severity (S):
- Rate the consequence of the EFFECT only, not the cause. If the effect states both a local and an end (system-level) effect, rate the END effect.
- Safety, environmental harm, and total production loss dominate Severity.
- If the effect is local, reversible, or causes minor performance degradation, Severity MUST be LOW.
- If the effect description is vague or mild, do NOT assume worst-case.
- High Severity (8–10) is allowed ONLY if the effect clearly implies safety risk, regulatory breach, or major system outage.

Occurrence (O):
- If a mode has a matched system mode, baseline Occurrence MUST be driven by its Failure Mode Count and Count-based Occurrence Score.
- If matched count exists, set baseline.o equal to the Count-based Occurrence Score unless a severe contradiction exists in the field text.
- Main returned "o" is post-mitigation occurrence. Keep it equal to baseline.o unless mitigation contains concrete preventive actions that reduce the stated cause likelihood.
- Do NOT reduce Occurrence for detection-only actions such as alarms, monitoring, trips, inspections, proof tests, or diagnostics; those affect Detection only.
- If no matched system mode exists, estimate likelihood using typical industrial experience for the stated FAILURE MODE and CAUSE.
- Mention the matched system mode and count in the O reasoning whenever available.

Detection (D):
- Main returned "d": score Detection using BOTH CURRENT Controls and MITIGATION Actions, assuming mitigation is added to the system.
- Also provide "baseline.d" using CURRENT Controls only, before mitigation.
- Better current controls or mitigation detection barriers → LOWER D value.
- Poor, reactive, or absent controls/mitigations → HIGHER D value (8-10).
- If current controls or mitigation include condition monitoring, alarms, trips, inspections, diagnostics, proof testing, or specific detection tasks, D decreases accordingly.
- Never assign low Detection unless detection capability is explicitly stated in CURRENT Controls or MITIGATION Actions.
- Do not credit vague mitigation text; only concrete barriers should improve Detection.

Consistency Rules:
- Mild effects must NEVER result in high Severity.
- When genuinely uncertain between two adjacent bands, choose the HIGHER-RISK band (higher S or D) — but never jump bands beyond what the stated information supports.
- Avoid clustering all values at 5 unless justified.
- Main S should equal baseline S unless mitigation clearly reduces the end consequence severity.
- Main O should not be lower than baseline O unless mitigation prevents or reduces the stated cause.
- Main D should not be lower than baseline D unless mitigation adds concrete detection/prevention controls.
- If mitigation is absent or vague, main S/O/D should equal baseline S/O/D except where current controls already justify baseline detection.
- Score each mode on its own evidence. Do NOT copy one mode's scores onto another, and do NOT make scores uniform across the subsystem.

Output Requirements:
- Return strictly valid JSON only.
- Return one entry per listed mode, echoing its "modeId" exactly. Do not add, drop, merge, or rename modes.
- Values must be integers from 1 to 10.
- Main "s", "o", "d" are post-mitigation scores using current controls plus mitigation.
- Include "baseline" S/O/D using current controls only.
- Calculate baselineRpn = baseline.s * baseline.o * baseline.d.
- Calculate mitigatedRpn = s * o * d.
- Calculate detectionImprovement = baseline.d - d.
- Calculate rpnReduction = baselineRpn - mitigatedRpn.
- Include structured reasoning in exactly this format:
  S: [score] because [end effect] plus, if applicable, production + safety + asset + cost impacts. O: [score] because [mode/cause likelihood] plus the system mode failure count. Baseline D: [score] because [current controls]. Mitigated D: [score] because [credited mitigation]. Confidence: [high|medium|low].
- Confidence should reflect input quality and evidence: use each mode's suggested confidence unless the scoring evidence clearly supports another level.

Output format:
{
  "scores": [
    {
      "modeId": "echo the modeId exactly",
      "s": <1–10>,
      "o": <1–10>,
      "d": <1–10>,
      "baseline": { "s": <1–10>, "o": <1–10>, "d": <1–10> },
      "confidence": "high" | "medium" | "low",
      "improvement": {
        "baselineRpn": <number>,
        "mitigatedRpn": <number>,
        "detectionImprovement": <number>,
        "rpnReduction": <number>,
        "summary": "One sentence describing how mitigation improves D and RPN."
      },
      "reason": "S: ... O: ... Baseline D: ... Mitigated D: ... Confidence: ..."
    }
  ]
}
`.trim();

  const rpnContent = corePrompt + (systemContext ? '\n\n' + systemContext : '');

  try {
    const parsed = await this._withRetry(async () => {
      const res = await this.chat({
        feature: 'rpn-batch-evaluation',
        provider: (aiProvider || inferProvider(key)) as any,
        azureEndpoint: azureEndpoint || undefined,
        powerAutomateUrl: powerAutomateUrl || undefined,
        sessionId,
        model: modelName,
        messages: [{ role: 'user', content: rpnContent }],
        mode: modeSource,
        refText,
        apiKey: key,
        responseFormat: 'json'
      });
      const json = this.extractJSON(res);
      // An empty score list is a failed turn, not an answer — let it retry.
      if (!Array.isArray(json?.scores) || json.scores.length === 0) throw new Error('No RPN scores returned');
      return json;
    });

    const byId = new Map<string, any>();
    for (const row of parsed.scores) {
      const id = String(row?.modeId ?? row?.mode_id ?? '').trim();
      if (id) byId.set(id, row);
    }

    return prepared.flatMap(p => {
      const row = byId.get(p.modeId);
      if (!row) return [];
      return [{
        modeId: p.modeId,
        ...this.normalizeRpnResult(row, {
          mode: p.mode,
          effect: p.effect,
          cause: p.cause,
          currentControls: p.currentControls,
          mitigation: p.mitigation,
          systemModeEvidence: p.evidence,
          inputConfidence: p.inputConfidence
        })
      }];
    });
  } catch (e) {
    console.warn('[evaluateRpnBatch] failed:', e);
    return [];
  }
},

    async analyzeImageForSubsystem(base64: string, key: string, model: string): Promise<string> {
        if (!key || key.length < 10) { await new Promise(r => setTimeout(r, 700)); return JSON.stringify({ equipment_type: "", equipment_model: "", manufacturer: "", specs: "", observations: [] }, null, 2); }
        const prompt = `Analyze image. Return strictly valid JSON: { "equipment_type": "", "equipment_model": "", "manufacturer": "", "specs": "string (Format: Key: Value Unit, Key: Value Unit)", "observations": ["string"] }`;

        try {
            return await this.vision({
                feature: 'image-analysis',
                provider: key.startsWith('sk-') ? 'openai' : 'gemini',
                model: model || (key.startsWith('sk-') ? "gpt-4o-mini" : "gemini-1.5-flash"),
                messages: [{
                    role: "user",
                    content: [
                        { type: "text", text: prompt },
                        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } }
                    ]
                }],
                mode: 'ai',
                apiKey: key,
                responseFormat: 'json'
            });
        } catch (e) { throw e; }
    },

    // -------------------------------------------------------------------------
    // INTERNAL TRANSPORT (Direct & Remote)
    // -------------------------------------------------------------------------

    async _remoteRequest(endpoint: string, req: AIRequestPayload): Promise<string> {
        const url = `${AI_CONFIG.baseUrl}${endpoint}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req)
        });
        if (!res.ok) throw new Error(`Remote API Error: ${res.statusText}`);
        const data = await res.json();
        return data.content;
    },

    /**
     * One Copilot turn.
     *
     * Queued rather than fired straight off: the app shares one Conversation ID
     * across calls, and an agent thread cannot take two turns at once. See
     * `CopilotQueue` for what goes wrong when it does.
     */
    async _powerAutomateRequest(req: AIRequestPayload): Promise<string> {
        if (!req.powerAutomateUrl) {
            throw new Error('Power Automate URL is required for Copilot provider.');
        }
        return this._powerAutomateTurn(req);
    },

    async _powerAutomateTurn(req: AIRequestPayload): Promise<string> {

        const rawPrompt = req.feature === 'chatbot'
            ? req.messages
                .map(m => `${m.role.toUpperCase()}:\n${typeof m.content === 'string' ? m.content : ''}`)
                .join('\n\n')
            : (() => {
                const lastUserMessage = [...req.messages].reverse().find(m => m.role === 'user');
                return typeof lastUserMessage?.content === 'string' ? lastUserMessage.content : '';
            })();

        const fullPrompt = this.attachContext(rawPrompt, req.mode, req.refText ?? '', req.responseFormat);

        const attachments = req.attachments ?? [];
        // A spreadsheet finishes the conversation it lands in, so it gets one of
        // its own and the shared session survives.
        const oneShot = carriesSpreadsheet(attachments);
        // A caller that brought its own conversation is kept on it, attachments
        // or not: that is how work which wants to run beside the rest — a
        // citation run — stays off the shared thread instead of queueing behind
        // it. The ledger is keyed per conversation, so its files still travel
        // once and only once.
        const sessionFor = () =>
            req.sessionId && !oneShot ? req.sessionId : copilotSessionId({ oneShot });

        const send = async (sessionId: string, files: FilePayload[]): Promise<string> => {
            const payload: Record<string, unknown> = {
                sessionId,
                prompt: fullPrompt,
                responseFormat: req.responseFormat ?? 'text',
            };

            // The flow maps these onto the "A list of attachments" input of
            // Execute Agent, so the agent opens the real document instead of our
            // extracted text — which is what a scan or a drawing needs.
            if (files.length > 0) {
                payload.attachments = files;
                console.log(
                    '[AIService] Copilot attachments sent:',
                    files
                        .map(a => `${a.name} (${a.contentType}, ${Math.round((a.contentBytes.length * 3) / 4 / 1024)} KB)`)
                        .join(', ')
                );
            } else if (attachments.length > 0) {
                console.log(`[AIService] Copilot: ${attachments.length} attachment(s) already held by this conversation`);
            }

            const res = await fetch(req.powerAutomateUrl!, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`Power Automate Error: ${res.statusText}${errText ? ` — ${errText}` : ''}`);
            }
            return res.text();
        };

        const sessionId = sessionFor();

        // One turn at a time on a conversation. Different conversations run side
        // by side — the flow takes concurrent runs happily; a single agent thread
        // does not. See `CopilotQueue`.
        return runExclusive(sessionId, async () => {
            // Only what this conversation is not already holding travels again.
            const toSend = oneShot ? attachments : pendingAttachments(sessionId, attachments);
            const reply = await send(sessionId, toSend);

            // A one-shot conversation holds nothing worth remembering.
            if (!oneShot && toSend.length > 0) markAttachmentsSent(sessionId, toSend);

            // Skipped an upload and the agent answered as if it had no file: the
            // conversation is gone. Start a clean one, send everything, once.
            const skipped = attachments.length > toSend.length;
            if (skipped && looksLikeLostSession(reply)) {
                console.warn('[AIService] Copilot conversation looks expired — reattaching and retrying once');
                // Only the shared session is the app's to rotate. A caller that
                // brought its own id keeps it — rotating it would abandon a
                // conversation the app never owned.
                const retryId = req.sessionId && !oneShot ? sessionId : rotateCopilotSession();
                const retryReply = await send(retryId, attachments);
                markAttachmentsSent(retryId, attachments);
                return retryReply;
            }

            return reply;
        });
    },

    async _directChat(req: AIRequestPayload): Promise<string> {
        // DIRECT mode: Use direct calls to OpenAI/Gemini
        // Apply context attachment locally as backend is not involved
        const rawContent = typeof req.messages[0].content === 'string' ? req.messages[0].content : "";
        const fullPrompt = this.attachContext(rawContent, req.mode, req.refText || '', req.responseFormat);

        try {
            if (req.provider === 'anthropic') {
                const systemText = req.messages
                    .filter(m => m.role === 'system')
                    .map(m => typeof m.content === 'string' ? m.content : '')
                    .join('\n\n');
                const msgs = req.feature === 'chatbot'
                    ? req.messages
                        .filter(m => m.role !== 'system')
                        .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: typeof m.content === 'string' ? m.content : '' }))
                    : [{ role: 'user', content: fullPrompt + (req.responseFormat === 'json' ? ' Return JSON object only.' : '') }];
                const body: any = { model: (req.model && req.model.trim()) || 'claude-sonnet-4-20250514', max_tokens: 4096, messages: msgs };
                if (req.feature === 'chatbot') body.system = systemText || "You are a helpful FMECA consultant.";
                const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': req.apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) });
                const data = await res.json();
                if (data.error) throw new Error(data.error.message || data.error.type || JSON.stringify(data.error));
                return data.content[0].text;
            }
            if (req.provider === 'azure') {
                const endpoint = (req.azureEndpoint || '').replace(/\/$/, '');
                if (!endpoint) throw new Error('Azure endpoint required. Set it in AI Settings.');
                const deployment = (req.model && req.model.trim()) || '';
                const msgs = req.feature === 'chatbot' ? req.messages : [{ role: 'user', content: fullPrompt }];
                const body: any = { messages: msgs };
                if (req.responseFormat === 'json') body.response_format = { type: 'json_object' };
                const res = await fetch(`${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=2024-02-01`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'api-key': req.apiKey }, body: JSON.stringify(body) });
                const data = await res.json();
                if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
                return data.choices[0].message.content;
            }
            if (req.provider === 'openrouter') {
                const msgs = req.feature === 'chatbot' ? req.messages : [{ role: 'user', content: fullPrompt }];
                const body: any = { model: (req.model && req.model.trim()) || 'openai/gpt-4o-mini', messages: msgs };
                if (req.responseFormat === 'json') body.response_format = { type: 'json_object' };
                const res = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${req.apiKey}` }, body: JSON.stringify(body) });
                const data = await res.json();
                if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
                return data.choices[0].message.content;
            }
            if (req.provider === 'openai') {
                const body: any = {
                    model: (req.model && req.model.trim()) || "gpt-4o-mini",
                    messages: [...req.messages.slice(0, -1), { role: "user", content: fullPrompt }]
                };
                // If it's a conversation history (chatbot), fullPrompt might replace just the last message
	                if (req.feature === 'chatbot') {
                     // For chatbot, we append the system prompt/context to the last message or as system message
                     // Here we just modify the last user message for simplicity as per legacy generate() behavior logic
                     // But for proper chat, we should keep the history.
                     // The requirement is "preserve existing behavior". Existing behavior generate() sends only 1 prompt.
                     // New Chatbot feature sends history.
                     body.messages = req.messages; // For chatbot, messages are already prepared
                }

                if(req.responseFormat === 'json') body.response_format = { type: "json_object" };

                const res = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${req.apiKey}` },
                    body: JSON.stringify(body)
                });
                const data = await res.json();
                if(data.error) throw new Error(data.error.message);
                return data.choices[0].message.content;
            } else {
                // Gemini
                // Note: Gemini API in this app uses generateContent (stateless) mostly.
                // For chatbot, we might need to format history.
                let promptText = fullPrompt;
                if (req.feature === 'chatbot') {
                    // Flatten messages for simple stateless call if model doesn't support chat format easily in this SDK-less implementation
                    // Or map to Gemini content structure.
                    // For safety and strict adherence to "don't simplify", we map the conversation.
                    const systemText = req.messages
                        .filter(m => m.role === 'system')
                        .map(m => typeof m.content === 'string' ? m.content : '')
                        .join('\n\n');
                    const contents = req.messages.filter(m => m.role !== 'system').map(m => ({
                        role: m.role === 'assistant' ? 'model' : 'user',
                        parts: [{ text: typeof m.content === 'string' ? m.content : '' }]
                    }));
                    // Gemini REST API expects 'contents' array
                    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${(req.model && req.model.trim()) || "gemini-1.5-flash"}:generateContent?key=${req.apiKey}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ contents, systemInstruction: { parts: [{ text: systemText || "You are a helpful FMECA consultant." }] } }) // Basic system instruction support
                    });
                    const data = await res.json();
                    if (data.error) throw new Error(data.error.message);
                    return data.candidates[0].content.parts[0].text;
                }

                // Legacy single-turn behavior
                promptText = fullPrompt + (req.responseFormat === 'json' ? " Return JSON object only." : "");
                const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${(req.model && req.model.trim()) || "gemini-1.5-flash"}:generateContent?key=${req.apiKey}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ contents: [{ parts: [{ text: promptText }] }] })
                });
                const data = await res.json();
                if (data.error) throw new Error(data.error.message);
                if (!data.candidates || !data.candidates.length) throw new Error("No response");
                return data.candidates[0].content.parts[0].text;
            }
        } catch (e) { throw e as Error; }
    },

    /**
     * A chat turn that may carry images, and — for Copilot — the file itself.
     *
     * `chat()` flattens message content to strings, which is right for text but
     * throws away every picture. This keeps the parts and translates them into
     * each provider's own multimodal shape: the OpenAI array schema for
     * OpenAI/Azure/OpenRouter, `inlineData` parts for Gemini, image blocks for
     * Anthropic, and attachments on the Power Automate payload for Copilot.
     *
     * Any number of images per message, unlike `vision()`, which was written for
     * one photo of one nameplate.
     */
    async chatMultimodal(req: AIRequestPayload): Promise<string> {
        const parts = (m: AIMessage) => (Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }]);
        const textOf = (m: AIMessage) =>
            parts(m).filter(p => p.type === 'text').map(p => p.text || '').join('\n');
        const imagesOf = (m: AIMessage) =>
            parts(m).filter(p => p.type === 'image_url' && p.image_url).map(p => p.image_url!.url);
        const system = req.messages.filter(m => m.role === 'system').map(textOf).join('\n\n');
        const turns = req.messages.filter(m => m.role !== 'system');

        // The flow takes text plus real files; images become attachments too, so
        // the agent still sees the pages rather than a description of them.
        //
        // Every image leaves as PNG: the Copilot agent only analyses PNG, and a
        // JPEG page render is accepted by the flow and then silently ignored —
        // the answer comes back as if nothing had been attached.
        if (req.provider === 'copilot') {
            const images = turns.flatMap(imagesOf);
            const pages: FilePayload[] = [];
            for (const [i, url] of images.entries()) {
                try {
                    const png = await toPngPayload(url);
                    pages.push({ name: pngAttachmentName(`page-${i + 1}`, i), ...png });
                } catch (e) {
                    // One undecodable image must not take down the whole turn.
                    console.warn('[AIService] skipping an image the agent could not be sent', e);
                }
            }
            const attachments = [...(req.attachments ?? []), ...pages].filter(a => a.contentBytes);
            // Name what was sent, so the agent can say which file it did or did
            // not receive instead of quietly answering from nothing.
            const manifest = attachments.length
                ? `\n\nAttached, read the files themselves rather than any extracted text:\n${attachments.map(a => `- ${a.name}`).join('\n')}`
                : '';
            // Folded into the one user message on purpose: the flow transport
            // reads only the last user message for any feature but the chatbot,
            // so a separate system message would be dropped on the floor.
            const prompt = [system, turns.map(textOf).join('\n\n')].filter(Boolean).join('\n\n') + manifest;
            return this._powerAutomateRequest({
                ...req,
                attachments,
                messages: [{ role: 'user', content: prompt }],
            });
        }

        if (req.provider === 'gemini') {
            const model = (req.model && req.model.trim()) || 'gemini-2.0-flash';
            const contents = turns.map(m => ({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [
                    { text: textOf(m) },
                    ...imagesOf(m).map(url => ({
                        inlineData: {
                            mimeType: (url.match(/^data:([^;]+);/) || [, 'image/jpeg'])[1],
                            data: url.split(',')[1] || '',
                        },
                    })),
                ],
            }));
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${req.apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents,
                    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
                }),
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error.message);
            if (!data.candidates?.length) throw new Error('No response');
            return data.candidates[0].content.parts.map((p: any) => p.text || '').join('');
        }

        if (req.provider === 'anthropic') {
            const res = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': req.apiKey,
                    'anthropic-version': '2023-06-01',
                    'anthropic-dangerous-direct-browser-access': 'true',
                },
                body: JSON.stringify({
                    model: (req.model && req.model.trim()) || 'claude-sonnet-4-20250514',
                    max_tokens: 4096,
                    ...(system ? { system } : {}),
                    messages: turns.map(m => ({
                        role: m.role === 'assistant' ? 'assistant' : 'user',
                        content: [
                            { type: 'text', text: textOf(m) },
                            ...imagesOf(m).map(url => ({
                                type: 'image',
                                source: {
                                    type: 'base64',
                                    media_type: (url.match(/^data:([^;]+);/) || [, 'image/jpeg'])[1],
                                    data: url.split(',')[1] || '',
                                },
                            })),
                        ],
                    })),
                }),
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error.message || 'Anthropic error');
            return (data.content || []).map((c: any) => c.text || '').join('');
        }

        // OpenAI, Azure OpenAI and OpenRouter all take the OpenAI array schema.
        const messages = [
            ...(system ? [{ role: 'system', content: system }] : []),
            ...turns.map(m => ({ role: m.role, content: parts(m) })),
        ];
        const body: any = { model: req.model, messages };
        if (req.responseFormat === 'json') body.response_format = { type: 'json_object' };

        let url = 'https://api.openai.com/v1/chat/completions';
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (req.provider === 'azure') {
            if (!req.azureEndpoint) throw new Error('Azure endpoint is required.');
            url = `${req.azureEndpoint.replace(/\/$/, '')}/openai/deployments/${req.model}/chat/completions?api-version=2024-08-01-preview`;
            headers['api-key'] = req.apiKey;
            delete body.model;
        } else if (req.provider === 'openrouter') {
            url = 'https://openrouter.ai/api/v1/chat/completions';
            headers['Authorization'] = `Bearer ${req.apiKey}`;
        } else {
            headers['Authorization'] = `Bearer ${req.apiKey}`;
        }

        const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
        const data = await res.json();
        if (data.error) throw new Error(data.error.message);
        return data.choices[0].message.content;
    },

    async _directVision(req: AIRequestPayload): Promise<string> {
        try {
            const userMsg = req.messages[0];

            if (req.provider === 'openai') {
                const body: any = {
                    model: req.model,
                    messages: [userMsg]
                };
                if(req.responseFormat === 'json') body.response_format = { type: "json_object" };

                const res = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${req.apiKey}` },
                    body: JSON.stringify(body)
                });
                const data = await res.json();
                if (data.error) throw new Error(data.error.message);
                return data.choices[0].message.content;
            } else {
                // Convert standardized message content to Gemini format
                let text = "";
                let inlineData = null;
                if (Array.isArray(userMsg.content)) {
                    for (const part of userMsg.content) {
                        if (part.type === 'text' && part.text) text += part.text;
                        if (part.type === 'image_url' && part.image_url) {
                            const base64 = part.image_url.url.split(',')[1];
                            inlineData = { mimeType: "image/jpeg", data: base64 };
                        }
                    }
                }

                const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${req.model}:generateContent?key=${req.apiKey}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ contents: [{ parts: [{ text }, { inlineData }] }] })
                });
                const data = await res.json();
                if (data.error) throw new Error(data.error.message);
                if (!data.candidates || !data.candidates.length) throw new Error("No response");
                return data.candidates[0].content.parts[0].text;
            }
        } catch (e) { throw e; }
    },

    // -------------------------------------------------------------------------
    // LIVE MODEL FETCHING
    // -------------------------------------------------------------------------

    async fetchModels(provider: 'gemini' | 'openai' | 'anthropic' | 'openrouter', apiKey: string): Promise<TieredModels> {
        let all: string[] = [];

        if (provider === 'openrouter') {
            // OpenRouter model list is public; bearer token sent when present.
            const res = await fetch('https://openrouter.ai/api/v1/models', {
                headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}
            });
            if (!res.ok) throw new Error(`OpenRouter models fetch failed: ${res.status}`);
            const data = await res.json();
            all = (data.data || [])
                .map((m: any) => m.id as string)
                .filter((id: string) => !!id);
        } else if (provider === 'openai') {
            const res = await fetch('https://api.openai.com/v1/models', {
                headers: { 'Authorization': `Bearer ${apiKey}` }
            });
            if (!res.ok) throw new Error(`OpenAI models fetch failed: ${res.status}`);
            const data = await res.json();
            const ids: string[] = (data.data || []).map((m: any) => m.id as string);
            // Allowlist: only keep models with known chat prefixes
            const CHAT_PREFIX = /^(gpt-|o[0-9]|chatgpt-)/i;
            // Denylist: explicitly exclude non-chat even if prefix matched
            const EXCLUDE = /^ft:|sora|dall-e|whisper|^tts|text-embedding|text-moderation|babbage|davinci|curie|^ada|omni-mini/i;
            // Drop old dated snapshots (e.g. gpt-4-0314, gpt-3.5-turbo-0613)
            const OLD_SNAPSHOT = /-(03|06|09|12)(01|14|13|28|30)\b/;
            all = ids.filter(id => CHAT_PREFIX.test(id) && !EXCLUDE.test(id) && !OLD_SNAPSHOT.test(id));
        } else if (provider === 'gemini') {
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=100`);
            if (!res.ok) throw new Error(`Gemini models fetch failed: ${res.status}`);
            const data = await res.json();
            // Allowlist: only gemini-* chat models (excludes Imagen, Veo, PaLM/Bison/Gecko etc.)
            const GEMINI_CHAT = /^gemini-/i;
            // Denylist: vision-only, embedding, and non-chat Gemini variants
            const GEMINI_EXCLUDE = /embed|aqa|retrieval|vision(?!.*gemini)|imagen|veo|bison|gecko|^text-|legacy/i;
            all = (data.models || [])
                .filter((m: any) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
                .map((m: any) => (m.name as string).replace('models/', ''))
                .filter((id: string) => GEMINI_CHAT.test(id) && !GEMINI_EXCLUDE.test(id));
        } else if (provider === 'anthropic') {
            const res = await fetch('https://api.anthropic.com/v1/models', {
                headers: {
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                    'anthropic-dangerous-direct-browser-access': 'true'
                }
            });
            if (!res.ok) throw new Error(`Anthropic models fetch failed: ${res.status}`);
            const data = await res.json();
            all = (data.data || []).map((m: any) => m.id as string);
        }

        return _classifyModels(all);
    },

    // -------------------------------------------------------------------------
    // Function Breakdown — view-only structural decomposition
    // -------------------------------------------------------------------------

    async generateFFForRow(
        systemName: string,
        subsystemName: string,
        subsystemSpecs: string,
        funcDesc: string,
        breakdownSnippet: string,
        breakdownStandard: string,
        existingFailures: string[],
        key: string,
        modelName: string,
        aiProvider: string = '',
        azureEndpoint: string = '',
        powerAutomateUrl: string = '',
        systemContext: string = '',
        sessionId?: string,
        rowEvidence: 'evident' | 'hidden' = 'evident',
        rowParameters: StandardParameter[] = []
    ): Promise<{ desc: string; parameter?: string; failedState?: FailedStateType }> {
        if ((!key || key.length < 10) && aiProvider !== 'copilot') return { desc: '' };
        const existingBlock = existingFailures.length > 0
            ? `Existing Functional Failures already defined (DO NOT repeat or closely resemble):\n${existingFailures.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n\n`
            : '';
        // This is the manual top-up button beside a row. It generates one failure by
        // design, but it used to do so without the derivation rules, so the only
        // thing it could ever add was another total-loss line — useless for filling
        // the gap a user opens it to fill. It now sees the row's parameters and what
        // is already there, and is asked for the strongest remaining gap.
        const parameterBlock = rowParameters.length
            ? `Requirements inside that standard:\n${JSON.stringify(rowParameters, null, 2)}\n\n`
            : '';
        const prompt = `Context: System "${systemName}", Subsystem "${subsystemName}".
Subsystem Specs: "${subsystemSpecs || 'N/A'}"
Subsystem Function: "${funcDesc}"
Function label (black text): "${breakdownSnippet}"
Performance/condition standard (grey text): "${breakdownStandard || 'N/A'}"
This function is ${rowEvidence}.

${parameterBlock}${existingBlock}Task: Generate ONE Functional Failure for this row — the most significant failed state the standard supports that is NOT already covered by the list above. Pick the requirement and direction that is still missing.
${FMECA_HIERARCHY_RULES}
${FMECA_CONCISE_WORDING_RULES}
${FUNCTIONAL_FAILURE_TECHNICAL_RULES}
${JA1011_FAILED_STATE_RULES}
Use the function label and performance/condition standard as the primary source. The standard defines what "failed" means; do not ignore it.
Use the full subsystem function only to resolve ambiguity, not to add extra details.
Write a short professional FMECA failure state, not a narrative.
Length: 6-14 words.

Tag the failure so the coverage checker can see what it closed. Without "parameter" and "failedState" this failure is invisible to the check that reported the gap, and the gap keeps reporting itself.
Return ONLY strict JSON: { "desc": "...", "parameter": "the standardParameters entry it violates, or empty", "failedState": "total|partial|upper_limit|intermittent|on_demand" }`;

        const content = prompt + (systemContext ? '\n\n' + systemContext : '');
        try {
            const res = await this._withRetry(() => this.chat({
                feature: 'ff-for-row',
                provider: (aiProvider || inferProvider(key)) as any,
                azureEndpoint: azureEndpoint || undefined,
                powerAutomateUrl: powerAutomateUrl || undefined,
                sessionId,
                model: modelName,
                messages: [{ role: 'user', content }],
                mode: 'ai',
                refText: '',
                apiKey: key,
                responseFormat: 'json'
            }));
            // Tolerate a bare sentence: some providers ignore the JSON contract on a
            // single-field answer, and a usable failure should not be thrown away over
            // its wrapper.
            const parsed = this.extractJSON(res);
            const rawDesc = parsed && typeof parsed === 'object'
                ? String((parsed as any).desc ?? (parsed as any).failure ?? '')
                : String(res ?? '');
            // Empty desc, not a template: the caller leaves the row alone.
            const desc = this.cleanFunctionalFailureText(rawDesc) ?? '';
            if (!desc) return { desc: '' };
            const claimed = String((parsed as any)?.failedState ?? '').toLowerCase().trim() as FailedStateType;
            const validStates: FailedStateType[] = ['total', 'partial', 'upper_limit', 'intermittent', 'on_demand'];
            return {
                desc,
                parameter: this.cleanSingleFieldText(String((parsed as any)?.parameter ?? '')).toLowerCase() || undefined,
                // "lower_limit" folds to "partial", same as the batch path.
                failedState: claimed === 'lower_limit' ? 'partial' : (validStates.includes(claimed) ? claimed : undefined),
            };
        } catch {
            return { desc: '' };
        }
    },

    async decomposeFunction(
        funcDesc: string,
        subsystemName: string,
        projectName: string,
        key: string,
        modelName: string,
        aiProvider: string = '',
        azureEndpoint: string = '',
        powerAutomateUrl: string = '',
        systemContext: string = '',
        detailLevel: 'normal' | 'detailed' = 'detailed',
        subsystemSpecs: string = '',
        sessionId?: string,
        siblingSubsystems: string[] = []
    ): Promise<Array<{ function: string; standard: string; snippet: string; functionClass: FunctionClass; quantified: boolean; evidence: 'evident' | 'hidden'; standardParameters: StandardParameter[] }>> {
        if (!funcDesc?.trim()) return [];
        // Every other call in the generation chain answers with a fixture when
        // there is no key; this one returned nothing, which dead-ended Auto-Fill
        // and MasterGen at step two and left demo mode unable to reach a filled
        // FMECA at all. Split the function prose into rows so the keyless path
        // exercises the same shape the real one produces.
        if ((!key || key.length < 10) && aiProvider !== 'copilot') {
            await new Promise(r => setTimeout(r, 800));
            return funcDesc
                .split(/(?:\.\s+|\band\b|;|,)/i)
                .map(part => part.trim())
                .filter(part => part.length > 8)
                .slice(0, 4)
                .map(part => ({
                    function: part.replace(/\.$/, ''),
                    standard: 'within operating range',
                    snippet: part,
                    functionClass: 'primary' as FunctionClass,
                    quantified: /\d/.test(part),
                    evidence: 'evident' as const,
                    standardParameters: [] as StandardParameter[]
                }));
        }

        const contextLine = (subsystemName || projectName)
            ? `Subsystem: "${subsystemName}"${projectName ? ` within System: "${projectName}"` : ''}\n\n`
            : '';

        // Step one already knows which subsystems sit alongside this one; step two
        // did not, so a duty delivered through a neighbouring subsystem's hardware
        // (a standby start through the MCC, a changeover through the control system)
        // had nothing to check itself against and became a row here.
        const siblingBlock = buildSiblingSubsystemBlock(siblingSubsystems, 'functions');

        // Without specs the breakdown can only quantify what survived into the
        // function prose, so every standard degraded to "within operating range".
        const specsBlock = subsystemSpecs.trim()
            ? `Subsystem Specs (use these verbatim to quantify each standard):\n"""\n${subsystemSpecs}\n"""\n\n`
            : '';

        const detailRule = detailLevel === 'normal'
            ? 'Return 3-6 rows, one per distinct function. Prefer fewer rows when two rows would fail in the same way.'
            : 'Return 4-8 rows, one per distinct function. Split only genuinely distinct functions, never values, tags, devices, or sentence parts.';

        const prompt = `Role: You are a senior FMECA facilitator. Your task is not text splitting. Your task is to identify Functional Failure seeds from a subsystem Function description. Be deterministic: given the same input, always produce the same rows.
${FMECA_HIERARCHY_RULES}
${FMECA_CONCISE_WORDING_RULES}
${FUNCTION_BREAKDOWN_TECHNICAL_RULES}

${contextLine}${specsBlock}${siblingBlock}Function description:
"""
${funcDesc}
"""

Use this method silently:
1. Read the whole description as one subsystem duty in its operating context.
2. Identify the primary function: what the subsystem exists to deliver.
3. Identify every secondary function the description or specs support: containment, protection, control, support, efficiency. Do not skip a class merely because the description states it briefly.
4. For each function, write its performance standard. Take exact values from the Specs whenever they exist; only fall back to qualitative wording when no value is available.
5. Split each standard into its separate measurable requirements. Ask what the standard is really requiring: a flow AND a pressure AND a temperature AND a quality grade are four requirements that fail independently, not one. Record each as a parameter with its bound.
6. Decide whether each function is evident or hidden. A function is hidden when its failure would not be apparent to operating staff under normal circumstances — standby duties, protective duties, and anything demanded only intermittently.
7. Treat monitoring references, control architecture, locations, identifiers, and personnel instructions as supporting context, not functions. A protective DUTY is a function; the device performing it is not.
8. Where the description states a redundancy or duty arrangement, write the OUTCOME it delivers as the function and move the arrangement into the standard. "2 x 100%, one duty one standby, lead/lag" is not a function; "maintain supply when the duty unit fails" is, and it is hidden.
9. Merge two functions when they would fail in the same way and produce the same failure.
10. Before final answer, audit silently:
   - Did I miss a containment or protection function that the specs imply?
   - Did I create a row for an operating envelope, an equipment condition, or a design arrangement instead of a function?
   - Did I create a row for a design rating that is really another row's standard? A rating is not a duty.
   - For each protective function: is its standard the trip or set point rather than a rating, and is it written as a capability?
   - Did I leave a standard qualitative when the Specs held a number?
   - Did I split every standard that holds more than one requirement into separate parameters, WITHOUT promoting design ratings into parameters?
   - Did I mark standby and protective functions as hidden?
   - Where the context flagged a CONFLICT covering a value I used, did I keep it as one requirement and note the conflict, rather than treating each conflicting value as its own?

${detailRule}

JSON field rules:
- function = concise functional verb + object, 2-7 words. No leading "to", no gerund.
- standard = the required performance standard. Use exact values and units from Specs when available, 3-12 words.
- standardParameters = array, one entry per separate requirement inside "standard". Each: { "name": what is required, "value": the value as written, "unit": unit string or null, "bound": "min" | "max" | "target" | "range" | "spec" }. Empty array only when the standard holds no measurable requirement at all.
- quantified = true only when "standard" contains a real measurable value.
- functionClass = exactly one of: primary, containment, protection, control, support, efficiency.
- evidence = "evident" or "hidden".
- snippet = verbatim source slice from the original description, 15-80 characters.

Return ONLY this JSON, no prose, no markdown:
{ "rows": [ { "function": "...", "standard": "...", "standardParameters": [ { "name": "...", "value": "...", "unit": "...", "bound": "min" } ], "quantified": true, "functionClass": "primary", "evidence": "evident", "snippet": "..." } ] }`;

        const content = prompt + (systemContext ? '\n\n' + systemContext : '');
        try {
            const parsed = await this._withRetry(async () => {
                const res = await this.chat({
                    feature: 'function-decomposition',
                    provider: (aiProvider || inferProvider(key)) as any,
                    azureEndpoint: azureEndpoint || undefined,
                    powerAutomateUrl: powerAutomateUrl || undefined,
                    sessionId,
                    model: modelName,
                    messages: [{ role: 'user', content }],
                    mode: 'ai',
                    refText: '',
                    apiKey: key,
                    responseFormat: 'json'
                });
                const p = this.extractJSON(res);
                if (!p || !Array.isArray(p.rows)) throw new Error('decompose: bad shape');
                return p;
            });
            const rawRows: RawBreakdownRow[] = parsed.rows
                .map((r: any) => this.cleanBreakdownRow({
                    function: String(r?.function ?? '').trim(),
                    standard: String(r?.standard ?? '').trim(),
                    snippet: String(r?.snippet ?? '').trim(),
                    functionClass: String(r?.functionClass ?? r?.function_class ?? '').trim(),
                    quantified: Boolean(r?.quantified),
                    evidence: String(r?.evidence ?? '').trim(),
                    standardParameters: r?.standardParameters ?? r?.standard_parameters,
                }))
                .filter((r: any) => r.function && r.standard);

            return buildBreakdownRows(rawRows, subsystemName, projectName, detailLevel);
        } catch {
            return [];
        }
    },

    async matchFFsToBreakdown(
        funcDesc: string,
        subsystemName: string,
        projectName: string,
        rows: Array<{ id: string; function: string; standard: string; snippet: string }>,
        failures: Array<{ id: string; desc: string }>,
        key: string,
        modelName: string,
        aiProvider: string = '',
        azureEndpoint: string = '',
        powerAutomateUrl: string = '',
        systemContext: string = '',
        sessionId?: string
    ): Promise<Array<{ rowId: string; failureIds: string[] }>> {
        if (!rows.length || !failures.length) return [];
        if ((!key || key.length < 10) && aiProvider !== 'copilot') return [];

        const rowList = rows.map((r, i) => `${i + 1}. rowId: "${r.id}" | function: "${r.function}" | standard: "${r.standard}"`).join('\n');
        const failList = failures.map((f, i) => `${i + 1}. failureId: "${f.id}" | desc: "${f.desc}"`).join('\n');

        const prompt = `You are a reliability engineer. Match each Functional Failure to the breakdown row it best covers.

Subsystem: "${subsystemName}" within System: "${projectName}"
Function description: "${funcDesc}"

BREAKDOWN ROWS:
${rowList}

FUNCTIONAL FAILURES:
${failList}

Rules:
- Each failure should be matched to AT MOST ONE row (the one it best covers).
- A row may have zero, one, or multiple failures matched to it.
- A failure that doesn't clearly cover any row should be left unmatched (omit its failureId from all rows).

Return ONLY this JSON, no prose, no markdown:
{ "matches": [ { "rowId": "<rowId>", "failureIds": ["<failureId>", ...] } ] }
Include an entry for every row, even if failureIds is empty.`;

        const content = prompt + (systemContext ? '\n\n' + systemContext : '');
        try {
            const res = await this.chat({
                feature: 'breakdown-matching',
                provider: (aiProvider || inferProvider(key)) as any,
                azureEndpoint: azureEndpoint || undefined,
                powerAutomateUrl: powerAutomateUrl || undefined,
                sessionId,
                model: modelName,
                messages: [{ role: 'user', content }],
                mode: 'ai',
                refText: '',
                apiKey: key,
                responseFormat: 'json'
            });
            const parsed = this.extractJSON(res);
            if (!parsed || !Array.isArray(parsed.matches)) return [];
            return parsed.matches.map((m: any) => ({
                rowId: String(m?.rowId ?? ''),
                failureIds: Array.isArray(m?.failureIds) ? m.failureIds.map(String) : [],
            })).filter((m: any) => m.rowId);
        } catch {
            return [];
        }
    },
};

export interface TieredModels {
    pro: string[];
    balanced: string[];
    efficient: string[];
    fetchedAt: number;
}

function _getTier(id: string): 'pro' | 'balanced' | 'efficient' {
    const s = id.toLowerCase();
    // P1: deep-research → always Pro (most capable task type, regardless of model size)
    if (s.includes('deep-research') || s.includes('deepresearch')) return 'pro';
    // P2: efficient — small/fast/cheap model keywords
    if (/\b(mini|flash|haiku|lite|small|nano|micro|basic|instant|speed)\b/.test(s)) return 'efficient';
    // P3: pro — capability or top-tier markers
    if (/\b(pro|opus|plus|ultra|large|advanced|max|heavy|premium|turbo)\b/.test(s)) return 'pro';
    // P4: OpenAI o-series reasoning models (o3, o4, o5…) without mini — Pro
    if (/^o[3-9](-\d{4}-\d{2}-\d{2})?$/.test(s)) return 'pro';
    // P5: everything else is Balanced
    return 'balanced';
}

function _classifyModels(ids: string[]): TieredModels {
    const buckets: Record<'pro' | 'balanced' | 'efficient', string[]> = { pro: [], balanced: [], efficient: [] };

    for (const id of ids) {
        buckets[_getTier(id)].push(id);
    }

    // Sort each bucket so newest (highest version / latest date suffix) comes first
    const sortDesc = (a: string, b: string) => b.localeCompare(a, undefined, { numeric: true });
    return {
        pro: buckets.pro.sort(sortDesc),
        balanced: buckets.balanced.sort(sortDesc),
        efficient: buckets.efficient.sort(sortDesc),
        fetchedAt: Date.now()
    };
}
