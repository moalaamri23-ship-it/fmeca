# Functional-failure bloat in MasterGen: diagnosis and proposed fixes

Read-only investigation, 2026-10-13. Code is at `ab3a0f3`, the baseline after the revert. Evidence comes from two MasterGen exports of the Instrument Air Compressor Package (Thulailat):

| Export | Subsystems | Breakdown rows | FFs | FFs per row |
|---|---|---|---|---|
| `(2).json` | 6 | 28 | 57 | 2.04 |
| `(3).json` | 8 | 33 | 61 | 1.85 |

Both runs used the same `desc`, no `operatingContext`, and no System Modes.

---

## 1. Summary

The bloat is not mainly a failed-state problem. It comes from three things that multiply together:

1. **No step allocates functions across the system.** Every subsystem is generated alone, in a pool of six workers. Each one receives the whole package description and only the *names* of its siblings. Each subsystem claims every stream property, duty and rating it can see. For series stream equipment (compressor → dryer → filters → receivers) this means the same flow, pressure, temperature, quality or condensate requirement is claimed by two to four subsystems. **This is the largest cause.**
2. **The function description is generated as prose and then mined for rows, with a coverage checklist on the way in and a row floor on the way out.** The five-dimension description checklist and "write every Specs value into the standard" push ratings, supplies, certifications and pass-through conditions into the prose. `decomposeFunction` then has to return "4-8 rows", and it mines that prose faithfully. Each clause becomes a row, and each row becomes about two FFs.
3. **In practice, failed states are produced per parameter.** The prompt intends selection, but the output follows a formula: FFs per primary row ≈ 1 (total) + 1 per directional parameter + often 1 intermittent. Parameters come from specs, so a spec leak becomes FFs directly. The *kind* of function (passive capacity, binary capability, controlled variable) is never stated anywhere, so nothing tells the FF step that a fixed vessel volume cannot fail "partially".

All three of the user's hypotheses hold up, with one correction. In these two runs, the cross-subsystem duplication is mostly **stream-property duplication along the process path**, not control-loop duplication. The control loop and the standby takeover stayed mostly in the UCP in both runs. The leak into other subsystems' descriptions is still visible: "when running as the duty unit", "each motor drives one compressor of the duty/standby pair". The reverted ownership rules aimed at the control loop, so they could not have fixed the larger stream-path duplication even if they had worked.

My engineering judgement, row by row in §3, is that **about 58% of run (2) and 51% of run (3) is bloat** (33/57 and 31/61). A defensible FMECA for this package has about 24–30 FFs.

**First change to make:** add a single **system-level function-allocation step** between `generateMasterStructure` and the per-subsystem pool. It produces, as data, what each subsystem owns, what it only passes through or receives, and what kind of function each owned duty is. Every downstream step is then fed from that allocation instead of re-deriving it in isolation (§5, S1).

---

## 2. What each step actually sees

MasterGen is `App.tsx:2537`. The subsystem pool runs at `App.tsx:2590-2591`, with concurrency 6 by default (`App.tsx:126-127`): 2 for OpenRouter and 12 for Copilot. Inside the pool, each subsystem runs its five steps one after another. Different subsystems run in parallel and never see each other's outputs. `sessionId` only matters for the Copilot provider (server-side thread). For direct providers every call is stateless.

| # | Step (code) | Runs | System description | Reference file (`attachContext`) | Siblings | Earlier outputs | Specs |
|---|---|---|---|---|---|---|---|
| 1 | `generateMasterStructure` `AIService.ts:1671` | once, serial | name + `desc` | **yes** (`aiSourceMode`) | n/a, it creates them | none | creates them; no `SPECS_BOUNDARY_RULES` here |
| 2 | `generate("Function")` `AIService.ts:1585-1595`, called `App.tsx:2598` | pool | full `desc` via `buildSystemDescriptionBlock` (`:122`) | **yes** | **names only** (`:113`) | own specs | own specs |
| 3 | `decomposeFunction` `AIService.ts:3183`, called `App.tsx:2607` | pool | full `desc` again, inside `projectName` (`projectContext`, `App.tsx:2561`) | **no** (`mode:'ai', refText:''`) | names only | own func | own specs, "use these verbatim" (`:3235`) |
| 4 | `generateFFsForBreakdownRows` `AIService.ts:1778`, called `App.tsx:2618` | pool | full `desc` inside `systemName` | **no** | names only, with the instruction "their functional failures belong to them" but **without the failures** | own func and rows | own specs |
| 5 | `generateModesForFailuresBatch`, then `evaluateRpnBatch` | pool | name + desc | yes | none | own FFs | own specs |

