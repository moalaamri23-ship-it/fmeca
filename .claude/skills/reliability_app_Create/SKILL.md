---
name: reliability_app_Create
description: This skill should be used when the user asks to "build a reliability app", "create a reliability tool", "add a feature to FailSense", "add a feature to FMECA Studio", "build a new reliability engineering tool", "create an AI-assisted maintenance app", "build a FMECA tool", "create a Weibull analysis tool", "build an RCM workbench", "create a spare parts optimizer", "build a RAM analysis tool", "build a fault tree app", "create a maintenance cost tool", "add a chatbot to a reliability app", or any task involving building web applications for equipment reliability, FMECA, MTBF/MTTR analysis, RCM, predictive maintenance, or AI-assisted maintenance engineering.
version: 1.0.0
---

# Reliability App Creator Skill

This skill guides the creation of AI-assisted web applications for equipment reliability engineering. The apps built with this skill form a growing ecosystem anchored by two existing tools: **FailSense** (AI-powered CMMS failure analysis) and **FMECA Studio** (AI-powered FMECA creation). Each new app should integrate seamlessly with or complement these tools.

## The Ecosystem Vision

The ultimate goal is a suite of interconnected AI-assisted tools that cover the full reliability engineering lifecycle:

```
CMMS Data → FailSense → Failure Mode Analysis → FMECA Studio → FMECA Documents
     ↓                         ↓                       ↓
 Raw History          Classified Events          Structured Risk Analysis
     ↓                         ↓                       ↓
[Future Apps]          Weibull Tool             RCM Workbench
- Spare Parts Optimizer    FTA Builder          RAM Analysis Tool
- Cost Optimizer        Risk Matrix          Maintenance Scheduler
- Predictive Maint.     PM Optimizer         Reporting Hub
```

All apps share the same philosophy: **client-side, AI-augmented, CMMS-aware, standards-compliant**.

## Established Tech Stack

Use this stack consistently across all reliability apps to ensure portability and shared tooling:

| Layer | Choice | Why |
|-------|--------|-----|
| Framework | React 19 + TypeScript 5 | Component reuse, strong typing for engineering data |
| Build | Vite 8+ | Fast HMR, ES modules |
| Styling | Tailwind CSS 4 | Rapid UI, design consistency |
| State | Zustand + localStorage | Persistence without backend |
| Charts | Recharts | Composable, fits reliability curve shapes |
| CSV/Excel | PapaParse + XLSX | CMMS export parsing |
| Dates | date-fns | Maintenance timeline calculations |
| AI | Multi-provider abstraction | Never lock to one LLM |

**Deploy target:** Cloudflare Pages (static) — no backend required, users provide their own API keys.

## AI Service Architecture

Every app must implement a provider-agnostic AI layer. The pattern:

```typescript
// Provider routing based on API key prefix or user selection
type AIProvider = 'gemini' | 'openai' | 'anthropic' | 'azure' | 'openrouter';

async function callAI(provider, messages, tools?, systemPrompt?): Promise<AIResponse>
```

**Supported providers and models:**
- Google Gemini: `gemini-2.0-flash` (default), `gemini-1.5-pro`
- OpenAI: `gpt-4o-mini` (default), `gpt-4o`, `o3-mini`
- Anthropic Claude: `claude-sonnet-4-20250514` (default), `claude-haiku`, `claude-opus`
- Azure OpenAI: Custom endpoint + deployment name
- OpenRouter: Any model via relay (user specifies model ID)

Always implement a **mock/demo mode** that works without API keys for demos and onboarding.

## Chatbot Building Patterns

Every reliability app should include an AI chatbot. Use these two modes:

### Agent Mode (Mutating)
The agent can modify app data. Use function/tool calling:

```typescript
// 1. Define function declarations
const tools = [
  { name: 'get_summary', description: 'Get current project summary' },
  { name: 'mutate_data', description: 'Modify project data (requires confirmation)' },
];

// 2. Route AI response to function handlers
// 3. Preview mutations BEFORE executing ("Will remove 45 events...")
// 4. Require explicit user confirmation
// 5. Save undo snapshot before mutation
// 6. Persist agent chat history per-project
```

