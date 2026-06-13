# Reliability Engineering Domain Knowledge

## Core Methodologies

### FMECA — Failure Modes, Effects & Criticality Analysis
The foundational tool for proactive reliability analysis. Structure:
- **System** → **Subsystem** → **Component** → **Function** → **Functional Failure** → **Failure Mode** → **Effect** → **Cause** → **Mitigation**
- **Criticality** = Severity × Occurrence (× Detection in FMEA/RPN variant)
- **RPN** (Risk Priority Number) = S × O × D (1–10 each, max 1000)
- RPN > 200: High risk, immediate action needed
- RPN 100–200: Medium risk, action plan required
- RPN < 100: Low risk, monitor

**FMEA vs FMECA:**
- FMEA: Qualitative, focuses on effects and prevention (common in manufacturing)
- FMECA: Quantitative, adds criticality ranking (common in industrial/military)

### RCM — Reliability-Centered Maintenance
Structured decision process to determine the most effective maintenance strategy per failure mode.
Seven RCM questions:
1. What are the functions and performance standards? (Function)
2. In what ways can it fail to fulfill its functions? (Functional Failure)
3. What causes each functional failure? (Failure Mode)
4. What happens when each failure occurs? (Failure Effect)
5. In what way does each failure matter? (Failure Consequence)
6. What can be done to predict or prevent each failure? (Proactive Task)
7. What should be done if no proactive task can be found? (Default Action)

**RCM Decision Tree consequences:**
- Safety/Environmental → Redesign if no task found
- Operational → Cost/benefit of PM vs. run-to-failure
- Non-operational → No PM if cost of task > cost of failure

**Maintenance strategies output from RCM:**
- Time-based (TBM): Calendar-interval PMs
- Condition-based (CBM): Vibration, thermography, oil analysis
- Failure-finding (FFM): Test hidden functions (safety devices)
- Redesign/modify
- Run to failure (RTF)

### Weibull Analysis
Statistical tool for modeling failure distribution and predicting future failures.

**Weibull distribution parameters:**
- **β (shape):** < 1 = infant mortality; = 1 = random failure (exponential); > 1 = wear-out
- **η (scale/characteristic life):** Time at which 63.2% of population has failed
- **γ (location):** Failure-free period (often 0)

**Key calculations:**
- F(t) = 1 − exp(−(t/η)^β)  [Cumulative distribution function]
- R(t) = exp(−(t/η)^β)       [Reliability function]
- h(t) = (β/η)(t/η)^(β-1)   [Hazard/failure rate function]
- MTTF = η × Γ(1 + 1/β)     [Mean time to failure using Gamma function]