What a subsystem **cannot** see of a sibling: its specs, its function, its rows, its FFs, its boundary. So the sibling block (`buildSiblingSubsystemBlock`) asks the model to exclude content it has never been shown.

Other context facts:

- `Project.operatingContext`, the structured JA1011 Q1 data for redundancy, duty and environment, is **never passed to any generation step**. `grep operatingContext services/AIService.ts` returns nothing. It is the one structured, system-level context the app already has, and the pipeline ignores it.
- `masterSystemContext`, passed as `systemContext` to the FF step (`App.tsx:2632`), is only the System Modes component catalog. Without System Modes it is empty.
- Step 1 is the only step with a wide view, and it is asked only for names and specs (`AIService.ts:1684-1695`). Its subsystem count is a soft range ("3-4 … up to 8"), with no boundary definition, so the split varies from run to run. Run (2) and run (3) had the same input and different splits.

---

## 3. Quantifying the bloat

### 3.1 Where the counts come from

| Subsystem | (2) rows / FFs | (3) rows / FFs |
|---|---|---|
| Compressor | 4 / 8 | 5 / 11 |
| Drive motor | 2 / 4 | 2 / 5 |
| Dryer | 7 / 16 | 6 / 11 |
| Dryer filtration | — | 4 / 6 (new subsystem) |
| Wet receiver | 4 / 6 | 3 / 4 |
| Dry receiver | 4 / 8 | 3 / 4 |
| UCP | 7 / 15 | 6 / 12 |
| Air-oil cooler and lube | — | 4 / 8 (new subsystem) |

Mean FFs per row, from both runs, by class and by number of non-`spec` parameters:

| Row class, directional params | Rows | Mean FFs |
|---|---|---|
| primary, 0 | 12 | 1.58 |
| primary, 1 | 8 | 1.88 |
| primary, 2 | 5 | 2.40 |
| primary, 3 | 4 | 4.25 |
| control, 1 | 3 | 3.00 |
| protection, any | 8 | 1.0–1.3 |
| containment, 0 | 11 | 1.27 |

FF count rises with parameter count. Protection rows stay at about one FF each, because the prompt contains a class-specific rule for them (`AIService.ts:222`). That is the one place where the model was told what kind of function it was looking at, and it is the one place where the output is disciplined.

The template shows up across runs. Compressor R0 came out with the same five FFs in both runs: no air, below 599 Sm3/hr, below 9.0 barg, above 60 °C, and erratic. UCP R0 came out as total / below / above / erratic in both runs, which is all four directions on a single parameter. Failed-state mix: (2) 28 total/on-demand, 18 partial, 3 upper, 8 intermittent. (3) 30 / 17 / 6 / 8. That is roughly one intermittent FF per subsystem.

### 3.2 Duties claimed by several subsystems (same physical state)

**Run (2)**
- Low instrument-air pressure: Compressor "Discharge pressure falls below 9.0 barg", UCP "Holds discharge pressure below required set point", Dryer "Delivers dried air below 8.0 barg", Dry receiver "Delivers instrument air below 8.0 barg". One header state, four FFs. Only the UCP (fails to load) and the dryer (restriction) are distinct functions.
- Low flow: Compressor "below 599 Sm3/hr", Dryer "below 510 Sm3/hr", Dry receiver "Passes instrument air below 510 Sm3/hr". The receiver is a passive pass-through.
- High temperature: Compressor "exceeds 60 deg C", Dryer "Delivers dried air above 60 deg C". The dryer does not heat air.
- Erratic supply: Compressor "Supplies instrument air erratically" and UCP "Controls discharge pressure erratically".
- Wet air downstream: 8 FFs inside the dryer (3 on dew point, 3 on regeneration, 2 on purge air). Regeneration and purge are the *mechanism* of drying, not separate functions.

