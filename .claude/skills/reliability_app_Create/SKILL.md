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
type AIProvider = 'gemini' | 'openai' | 'anthropic' | 'azure' | 'openrouter' | 'copilot';

async function callAI(provider, messages, tools?, systemPrompt?): Promise<AIResponse>
```

**Provider constants — define these at module level in App.tsx:**

```typescript
type AIProvider = 'gemini' | 'openai' | 'anthropic' | 'azure' | 'openrouter' | 'copilot';

// Human-readable tab labels
const PROVIDER_LABELS: Record<AIProvider, string> = {
    gemini: 'Gemini', openai: 'OpenAI', anthropic: 'Anthropic',
    azure: 'Azure', openrouter: 'OpenRouter', copilot: 'Copilot'
};

// Hardcoded fallback models — shown when live fetch has not run yet or fails
const PROVIDER_MODELS: Record<string, string[]> = {
    gemini:    ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
    openai:    ['gpt-4o-mini', 'gpt-4o', 'o3-mini'],
    anthropic: ['claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001', 'claude-opus-4-6'],
    // Azure, OpenRouter, and Copilot have no fallback list — they use text inputs
};

// Default model selected when switching to a provider
const DEFAULT_MODELS: Record<AIProvider, string> = {
    gemini: 'gemini-2.0-flash', openai: 'gpt-4o-mini',
    anthropic: 'claude-sonnet-4-20250514', azure: '', openrouter: '', copilot: ''
};

// Placeholder text for API key input per provider
const API_KEY_PLACEHOLDERS: Record<AIProvider, string> = {
    gemini: 'AIzaSy...', openai: 'sk-...', anthropic: 'sk-ant-...',
    azure: 'Azure API key', openrouter: 'sk-or-...', copilot: 'Not required'
};
```

**Provider switching behavior:** clicking a provider tab calls `setAiProvider(p)` AND `setModelName(DEFAULT_MODELS[p])` — always resets the model to the provider's default.

**Supported providers:**
- Gemini — live fetch; default `gemini-2.0-flash`; fallback list in `PROVIDER_MODELS`
- OpenAI — live fetch; default `gpt-4o-mini`; fallback list in `PROVIDER_MODELS`
- Anthropic — live fetch; default `claude-sonnet-*`; fallback list in `PROVIDER_MODELS`
- Azure — no live fetch; user types deployment name; no fallback list
- OpenRouter — no live fetch; user builds own model list via `ModelSelector` with `allowCustomList`
- **Copilot** — no live fetch; no API key; user provides a Power Automate HTTP trigger URL; model selection managed by Copilot Studio

**Do not hardcode model lists as the final truth.** `PROVIDER_MODELS` is only a fallback for when live fetch has not run yet or failed. Models are fetched live and cached in `localStorage` with a 24h TTL.

### Live Model Fetching

Add `fetchModels(provider, apiKey)` to `AIService`. The API endpoints and required headers for each provider:

```typescript
// OpenAI
fetch('https://api.openai.com/v1/models', {
    headers: { 'Authorization': `Bearer ${apiKey}` }
})
// Response: { data: [{ id: string, object: 'model', ... }] }

// Gemini
fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=100`)
// Response: { models: [{ name: 'models/gemini-2.0-flash', supportedGenerationMethods: [...], ... }] }
// Strip 'models/' prefix from name field

// Anthropic
fetch('https://api.anthropic.com/v1/models', {
    headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'  // required for browser calls
    }
})
// Response: { data: [{ id: string, display_name: string, ... }] }
```

Each provider has its own filter:

```typescript
export interface TieredModels {
    pro: string[];        // highest capability (deep-research, o3/o4, pro, opus, plus, ultra)
    balanced: string[];   // general purpose (gpt-4o class, gemini standard, claude sonnet)
    efficient: string[];  // fast/cheap (mini, flash, haiku, lite, small, nano)
    fetchedAt: number;    // Date.now() — used for 24h TTL check
}
```

**Provider filter rules:**

| Provider | Keep | Block |
|----------|------|-------|
| OpenAI | Allowlist: `gpt-`, `o[0-9]`, `chatgpt-` | Sora, DALL-E, Whisper, TTS, embeddings, moderation, old dated snapshots (`-0314`, `-0613`) |
| Gemini | Allowlist: `gemini-*` + `supportedGenerationMethods` includes `generateContent` | Imagen, Veo, PaLM/Bison/Gecko, embeddings, aqa, retrieval, legacy |
| Anthropic | No filter needed — their API only returns chat models | — |

**Priority-based tier classification** (apply in this order, first match wins):