**Plotting:** Rank failure times, calculate median ranks (Bernard's approximation: F(i) = (i-0.3)/(n+0.4)), plot on Weibull probability paper (log-log scale).

**Weibull beta interpretation guide:**
| β value | Failure type | Maintenance implication |
|---------|-------------|------------------------|
| < 0.5 | Severe infant mortality | Design flaw, installation issues |
| 0.5–1.0 | Infant mortality | Run-in problems, weak components |
| 1.0 | Purely random | No PM benefit; CBM or RTF |
| 1.0–4.0 | Early wear-out | Condition monitoring effective |
| > 4.0 | Pronounced wear-out | Time-based PM very effective |

### RAM Analysis — Reliability, Availability, Maintainability
System-level modeling to predict overall performance.

**Key metrics:**
- **Reliability:** R(t) = probability of failure-free operation over period t
- **Availability:** A = MTBF / (MTBF + MTTR) — proportion of time equipment is operable
- **Maintainability:** M(t) = probability of restoring function within time t

**System configurations:**
- **Series:** R_system = R1 × R2 × ... × Rn (weakest link)
- **Parallel (redundant):** R_system = 1 − (1−R1)(1−R2)...(1−Rn)
- **k-of-n:** At least k of n components must work

**Reliability Block Diagrams (RBD):** Visual representation of functional dependencies. Nodes = components, blocks = reliability values. Used to calculate system-level availability.

### Fault Tree Analysis (FTA)
Top-down deductive analysis of undesired events.

**Logic gates:**
- **AND gate:** All input events must occur for output
- **OR gate:** Any input event causes output
- **Basic event:** Initiating fault (circle)
- **Top event:** Undesired system-level event (rectangle)

**Minimal Cut Sets (MCS):** Smallest combination of basic events whose simultaneous occurrence causes the top event. Most critical for risk reduction.

**Quantitative FTA:**
- P(Top) calculated from basic event probabilities using Boolean algebra
- Importance measures: Birnbaum, Criticality, Fussel-Vesely

### Pareto Analysis (80/20 Rule)
In reliability: 80% of failures caused by 20% of failure modes.
- Sort failure modes by frequency (descending)
- Calculate cumulative percentage
- "Vital few" = modes up to 80% cumulative
- "Useful many" = remaining 20% of failures spread across many modes
- Focus improvement efforts on vital few for maximum ROI

## ISO and Industry Standards

### ISO 14224:2016 — Petroleum & Natural Gas — Collection & exchange of reliability and maintenance data for equipment
- Defines failure mode taxonomy for oil & gas equipment
- Equipment categories: Rotating, Static, Electrical, Instrumentation
- ~65 standard failure modes grouped by category
- Defines boundary conditions, data collection requirements
- Key failure modes: Leakage, High/Low parameters, Spurious operation, Failure to start/run/stop, Mechanical failure, Electrical failure, Instrument failure

**Common ISO 14224 failure modes for rotating equipment:**
- Bearing failure, Seal failure, Impeller damage, Shaft failure, Coupling failure
- Overheating, Vibration, Cavitation, Blockage/plugging, Corrosion/erosion

### ISO 55000 — Asset Management
- System of management for physical assets
- Key concepts: Asset lifecycle, value realization, risk management
- Complements RCM by providing organizational framework

### IEC 60812 — FMEA procedures
- Standard methodology for conducting FMEA/FMECA
- Defines severity, occurrence, detection criteria
- Spreadsheet templates and documentation requirements

### MIL-STD-1629 — FMECA for Military Systems
- Military standard for FMECA
- Defines criticality analysis procedures
- Criticality matrix plotting (severity vs. probability)

## Failure Mode Taxonomy

### Mechanical Failure Modes
- Bearing Failure (wear, fatigue, overload, contamination)
- Seal/Gasket Failure (wear, extrusion, chemical attack)
- Shaft Failure (fatigue, overload, corrosion)
- Coupling Failure (misalignment, wear, shock)
- Impeller/Rotor Damage (erosion, cavitation, imbalance)
- Fastener Failure (loosening, fatigue, corrosion)
- Structural Crack/Fracture

### Fluid System Failure Modes
- External Leakage (flange, fitting, valve packing)
- Internal Leakage (bypass, valve seat wear)
- Blockage/Plugging (fouling, scale, debris)
- Contamination (water ingress, particulate)
- Corrosion/Erosion (material loss, pitting)
- Cavitation (pump/valve damage from bubble collapse)

### Electrical Failure Modes
- Insulation Failure (degradation, moisture ingress)
- Winding Failure (turn-to-turn, phase-to-ground)
- Bearing Failure (motor bearings)
- Overheating (overload, cooling failure)
- Electrical Fault (short circuit, open circuit)
- Control/Protection Failure (relay, PLC, sensor)

### Instrumentation Failure Modes
- Sensor Failure (drift, out of range, damage)
- Transmitter Failure
- Control Loop Failure (valve stuck, actuator)
- Signal Loss / Spurious Trip
- Calibration Drift

### Maintenance Categories (non-failures)
- PM / Preventive Maintenance (isSignificant = false)
- Inspection (isSignificant = false)
- Calibration (isSignificant = false)
- Lubrication (isSignificant = false)
- Overhaul / Turnaround (isSignificant = false)

## Equipment Categories

### Rotating Equipment
- Centrifugal Pumps (most common, high failure frequency)
- Reciprocating Pumps (high vibration, seal/valve issues)
- Centrifugal Compressors (critical, high cost of failure)
- Reciprocating Compressors (valve wear, piston ring)
- Gas Turbines (blade damage, combustor, bearing)
- Steam Turbines (blade erosion, seal, governor)
- Electric Motors (winding, bearing, cooling)
- Fans/Blowers (bearing, blade, seal)
- Gearboxes (gear tooth, bearing, seal)
- Agitators/Mixers (seal, shaft, impeller)

### Static Equipment
- Pressure Vessels (corrosion, fatigue, nozzle, flange)
- Heat Exchangers (fouling, corrosion, tube failure)
- Tanks/Storage (corrosion, structural, overflow)
- Piping (corrosion, erosion, mechanical damage)
- Valves (seat wear, stem packing, actuator)
- Filters/Strainers (plugging, bypass, damage)

### Electrical/Instrumentation
- Transformers (insulation, tap changer, cooling)
- Switchgear/MCC (insulation, contacts, protection)
- UPS/Batteries (degradation, charger)
- PLCs/DCS (hardware, software, I/O)
- Safety Systems (SIS, SIL-rated devices)

## Maintenance KPIs and Benchmarks

### Primary KPIs
| KPI | Formula | World-class target |
|-----|---------|-------------------|
| Overall Equipment Effectiveness (OEE) | Availability × Performance × Quality | > 85% |
| Equipment Availability | MTBF / (MTBF + MTTR) × 100% | > 95% for critical |
| MTBF | Period / Number of failures | Depends on equipment type |
| MTTR | Sum of repair times / Number of repairs | < 4 hours for critical |
| PM Compliance | PMs completed on time / PMs scheduled | > 90% |
| Planned Maintenance % | Planned work hours / Total work hours | > 80% |
| Maintenance Cost/RAV | Maintenance spend / Replacement Asset Value | 2–4% for well-run plant |
| Wrench Time | Direct maintenance time / Total available time | > 55% |

### Benchmark MTBF by Equipment Type (typical plant data)
| Equipment | MTBF (months) | Comments |
|-----------|--------------|----------|
| Centrifugal pump (single seal) | 18–24 | Seal most common failure |
| Centrifugal pump (double seal) | 36–48 | Better reliability |
| Electric motor < 50kW | 48–60 | Bearing most common |
| Electric motor > 500kW | 60–84 | Critical, often monitored |
| Centrifugal compressor | 24–36 | Seal, bearing, lube system |
| Air-cooled heat exchanger | 60–84 | Fan, motor, tube |
| Control valve | 36–48 | Seat, packing, actuator |

## Criticality Classification

### ABC Criticality (common in SAP/Maximo)
- **A (Critical):** Single point of failure; safety/environmental risk; high production impact; no spare/standby
- **B (Important):** Has standby but standby also fails frequently; significant impact
- **C (Non-critical):** Standby available and reliable; minimal production impact; easily repaired

### Criticality Assessment Factors
1. Safety impact (personnel, environment, community)
2. Production impact ($/hour loss)
3. Product quality impact
4. Regulatory/compliance impact
5. Time to restore (MTTR)
6. Availability of spare parts
7. Redundancy (standby equipment)
8. Detection capability (hidden vs. evident failure)

## CMMS Integration Knowledge

### SAP PM Key Objects
- **Equipment Master** (EQUI): Individual asset record
- **Functional Location** (IFLOT): Hierarchical location structure (Plant → Unit → System → Equipment)
- **Maintenance Order** (AUFK): Work order — type (PM01=corrective, PM02=preventive, PM03=inspection)
- **Notification** (QMEL): Failure/breakdown report before order creation
- **Measuring Points** (IMTE): Counter/measurement readings (hours, cycles)
- **Task Lists** (PLKO): Planned PM procedures with operation steps

### IBM Maximo Key Objects
- **Asset**: Equipment master record
- **Location**: Site hierarchy
- **Work Order** (WO): WONUM, status (WAPPR, APPR, INPRG, COMP, CLOSE)
- **Work Type**: PM (preventive), CM (corrective), EM (emergency), INSP (inspection)
- **Asset Specifications**: Technical attributes
- **PM Records**: Scheduled preventive maintenance frequency

### Common CMMS Export Columns
Always map these to the standard FailSense schema:
- Date column → `date` (event start)
- Finish/completion date → `finishDate` (enables MTTR)
- Equipment/asset → `equipment`
- Description/short text → `description`
- Order/work order ID → `id`
- Work type/order type → used for significance filter (CM/EM = significant)