**Run (3)**
- High discharge temperature: Compressor "Delivery temperature exceeds 60 deg C", Cooler "Insufficient heat rejection, discharge temperature exceeds operating range", and Cooler "oil temperature above operating range".
- Air quality (particles and oil): Dryer "Delivered air below ISO 8573-1 required quality classes", Filtration × 4, and Compressor oil separation × 2. That is 7 FFs. The new Filtration subsystem took over a duty the Dryer still claimed.
- Condensate carry-over: Compressor moisture separator × 2, Wet receiver × 2, Dry receiver × 2.
- Dew point: Dryer × 3, regeneration × 2, UCP dew-point monitor × 2.
- Shaft power: Motor "Does not convert electrical supply to shaft power" and "Does not drive compressor block". These are two rows for one duty, both written as total loss.

### 3.3 Engineering-implausible FFs (examples)

| Kind | Examples |
|---|---|
| Partial state on a function that can only fail totally | "Stores compressed air below required 8.5 m3 capacity", "Stores below 18 m3 required air buffer" (2). A fixed vessel volume does not shrink. |
| Rating or capacity written as a deliverable | Motor "Delivers shaft power below 110 kW requirement" while the compressor absorbs 80 kW; "Drives compressor block below 2960 rpm" (an induction motor's speed is set by the supply frequency); "Drives cooler fan below 5 kW" (consumption); "Desiccant adsorption capacity declines before 5 years" (design life) |
| Own supply or certification written as a function | UCP "Loses 415 V, 3 Ph power", "Loses 240 V, 1 Ph control power", "LCP components breach ATEX Zone 2 integrity" |
| Pass-through property owned by an upstream item | Dry receiver below 8.0 barg and below 510 Sm3/hr; Dryer above 60 °C |
| Cause or mechanism inside the FF text | "Delivers shaft power erratically on unstable supply", "Leaks compressed air through degraded pressure boundary", "Offline column not regenerated; desiccant stays saturated" |
| Monitoring written as a function | UCP "Provides no monitoring…", "Monitors … intermittently" |
| Same-consequence states written as separate FFs | "Does not control discharge pressure" next to "below SP" and "above SP"; "Removes particulates below 99.99%" next to "Does not remove particulates" |

There are also **omissions**. Over-generation does not mean the coverage is complete. The drive motor of a duty/standby pair has no "fails to start on demand". The wet receiver (both runs) and the dry receiver (run 3) have no PSV relief row, even though run (3)'s function text names the PSVs. Run (3)'s compressor has no air-containment row.

### 3.4 Attribution by stage (run 2, judged row by row)

I marked each of the 57 FFs as keep, or as bloat attributed to the stage where the error first entered:

| Stage of origin | FFs | Examples |
|---|---|---|
| Kept (defensible) | 24 | |
| **Function description**: content the subsystem does not own, or that is not a function | 11 | Motor 110 kW; Dryer 60 °C; Dry receiver 8.0 barg and 510 Sm3/hr; UCP power × 2 and ATEX; UCP monitoring × 2; Dryer purge × 2 |
| **Breakdown**: one duty split into several rows | 8 | Motor speed row; Dryer regeneration × 3; Dryer "retain particulates" next to "deliver clean air"; Receiver "store" next to "contain"; Wet receiver "separate" next to "drain" |
| **Failed-state enumeration**: same consequence, implausible direction, cause in text | 14 | Compressor below 9 barg and erratic; Dryer erratic, below 8 barg, oil class; Receiver capacity partial × 2; Receiver leak and drain-insufficient; UCP total, erratic, out-of-sequence, intermittent comms; Motor unstable supply |

Run (3) is similar: 30 kept, 31 bloat. Its subsystem split added two subsystems carrying 14 FFs, of which about 7 duplicate duties that the dryer and compressor still claimed. **The split adds bloat only because nothing reallocates duties when a split happens.** A subsystem added through step 1 inherits the 4-row floor and the full description, and its parent keeps everything it had before.

About **19 of 33 bloat FFs (≈ 58%) are created upstream of the FF step** (description and breakdown), and nearly all of them are ownership or boundary errors. Those are the errors a system-wide allocation prevents. Most of the other 14 come from the FF step not knowing what *kind* of function it is looking at.

---

## 4. Root causes, ranked by the bloat they explain

### RC1. No system-level allocation of functions, so each isolated subsystem claims everything it can see (≈ 15–20 FFs per run)
- Evidence in code: the pool at `App.tsx:2591` and the sibling-names-only block at `AIService.ts:113-117`. The full `desc` is injected into steps 2, 3 and 4 (`AIService.ts:122-126`, `App.tsx:2561`, `2607`, `2618`), with no statement of which of its duties belong to the current subsystem.
- Evidence in data: §3.2. Pass-through properties appear in every series item. Run (2) has the dry-receiver function "stores and contains dried instrument air at an inlet/outlet capacity of 510 Sm3/hr, 8.0 barg, and 60 deg C". Run (3) has the Filtration subsystem duplicating the Dryer's ISO 8573 row.
- Contributing: step 1 produces specs without boundary rules, so specs leak. The motor's specs carry "Fan motor power: 5 kW (air-oil cooler fan)". The wet receiver's specs (3) carry the load/unload set points SP-14/SP-15 and a level alarm. The spec rule "always include inlet/outlet conditions, rated capacity…" (`AIService.ts:110`) applies to the Specs wand. Its spirit leaks into the function rule "write the performance standard as an exact value whenever Specs provides one" (`:140`) and into the breakdown's "use these verbatim" (`:3235`).
- Why the reverted fix failed: 80358c3 tried to make each **isolated** subsystem guess ownership from a regex on its siblings' names (`CONTROL_OWNER_PATTERN`, `PASSIVE_EQUIPMENT_PATTERN`). It covered only control and standby duties, not stream properties. It added text to every prompt, and the next run changed the split (d6f0b5f's "every driver is its own subsystem"), which no per-subsystem rule can absorb. Ownership is a property of the whole system. It cannot be inferred reliably from inside one subsystem.