```typescript
function getTier(id: string): 'pro' | 'balanced' | 'efficient' {
    const s = id.toLowerCase();
    // P1: deep-research → always Pro regardless of other keywords (e.g. o4-mini-deep-research)
    if (s.includes('deep-research')) return 'pro';
    // P2: efficient — small/fast/cheap indicators
    if (/\b(mini|flash|haiku|lite|small|nano|micro|basic|instant|speed)\b/.test(s)) return 'efficient';
    // P3: pro — capability or top-tier markers
    if (/\b(pro|opus|plus|ultra|large|advanced|max|heavy|premium|turbo)\b/.test(s)) return 'pro';
    // P4: pure OpenAI o-series reasoning (o3, o4, o5… without mini — caught at P2)
    if (/^o[3-9](-\d{4}-\d{2}-\d{2})?$/.test(s)) return 'pro';
    return 'balanced';
}
```

**Caching and fetching pattern in App state:**

```typescript
// Which providers support live model fetching (Azure and OpenRouter do NOT)
const FETCHABLE_PROVIDERS = ['gemini', 'openai', 'anthropic'] as const;
type FetchableProvider = typeof FETCHABLE_PROVIDERS[number];

// State — initialize from localStorage cache so models appear instantly on reload
const [liveModels, setLiveModels] = useState<Record<string, TieredModels>>(() => {
    try { return JSON.parse(localStorage.getItem('fmeca_models_cache') || '{}'); } catch { return {}; }
});
const [modelsFetching, setModelsFetching] = useState(false);

// Fetch wrapper — guards short keys, shows spinner, writes through to localStorage cache
const doFetchModels = async (provider: FetchableProvider, key: string) => {
    if (!key || key.length < 10) return;  // no API key yet, skip silently
    setModelsFetching(true);
    try {
        const tiered = await AIService.fetchModels(provider, key);
        setLiveModels(prev => {
            const next = { ...prev, [provider]: tiered };
            localStorage.setItem('fmeca_models_cache', JSON.stringify(next));
            return next;
        });
    } catch (e) {
        console.warn('[ModelFetch] Failed:', e);  // silent — UI falls back to hardcoded defaults
    } finally {
        setModelsFetching(false);
    }
};

// Auto-fetch when provider or apiKey changes — skip non-fetchable providers, respect 24h TTL
useEffect(() => {
    if (!(FETCHABLE_PROVIDERS as readonly string[]).includes(aiProvider)) return;
    const cached = liveModels[aiProvider];
    const TTL = 24 * 60 * 60 * 1000;
    if (cached && Date.now() - cached.fetchedAt < TTL) return;
    doFetchModels(aiProvider as FetchableProvider, apiKey);
// eslint-disable-next-line react-hooks/exhaustive-deps
}, [aiProvider, apiKey]);
```

Always implement a **mock/demo mode** that works without API keys for demos and onboarding.

---

## Copilot / Power Automate Provider

This is a **compliance-grade pass-through provider** for organisations that must route all AI traffic through Microsoft Power Platform (Power Automate → Copilot Studio) rather than calling OpenAI/Gemini directly. It is a first-class provider alongside the others — not a special case.

### Design principle
Phase 1 is a generic pass-through: the app sends a flat prompt to a Power Automate HTTP trigger; the flow forwards it to Copilot Studio and returns the plain-text response. No model selection, no API key — just a URL.

### AIRequestPayload additions

```typescript
export interface AIRequestPayload {
    // ...existing fields...
    provider: 'openai' | 'gemini' | 'anthropic' | 'azure' | 'openrouter' | 'copilot';
    powerAutomateUrl?: string;  // HTTP trigger URL — required when provider === 'copilot'
}
```

### Copilot interceptor in chat()

Add this as the **very first statement** in `AIService.chat()`, before the remote/direct fallback logic:

```typescript
async chat(req: AIRequestPayload): Promise<string> {
    if (req.provider === 'copilot') {
        return this._powerAutomateRequest(req);
    }
    // ...existing baseUrl / _directChat logic unchanged...
}
```

### _powerAutomateRequest transport method

Place this in the **internal transport section** of `AIService`, alongside `_remoteRequest`:

```typescript
async _powerAutomateRequest(req: AIRequestPayload): Promise<string> {
    // 1. Validate URL
    if (!req.powerAutomateUrl) {
        throw new Error('Power Automate URL is required for Copilot provider.');
    }

    // 2. Flatten last user message
    const lastUserMessage = [...req.messages].reverse().find(m => m.role === 'user');
    const rawPrompt = typeof lastUserMessage?.content === 'string'
        ? lastUserMessage.content
        : '';

    // 3. Attach context (reference file / hybrid mode) via existing helper
    const fullPrompt = this.attachContext(rawPrompt, req.mode, req.refText ?? '');

    // 4. Build payload
    const payload = {
        sessionId: req.sessionId ?? crypto.randomUUID(),  // maintains chat state in Copilot Studio
        prompt: fullPrompt,
        responseFormat: req.responseFormat ?? 'text',
    };

    // 5. POST to Power Automate HTTP trigger
    const res = await fetch(req.powerAutomateUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    // 6. Error handling — read raw text body for useful error messages
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Power Automate Error: ${res.statusText}${errText ? ` — ${errText}` : ''}`);
    }

    // 7. Return raw text — Power Automate flow returns plain string, not JSON
    return res.text();
},
```

> **Important:** The flow returns a **raw text string**, not `{ content: string }`. Always use `res.text()`, never `res.json()`.

### Feature method signatures

Every feature method (`generate`, `generateMasterStructure`, `generateCompleteSubsystem`, `generateModesForFailure`, `evaluateRpnFromText`) must accept and forward `powerAutomateUrl`:

```typescript
// Add as last optional param to each method signature
async generate(..., systemContext: string = '', powerAutomateUrl: string = ''): Promise<string>