**Critical rules for agent mode:**
- Always preview before executing mutations
- Save snapshot to undoStack before any data change
- Log all executed actions to actionHistory
- Never execute without user confirmation
- Support undo/redo via snapshot stacks

### Assistant Mode (Read-Only)
The assistant answers questions about data. No function calls, no mutations:

```typescript
// Build rich system prompt from current project state
const systemPrompt = buildContextPrompt(projectData, metrics, failureModes);
// Ephemeral — reset chat on project switch
// Use for: "Why is confidence low?", "What patterns do you see?", "Recommendations?"
```

### RAG Pattern
For large projects, build a lightweight retrieval layer:
1. Index project data into chunks (subsystems, failure modes, events)
2. On user query: classify intent → select retrieval strategy → build minimal context
3. Strategies: `topk` (most relevant chunks), `full_index`, `index_then_expand`
4. Respect token budgets — never dump entire project into context

## Core Data Structures

Define TypeScript interfaces precisely. All apps share these reliability primitives:

```typescript
// Universal failure event (from FailSense)
interface FailureEvent {
  id: string | number;
  date: string;                    // ISO 8601
  finishDate?: string;             // enables MTTR calculation
  equipment: string;               // asset / functional location
  description: string;             // work order text
  failureMode: string;             // classified mode
  isSignificant: boolean;          // true=failure, false=PM/inspection
  confidence?: number;             // 0–100
  confidenceReason?: string;
}

// FMECA hierarchy (from FMECA Studio)
interface FMECAProject {
  subsystems: Subsystem[];
}
interface Subsystem {
  name: string; specs: string; func: string;
  failures: FunctionalFailure[];
}
interface FunctionalFailure {
  desc: string;
  modes: FailureMode[];
}
interface FailureMode {
  mode: string; effect: string; cause: string;
  mitigation: string;
  rpn: { s: number; o: number; d: number };  // 1–10 each
}

// Reliability metrics
interface ReliabilityMetrics {
  mtbf: number;          // days
  mttr: number;          // hours
  availability: number;  // 0–1
  failureRate: number;   // failures/year
}
```

## Reliability Calculations

Implement these core calculations in all relevant apps:

```typescript
// MTBF = period days / total failures
const mtbf = (lastDate - firstDate) / failureCount;

// MTTR = average(finishDate - startDate) per event
const mttr = average(events.map(e => e.finishDate - e.date));

// Availability = MTBF / (MTBF + MTTR) — normalize to same units
const availability = mtbf / (mtbf + mttrDays);

// RPN = Severity × Occurrence × Detection (1–10 each)
const rpn = mode.rpn.s * mode.rpn.o * mode.rpn.d;  // max 1000

// Pareto vital few: find failure modes that account for 80% of events
const sorted = modes.sort((a, b) => b.count - a.count);
let cumulative = 0;
const vitalFew = sorted.filter(m => {
  cumulative += m.count;
  return cumulative / total <= 0.80;
});
```

## AI Prompt Engineering for Reliability

### Classification Prompt Structure
```
You are a reliability engineer using ISO 14224 standards.
Classify each failure event. Rules:
1. Failure mode MUST be derivable from description — no inference
2. Use standardized modes: Bearing Failure, Seal Leak, Corrosion,
   Electrical Fault, Lubrication Issue, PM/Inspection, Vibration, etc.
3. isSignificant=false for: lubrication checks, inspections, PMs, scheduled tasks
4. Assign confidence (0–100) with reason
5. Return strict JSON array
```

### RPN Scoring Prompt Structure
```
You are a senior reliability engineer applying FMEA best practices.
Evaluate Severity (S), Occurrence (O), Detection (D) on 1–10 scales.
Be conservative. Use this failure mode's effect and cause to score.
Return: { s: number, o: number, d: number, justification: string }
```