### RC2. The function description is a prose seed that a fixed row quota mines (≈ 8–12 FFs per run)
- `FUNCTION_DESCRIPTION_TECHNICAL_RULES` (`AIService.ts:133-145`) is a five-dimension coverage list: mission, controlled performance, envelope, containment, protection and duty. It is applied to *every* subsystem, a receiver as much as a control panel, and it says to state the duty "when the system context states one" (`:139`), which the context always does.
- `decomposeFunction` in `detailed` mode, which is always the mode MasterGen uses (`App.tsx:2607`), requires **"Return 4-8 rows"** (`AIService.ts:3240`). A receiver has two real functions (contain, drain) plus a protective one if it has a PSV. The floor produced "store", "contain", "separate", "drain" in run (2).
- Every row's `snippet` is a verbatim slice of the description, so the rows are a faithful translation of the prose. Any clause that should not exist becomes a row, then about two FFs, then about two modes each, then RPN scores. The prose is the narrowest point of the pipeline, and it has the weakest structure.

### RC3. Failed states come out per parameter, because nothing declares what kind of function a row is (≈ 10–14 FFs per run)
- The prompt's intent is good (`AIService.ts:206-230`, "SELECT … declining is free"). In practice, the model receives a `standardParameters` list plus a four-direction vocabulary, and the task line asks for completeness: "every failed state a user would respond to differently" (`:1826`). The output follows the formula in §3.1.
- `bound` is assigned in the breakdown step with no physics behind it. Capacity got `min` in run (2), which produced "stores below 8.5 m3". It got `spec` in run (3), which produced total only. The same equipment got different credible states depending on a field the breakdown step chose almost arbitrarily.
- The FF step is never told whether the row is passive or active, binary or continuous, or delivered or consumed. The one class it *is* told about (protection) behaves correctly. That is the strongest evidence that **declared function type, not more vocabulary rules, is what disciplines the failed-state count.**
- `CoverageCheck` raises an "Uncovered requirement" gap for any parameter with no FF (`CoverageCheck.ts:183-189`). It is report-only, but it nudges users to fill pass-through and rating parameters that should never have been parameters.