// Pass through to every internal this.chat() call
return this.chat({
    ...
    powerAutomateUrl: powerAutomateUrl || undefined,
});
```

### App.tsx state & persistence

```typescript
// State
const [powerAutomateUrl, setPowerAutomateUrl] = useState('');

// Load from localStorage
setPowerAutomateUrl(localStorage.getItem('rcm_power_automate_url') || '');

// Save — add to the localStorage useEffect dependency array alongside azureEndpoint
localStorage.setItem('rcm_power_automate_url', powerAutomateUrl);
```

### Settings UI rules for Copilot

```tsx
{/* 1. Hide API Key field entirely when Copilot is selected */}
{aiProvider !== 'copilot' && (
    <div>
        <label>API Key</label>
        <input type="password" value={apiKey} ... />
    </div>
)}

{/* 2. Show Power Automate URL input instead */}
{aiProvider === 'copilot' && (
    <div>
        <label>Power Automate URL</label>
        <input type="text" value={powerAutomateUrl}
               onChange={e => setPowerAutomateUrl(e.target.value)}
               placeholder="https://prod-xx.westus.logic.azure.com/workflows/..." />
    </div>
)}

{/* 3. No model selector for Copilot — replace with info text */}
{aiProvider === 'copilot' ? (
    <p className="text-xs text-slate-400 mt-1">
        Model selection is managed by Copilot Studio. No model ID is required here.
    </p>
) : aiProvider === 'azure' ? (
    // ...deployment name input...
) : (
    // ...ModelSelector...
)}
```

### API key guard bypass

All key-length guards throughout `AIService` and `App.tsx` must be bypassed when provider is `copilot`. Apply the pattern consistently:

```typescript
// AIService feature methods — change every guard from:
if (!key || key.length < 10) { /* fallback */ }
// to:
if ((!key || key.length < 10) && aiProvider !== 'copilot') { /* fallback */ }

// App.tsx alert guards
if (!apiKey && aiProvider !== 'copilot') return alert("API Key required.");

// Chatbot handleSend
if (!input.trim() || (!apiKey && aiProvider !== 'copilot')) return;
```

### Prop threading

Pass `powerAutomateUrl` alongside `azureEndpoint` everywhere the latter already flows:

| Component | Prop to add |
|-----------|-------------|
| `<Chatbot>` | `powerAutomateUrl={powerAutomateUrl}` |
| `<SmartInput>` | `powerAutomateUrl?: string` — forward to `AIService.generate()` |
| `<MitigationBuilder>` | `powerAutomateUrl?: string` — forward to `<SmartInput>` |
| Every `AIService.*` call site | append `powerAutomateUrl` as last argument |

---

## Spell-check Optimisation (generate() fast path)

The `generate()` method dispatches on word count. The **1–5 word spell-check branch** must short-circuit before the shared `chat()` call to avoid sending the reference file and system context for a simple typo fix:

```typescript
if (currentText && wordCount > 0 && wordCount <= 5) {
    // Early return — no refText, no systemContext, mode forced to 'ai'
    return this.chat({
        feature: 'field-generation',
        provider: (aiProvider || (key.startsWith('sk-') ? 'openai' : 'gemini')) as any,
        azureEndpoint: azureEndpoint || undefined,
        powerAutomateUrl: powerAutomateUrl || undefined,
        model: modelName,
        messages: [{ role: 'user', content:
            `Fix only the grammar and spelling of the following text. ` +
            `Return only the corrected text with no explanations or changes to meaning. ` +
            `Original: """${currentText}"""` }],
        mode: 'ai',   // skips attachContext — no 15 000-char reference file prepended
        apiKey: key,
        responseFormat: 'text'
    });
}
// 6+ words and from-scratch branches continue to the shared chat() call below
// which does receive refText, systemContext, contextData, etc.
```

**Why this matters:** without the early return the shared call appends `systemContext` and lets `_directChat → attachContext()` prepend up to 15 000 characters of reference file to every spell-check request, making it as expensive as a full generation call.

---

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