### Report Generation Pattern
Multi-turn specialist conversation:
1. "What is your main objective?" → capture goals
2. "Who is your audience?" → technical vs. executive framing
3. "Any scope constraints?" → focus areas
4. Generate structured JSON report with all sections

## CMMS Data Parsing

Support these CMMS systems out of the box:

| System | Key Column Keywords |
|--------|---------------------|
| SAP PM | AUFNR, QMEL, NOTIFICATION, IWERK, EQUNR, TPLNR |
| IBM Maximo | WONUM, WORKORDER, ACTSTART, ACTFINISH, ASSETNUM, SITEID |
| Generic | date, equipment, description, order, work order |

Scoring-based column detection:
```typescript
function detectColumn(headers: string[], keywords: string[]): string {
  return headers.find(h => keywords.some(k => h.toLowerCase().includes(k.toLowerCase())));
}
```

Always run a **Data Understanding Chat** before batch analysis:
1. AI proposes column mapping
2. Multi-turn chat to confirm/correct
3. User specifies filters (date range, order type, equipment subset)
4. Apply `rowFilters` and `dateRangeFilter` before sending to AI

## State Management Pattern

Use Zustand with localStorage persistence for all app state:

```typescript
const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      projects: [],
      currentProjectId: null,
      // AI config
      aiProvider: 'gemini',
      apiKey: '',
      modelId: '',
      // Per-project actions
      updateProjectData: (id, data) => set(state => ({
        projects: state.projects.map(p => p.id === id ? { ...p, ...data } : p)
      })),
      // Undo/redo support
      pushUndoSnapshot: (projectId, snapshot) => { /* ... */ },
    }),
    { name: 'app-storage' }
  )
);
```

## Project Management Pattern

Every app should have a projects dashboard with:
- Create / Import (JSON) / Export (JSON) / Delete
- Per-project: name, description, created date, last updated
- Project card with key metrics preview
- Switch between projects with clean state transition

## Visualization Patterns

Use Recharts for all charts. Key chart types for reliability:

| Chart | When to Use | Component |
|-------|-------------|-----------|
| Bar Chart | Failure mode frequency, per-equipment counts | `<BarChart>` |
| Composed (Bar + Line) | Pareto analysis (count bars + cumulative % line) | `<ComposedChart>` |
| Line Chart | Trends over time, MTBF trends, Weibull probability | `<LineChart>` |
| Scatter Plot | Weibull analysis (time vs. cumulative failure %) | `<ScatterChart>` |
| Area Chart | Availability over time | `<AreaChart>` |
| Tree / Mind-map | FMECA hierarchy | Custom SVG or react-d3-tree |

Always generate **SVG chart snapshots** for PDF/report embedding.

## Report Export Strategy

Export to PDF via browser print dialog (no server needed):
```typescript
window.print();
// Use @media print CSS to control layout
// Embed SVG charts directly in report HTML
// Include print-specific styles: page breaks, no navigation
```

Export to Word/Excel via XLSX library for tabular data.
Export full project as JSON snapshot for sharing/import.

## App Ideas to Build Next

Refer to **`references/future-apps.md`** for a detailed roadmap of 12+ planned reliability tools. Priority candidates:

1. **Weibull Analysis Tool** — Fit failure history to Weibull distribution, predict next failure, optimize PM intervals
2. **RCM Workbench** — Full RCM analysis (functions, functional failures, failure modes, effects, tasks)
3. **Fault Tree Analysis Builder** — Visual FTA with Boolean logic, minimal cut sets
4. **RAM Analysis Tool** — System reliability/availability/maintainability block diagram modeling
5. **Spare Parts Optimizer** — AI-driven spare parts recommendations based on MTBF and lead times
6. **Maintenance Cost Analyzer** — Track and optimize maintenance spend vs. asset value

## Additional References

- **`references/domain-knowledge.md`** — Reliability engineering standards, methodologies, terminology
- **`references/ai-chatbot-patterns.md`** — Detailed AI function calling, RAG, prompt templates
- **`references/app-architecture.md`** — Full tech stack details, component patterns, file structure
- **`references/future-apps.md`** — Detailed specs for each planned reliability tool