### RC4. Subsystem split is unstable and does not rebalance (accounts for the 57 vs 61 variance and about 7 duplicates in run 3)
- Step 1 has no boundary definition, so the same input gave 6 and 8 subsystems. When a sub-assembly (filters, cooler) becomes its own subsystem, the parent's description still includes it, because steps 2–4 never see the sibling's scope.

### RC5. Plumbing defects that hide the problem (no FFs directly, but they block measurement and validation)
- MasterGen **drops `failedState`, `parameter` and `needsReview`** when it builds the saved subsystems (`App.tsx:2732`). Both exports have them as `null`. The coverage checker and any audit of "which states were generated" are blind for MasterGen output, which is why §3 had to classify states from the text.
- `isControlSubsystem` (`AIService.ts:468`) tests `subsystemName + projectName`. In MasterGen, `projectName` is the full description, which contains "Control", "UCP", "PCS" and "Instrument". The flag is therefore true for **every** subsystem, which turns off the monitoring and safeguard skips in `buildBreakdownRows`. 80358c3 fixed this and was reverted along with everything else. The impact is low in these runs, but it is a latent bug.
- `operatingContext` is collected and then ignored by generation (§2).

---

## 5. Proposed solutions (architectural, general to any system)

None of these adds a rule about a kind of equipment. The approach is to move decisions to the step that has the information to make them, and to pass those decisions downstream as structured data.

### S1. System function-allocation plan, one call before the pool (recommended first)

**What changes.** Add a step between `generateMasterStructure` and the per-subsystem pool. Alternatively, merge it into step 1. It sees the full description, the reference file, `operatingContext` and the full subsystem list. It returns one structured plan:

```ts
type FunctionPlan = {
  subsystems: Array<{
    name: string;
    boundary: { includes: string[]; excludes: string[] };      // which hardware is inside
    nature: 'active-machine' | 'driver' | 'stream-conditioner' | 'passive-containment'
          | 'control-protection' | 'support' | 'other';         // free label, not a regex input
    changes: string[];      // stream/energy properties this subsystem CHANGES (pressure ↑, moisture ↓, temp ↓)
    receives: string[];     // properties it only passes through or consumes, with the owning sibling
    duties: Array<{
      fn: string; cls: FunctionClass; evidence: 'evident'|'hidden';
      standardSource: string;   // which spec value defines it
      failureShape: 'binary' | 'below-only' | 'above-only' | 'band' | 'conformance' | 'on-demand';
      why: string;
    }>;
  }>;
  systemDuties: Array<{ duty: string; owner: string; why: string }>; // header pressure, standby availability, ESD …
  specAssignments: Record<string, string[]>; // which spec lines belong to which subsystem
};
```

**Where.** A new `AIService.planSystemFunctions(...)`. In `masterGen`, call it after `App.tsx:2554` and before `runPool`. Pass each subsystem's plan entry, together with a short "owned elsewhere" list (sibling duties and their owners), into steps 2, 3 and 4 in place of the sibling-names block. `decomposeFunction` then *elaborates the allocated duties* (standards, parameters) and does not discover rows, so the "4-8 rows" floor is removed for MasterGen calls. The FF step gets `failureShape` per row. Store the plan on the project so Auto-Fill and Redecompose reuse it. It should also be viewable and editable: an analyst approving the function list is standard JA1011 practice, not overhead.

**Expected effect.** Removes most RC1 and much of RC2: pass-through properties, misowned control and standby duties, rating rows, and duplicated quality and condensate duties. On the run (2) classification, about −15 to −20 FFs. It also stabilises splits, because a split and its consequences (what moves out of the parent) are decided in one place.

**Cost.** +1 serial call before the pool. It is large (whole description, reference file and output for every subsystem), so expect +20–60 s. Steps 2–4 get shorter prompts, because the sibling block and much of the description boilerplate are no longer needed.

**Risks.**
- The plan is a single point of failure: a wrong allocation propagates everywhere. Mitigations: it is visible and editable, and steps 2–4 may add an *owned* duty the plan missed, flagged as `needsReview`.
- Large systems (15+ subsystems) can strain output length. Mitigation: chunk by subsystem after a first pass that allocates only the system duties.
- The model may under-allocate (omissions). The plan output must be checked for coverage of protective and hidden duties.

**How it differs from what was reverted.** Ownership is decided once, by a model that sees the whole system, and is passed on as data. The reverted approach guessed it in every subsystem, from regex on names, as prompt prose.

### S2. Make the function list the seed, and derive the prose description from it

**What changes.** Invert steps 2 and 3. With S1 in place, the per-subsystem step produces structured rows directly (function, class, evidence, standard, parameters, failure shape), and the prose `func` is written *from* the rows in the same call or a cheap follow-up. Drop the five-dimension checklist as a generation driver. It stays meaningful only as a review checklist.

**Where.** `generate("Function")` (`AIService.ts:1585`) and `decomposeFunction` (`:3183`) become one call for MasterGen and Auto-Fill. The manual wand paths can stay as they are.

**Expected effect.** Removes the prose-to-row amplification and the row floor: about −5 to −8 FFs beyond S1. Function descriptions become shorter and agree with the rows by construction.

**Cost.** −1 call per subsystem, so cheaper and faster.

**Risks.** Many downstream prompts (modes, RPN, chatbot, RCM export) read `func`, so its quality must hold. Validate by comparing mode quality before and after. A user who edits the prose afterwards has to Redecompose, which is the existing hash check (`funcHashAtBreakdown`).

### S3. Failed states from a declared function shape, not from parameters

**What changes.** Each row carries `failureShape` (from S1, or produced by the breakdown step in its absence), with a reason. The FF step writes only the states that shape admits, and it may *add* a state with a stated reason, flagged `needsReview`.
- `binary` → total, or on-demand if hidden.
- `below-only` → total + partial.
- `band` → partial + upper.
- `conformance` → one off-spec state.

Parameters become *quantification* of a state, not *generators* of states. Several parameters that move together produce one FF that names the governing value.

**Where.** `RawBreakdownRow` and `BreakdownRow` (`types.ts`); the breakdown output schema; `generateFFsForBreakdownRows` (`AIService.ts:1778`) uses the shape as the expected set. `CoverageCheck` reports against the shape, not per parameter. That removes the push in RC3.

**Expected effect.** About −8 to −12 FFs: the per-parameter fan-out, the reflexive intermittent, and partial states on capacities. It also improves omissions, because "on-demand" becomes an expected state for hidden duties such as a standby motor start.

**Cost.** No new calls. A few output tokens per row.

**Risks.** A wrong shape suppresses a real state. Mitigations: the FF step can override with a reason, and the shape is visible in the breakdown modal. This is a schema field, not a vocabulary rule, but it must not turn into a lookup table keyed by equipment type. The shape is judged per function in context.

### S4. Barrier and system-level review after the breakdown (complement or fallback to S1)

**What changes.** Split the pool into two phases: (A) function and breakdown for all subsystems, then a barrier, then (B) FFs, modes and RPN. At the barrier, one call sees **all** subsystems' rows (not their names) and returns merge, reassign and drop proposals, each with a reason. The proposals are shown to the user, or applied with a visible diff. In phase B, each subsystem's FF prompt gets its siblings' *rows* instead of their names.

**Where.** `masterGen` in `App.tsx:2591-2720` (two `runPool` passes), plus a new `AIService.reviewSystemFunctions`.

**Expected effect.** Catches the duplicates S1 misses, and works on its own if S1 is not wanted: about −8 to −12 FFs. It is weaker than S1 because it corrects after the descriptions are written.

**Cost.** +1 serial call. The barrier removes overlap between phases, so wall-clock time grows by roughly the slowest subsystem's FF, mode and RPN chain.

**Risks.** Auto-applied deletions can remove real duties. Keep them as proposals or apply them reversibly.

### S5. Plumbing and measurement (prerequisite, small)
- Persist `failedState`, `parameter` and `needsReview` in MasterGen's save (`App.tsx:2732`). Without this, no validation run can be audited automatically.
- Add a **report-only** cross-subsystem metric to `CoverageCheck.checkProject`: the same parameter name and value claimed by two or more subsystems (today it flags only *different* values for the same name). This is the duplication signature, and it gives every live run a deterministic score.
- Pass `operatingContext` to the plan step (S1) or, without S1, to steps 2–4.
- Use the subsystem name only in `isControlSubsystem`.

None of these changes behaviour much. They make S1–S4 measurable.

### Ranking

| Rank | Solution | FF reduction (est., this package) | Extra calls | Risk |
|---|---|---|---|---|
| 0 | S5 measurement and plumbing | ~0 (enables validation) | 0 | very low |
| 1 | **S1 system function-allocation plan** | −15 to −20 | +1 serial | medium (single point, mitigated by review) |
| 2 | S3 declared failure shape | −8 to −12 | 0 | low–medium |
| 3 | S2 structured seed, prose derived | −5 to −8 beyond S1 | −1 per subsystem | medium (prose quality) |
| 4 | S4 barrier and system review | −8 to −12 (overlaps S1) | +1 serial | medium |

**The single change to make first is S1**, after the S5 save fix and duplication metric, because without those a live run cannot show whether S1 worked. S1 is the only change that targets the largest cause (RC1). It also gives S2 and S3 their inputs: `failureShape` and the owned-duty list naturally come out of the plan. S3 is the best second step. It is cheap, needs no extra calls, and addresses most of what S1 leaves behind.

---

## 6. Validation protocol (live runs, as CLAUDE.md requires)

The unit tests cannot detect a prompt regression. Each change should be validated with live MasterGen runs on **at least three systems of different kinds**, two runs each to measure variance, plus a regression run on this compressor package:

1. **LV switchboard / MCC**: non-rotating, no process fluid; protection-heavy and supply-heavy. Checks that "own supply" and certifications do not become functions, and that protective functions survive.
2. **Shell-and-tube heat exchanger, or an HVAC air-handling unit**: a passive stream conditioner with pass-through flow. Checks the stream-property allocation, which is RC1's main form.
3. **Duty/standby centrifugal pump set with motor drivers and a control panel**: the same redundancy pattern as here, in a different domain. Checks that the standby takeover and load control appear once, and that driver start-on-demand is present.

Metrics per run. Once S5 is in, all except the expert sample can be computed from the export:
- Total FFs and FFs per subsystem. Watch for both directions: a large drop with lost protective or hidden rows is a regression, not a success.
- **Cross-subsystem duplicate parameters** (S5 metric). The target is 0 for pass-through properties.
- Share of FFs per failed state. Intermittent should fall from about 1 per subsystem to only where it is credible. There should be no partial state on capacity or `spec` parameters.
- Number of hidden and protection rows, and `on_demand` FFs. These must not fall versus baseline.
- Subsystem count variance across the two runs of the same input.
- Expert sample: 20 random FFs per run marked keep, merge or drop. Target: drop + merge under 20% (baseline here is about 55%).

Ship a change only if it improves these on the non-compressor systems, not only on this package.

---

## 7. Implementation and live results (S1 + S5)

### What was built
- **S5:** MasterGen saves `failedState`, `parameter` and `needsReview` (`App.tsx`). `CoverageCheck.duplicateClaims()` reports the same value and unit claimed by two or more subsystems, under any parameter name. `isControlSubsystem` now tests the subsystem name only.
- **S1:** `AIService.planSystemFunctions` runs once between `generateMasterStructure` and the pool. It sees the full description, the reference file and `operatingContext`, and is stored on `Project.functionPlan`. `buildAllocationBlock` and `allocationFor` give each subsystem's function, breakdown and FF steps its own entry in place of the sibling names. Auto-Fill, Redecompose and the Function wand reuse the stored plan.
- **The plan is the row set.** With an allocation, `decomposeFunction` has no row floor, each row's `function` must be an owned duty's wording, and `keepAllocatedRows` drops a row that matches no owned duty, with a warning. If no row matches, it keeps all rows. Allocated rows bypass the keyword device and monitoring skips in `buildBreakdownRows`. Rows the model declares `protection` are never keyword-skipped.
- Harness: `services/__tests__/live-mastergen.manual.ts` (`npm run test:live -- live-mastergen`). Each system's subsystem split is made once and run twice, with the plan and with sibling names only.

### Live A/B (Copilot flow; same subsystem split per pair; FF count)

| System | Run 2 | Run 3 | Run 4 (final code) |
|---|---|---|---|
| Instrument air compressor | 64 → 39 (−39%) | 52 → 35 (−33%) | 44 → 24 (−45%)¹ |
| 415 V switchboard | 70 → 50 (−29%) | 62 → 43 (−31%) | 64 → 37 (−42%) |
| Shell-and-tube cooler | 38 → 23 (−39%)² | 38 → 21 (−45%) | 46 → 23 (−50%) |
| Duty/standby pump set | 41 → 37 (−10%) | 40 → 34 (−15%) | 61 → 31 (−49%) |

¹ UCP excluded from both sides (Power Automate Bad Gateway on the plan side). ² Like-for-like subsystems (one baseline subsystem hit Bad Gateway).

Run 1 is not in the table. It found two bugs: the leak-detection subsystem lost every row to a keyword skip, and standby takeover was repeated in every unit. Both were fixed before run 2. Runs 2 and 3 each found one more, fixed before the next run: the description step re-seeding rows (fixed by "the plan is the row set") and the metering duty lost to a keyword skip.

### What run 4 shows
- **Breakdown rows** fell from 28–40 to 11–15 per system. Rows now match the plan's owned duties almost one to one.
- **Standby takeover** appears once per redundant set: one compressor, one dryer, and one pump-set changeover in the control subsystem. The original exports had it in 3–5 subsystems.
- **Pass-through properties** (flow, pressure, dew point through vessels, dryers and piping) are listed under `receives` and no longer produce FFs.
- **Hidden and protective coverage is kept on the switchboard, cooler and compressor.** The baseline's higher protective row counts were mostly the same duty split into several rows.

### Residuals
1. **Per-row fan-out is now the largest source of bloat** (S3). FFs per row rose from about 1.65 to about 2.1. Typical example: driver "power below 75 kW" next to "speed below 1480 rpm" next to "erratic". This is the next change to make.
2. **The plan can merge two protective duties.** In the pump set, the low-low-level trip and the high-winding-temperature trip became one duty, and the winding-temperature trip lost its on-demand FF. This is a side effect of the "two duties that fail the same way are one duty" principle. Protective trips with different initiators fail independently, so watch for this in review.
3. **The plan's own judgement varies between runs.** In run 3 the plan gave a standby duty to both a machine and its driver; in run 4 it did not. A plan view the analyst can edit (S1's review mitigation) is not built yet.
4. **Power Automate Bad Gateways** dropped one subsystem in two of the runs. MasterGen reports this as an issue, and the harness records it in `summary.json`.

## 8. S3: declared failure shape (implemented)

Each breakdown row declares `failureShape` (`binary`, `below`, `above`, `band`, `conformance` or `protective`). `services/FailureShape.ts` maps the shape to the failed states the function can reach; hidden rows get `on_demand` in place of `total`. `generateFFsForBreakdownRows` enforces the mapping in code:
- a state the shape does not admit is dropped and reported, and is not sent to the repair pass;
- each row keeps at most one failure per state, so several parameters violating the same state become one failure;
- `total` and `on_demand` are relabelled to match the row's evidence.

`CoverageCheck` judges a shaped row per state (`Expected state missing`, `State outside failure shape`), not per parameter. Rows saved before this change have no shape and behave as before.

Live run (`VARIANTS=plan,plan-noshape`): every system has the plan on both sides, so the difference is S3 alone.

| System | Plan, no shape | Plan + shape |
|---|---|---|
| Compressor (like-for-like) | 35 | 23 (−34%) |
| 415 V switchboard | 38 | 22 (−42%) |
| Shell-and-tube cooler | 19 | 15 (−21%) |
| Pump set | 32 | 26 (−19%) |

FFs per row fell from about 1.9 to about 1.3. Intermittent states fell from 5–6 per system to 0–1, and the one left on the compressor is the pressure-control loop hunting. No protective or hidden row was lost. Remaining quibbles: a rated current written as a `below` deliverable (switchboard), and an insulation duty labelled `conformance` instead of `binary`.
