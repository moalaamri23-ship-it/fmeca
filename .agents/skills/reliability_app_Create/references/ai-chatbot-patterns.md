# AI & Chatbot Implementation Patterns for Reliability Apps

## Multi-Provider AI Service Layer

All reliability apps use a single `aiService.ts` abstraction. Here is the complete pattern:

```typescript
// src/utils/aiService.ts

export type AIProvider = 'gemini' | 'openai' | 'anthropic' | 'azure' | 'openrouter';

export interface AIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string; items?: any; enum?: string[] }>;
    required?: string[];
  };
}

export interface AIResponse {
  text?: string;
  functionCall?: { name: string; args: Record<string, any> };
}

export async function callAI(
  provider: AIProvider,
  apiKey: string,
  messages: AIMessage[],
  systemPrompt?: string,
  tools?: FunctionDeclaration[],
  modelId?: string
): Promise<AIResponse> {
  switch (provider) {
    case 'gemini':   return callGemini(apiKey, messages, systemPrompt, tools, modelId);
    case 'openai':   return callOpenAI(apiKey, messages, systemPrompt, tools, modelId);
    case 'anthropic': return callAnthropic(apiKey, messages, systemPrompt, tools, modelId);
    case 'azure':    return callAzure(apiKey, messages, systemPrompt, tools, modelId);
    case 'openrouter': return callOpenRouter(apiKey, messages, systemPrompt, tools, modelId);
  }
}
```

### Gemini Tool Calling
```typescript
async function callGemini(apiKey, messages, systemPrompt, tools, modelId) {
  const model = modelId || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body = {
    systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
    contents: messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    })),
    tools: tools ? [{ functionDeclarations: tools }] : undefined,
  };

  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  const part = data.candidates[0].content.parts[0];

  if (part.functionCall) return { functionCall: { name: part.functionCall.name, args: part.functionCall.args } };
  return { text: part.text };
}
```

### OpenAI Tool Calling
```typescript
async function callOpenAI(apiKey, messages, systemPrompt, tools, modelId) {
  const msgs = [
    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
    ...messages.map(m => ({ role: m.role, content: m.content }))
  ];

  const body = {
    model: modelId || 'gpt-4o-mini',
    messages: msgs,
    tools: tools?.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
    tool_choice: tools ? 'auto' : undefined,
  };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  const choice = data.choices[0].message;

  if (choice.tool_calls?.[0]) {
    const tc = choice.tool_calls[0];
    return { functionCall: { name: tc.function.name, args: JSON.parse(tc.function.arguments) } };
  }
  return { text: choice.content };
}
```

### Anthropic Tool Calling
```typescript
async function callAnthropic(apiKey, messages, systemPrompt, tools, modelId) {
  const body = {
    model: modelId || 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: systemPrompt,
    messages: messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content })),
    tools: tools?.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })),
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify(body)
  });
  const data = await res.json();

  const toolUse = data.content.find((c: any) => c.type === 'tool_use');
  if (toolUse) return { functionCall: { name: toolUse.name, args: toolUse.input } };

  const textBlock = data.content.find((c: any) => c.type === 'text');
  return { text: textBlock?.text };
}
```

## Agent Mode — Full Pattern

The agent mode pattern used in FailSense (proven, battle-tested):

```typescript
// 1. Define agent tools
const AGENT_TOOLS: FunctionDeclaration[] = [
  {
    name: 'get_project_summary',
    description: 'Get summary statistics for the current project',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'remove_failure_modes',
    description: 'Remove all events matching the given failure mode keywords',
    parameters: {
      type: 'object',
      properties: {
        keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords to match against failure mode names' }
      },
      required: ['keywords']
    }
  },
  // ... more tools
];

// 2. Execute tools after user confirmation
async function executeAgentTool(toolName: string, args: any, projectData: FailureEvent[]) {
  switch (toolName) {
    case 'remove_failure_modes':
      const toRemove = projectData.filter(e =>
        args.keywords.some((k: string) => e.failureMode.toLowerCase().includes(k.toLowerCase()))
      );
      return {
        preview: `Will remove ${toRemove.length} events matching: ${args.keywords.join(', ')}`,
        execute: () => projectData.filter(e => !toRemove.includes(e))
      };
    // ...
  }
}

// 3. Conversation loop with confirmation
async function handleAgentMessage(userMessage: string, messages: ChatMsg[], project: Project) {
  // Add user message to history
  const updatedMsgs = [...messages, { role: 'user', content: userMessage }];

  // Get context functions for the AI
  const contextData = buildAgentContext(project);

  // Call AI with tools
  const response = await callAI(provider, apiKey, updatedMsgs, AGENT_SYSTEM_PROMPT + contextData, AGENT_TOOLS);

  if (response.functionCall) {
    const result = await executeAgentTool(response.functionCall.name, response.functionCall.args, project.data);

    // Show preview to user
    const previewMsg = { role: 'assistant', content: result.preview, pendingAction: result.execute };
    return { messages: [...updatedMsgs, previewMsg], requiresConfirmation: true };
  }

  return { messages: [...updatedMsgs, { role: 'assistant', content: response.text }], requiresConfirmation: false };
}
```

## RAG (Retrieval-Augmented Generation) Pattern

For large projects, implement lightweight client-side RAG:

```typescript
// src/services/RAGService.ts

interface Chunk {
  id: string;
  type: 'project_header' | 'subsystem' | 'failure' | 'mode' | 'event_group';
  content: string;
  keywords: string[];
  rpn?: number;
}

// 1. Index project data
function indexProject(project: Project): Chunk[] {
  const chunks: Chunk[] = [];

  // Project header chunk
  chunks.push({
    id: 'header',
    type: 'project_header',
    content: `Project: ${project.name}. ${project.description}. Total failures: ${project.data.length}.`,
    keywords: [project.name]
  });

  // Group events by failure mode
  const byMode = groupBy(project.data, e => e.failureMode);
  for (const [mode, events] of Object.entries(byMode)) {
    chunks.push({
      id: `mode_${mode}`,
      type: 'event_group',
      content: `Failure Mode: ${mode}. Count: ${events.length}. Equipment: ${[...new Set(events.map(e => e.equipment))].join(', ')}.`,
      keywords: mode.toLowerCase().split(/\s+/)
    });
  }

  return chunks;
}

// 2. Retrieve relevant chunks
function retrieveChunks(query: string, chunks: Chunk[], topK: number = 5): Chunk[] {
  const queryWords = query.toLowerCase().split(/\s+/);

  const scored = chunks.map(chunk => ({
    chunk,
    score: queryWords.filter(w => chunk.keywords.some(k => k.includes(w) || w.includes(k))).length
  }));

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(s => s.chunk);
}

// 3. Build minimal context for AI
function buildContext(query: string, project: Project): string {
  const chunks = indexProject(project);
  const relevant = retrieveChunks(query, chunks);
  return relevant.map(c => c.content).join('\n\n');
}
```

## Prompt Templates

### System Prompt for Failure Classification
```typescript
const CLASSIFICATION_SYSTEM_PROMPT = `You are a reliability engineer applying ISO 14224 standards.
Your task: classify each maintenance work order into a standardized failure mode.

CRITICAL RULES:
1. Failure mode MUST be directly derivable from the description text
2. Never infer or assume — if unclear, use "Unclassified"
3. Set isSignificant=false for: PMs, inspections, lubrications, calibrations, overhauls
4. Set isSignificant=true for: breakdowns, failures, leaks, trips, emergencies
5. Assign confidence 0–100 with a brief reason (1 sentence)

Standard failure modes:
MECHANICAL: Bearing Failure, Seal/Gasket Failure, Shaft Failure, Coupling Failure, Impeller Damage, Structural Damage, Fastener Failure, Vibration
FLUID: External Leak, Internal Leak, Blockage/Plugging, Cavitation, Corrosion/Erosion, Contamination
ELECTRICAL: Winding Failure, Electrical Fault, Overheating, Insulation Failure, Motor Bearing
INSTRUMENTATION: Sensor Failure, Transmitter Failure, Control Valve, Calibration Drift, Spurious Trip
MAINTENANCE: PM/Inspection, Lubrication, Overhaul, Calibration

Return a JSON array. Each event:
{
  "id": original_id,
  "failureMode": "exact mode name",
  "isSignificant": boolean,
  "confidence": 0-100,
  "confidenceReason": "one sentence"
}`;
```

### System Prompt for RPN Scoring
```typescript
const RPN_SCORING_PROMPT = `You are a senior reliability engineer applying FMEA best practices.
Evaluate the Risk Priority Number components for this failure mode:

Severity (S) — Impact of the failure effect:
1–2: No noticeable effect on operation
3–4: Minor effect, slight inconvenience
5–6: Moderate degradation, partial loss of function
7–8: Significant loss of function, safety concern
9–10: Critical — hazardous, loss of life risk or catastrophic loss

Occurrence (O) — Frequency of the failure cause:
1–2: Remote (< 1 per 10 years for this equipment type)
3–4: Low (1–2 per 5 years)
5–6: Moderate (1–2 per year)
7–8: High (monthly to quarterly)
9–10: Very High (weekly or more)

Detection (D) — Ability to detect before functional failure:
1–2: Almost certain to detect (online monitoring, alarms)
3–4: High detection (regular inspection, easy to spot)
5–6: Moderate (periodic testing required)
7–8: Low (not normally inspected, subtle symptoms)
9–10: Cannot detect (hidden failure, no warning)

Be CONSERVATIVE. Prefer lower scores unless there is clear justification for high values.
Return JSON: { "s": number, "o": number, "d": number, "justification": "2-3 sentences" }`;
```

### System Prompt for Report Generation
```typescript
const REPORT_SPECIALIST_PROMPT = (projectData: string) => `You are a reliability engineering report specialist.
Your task: generate a professional reliability analysis report based on the provided data.

Project data context:
${projectData}

Report structure (return as JSON with these sections):
{
  "title": "Report title",
  "executiveSummary": "2-3 paragraphs, tailored to audience",
  "scopeAndObjective": "Custom narrative about analysis goals",
  "dataOverview": "Event counts, date range, equipment list, % significant",
  "analysisPerMode": [{ "mode": string, "analysis": string, "rootCauseHints": string }],
  "failurePatterns": "Concentration patterns, time clusters, equipment correlations",
  "rootCauseIndicators": "Systemic factors, recurrence patterns",
  "mtbfTable": [{ "mode": string, "count": number, "failureRate": string, "mtbf": string }],
  "recommendations": [{ "priority": 1-5, "action": string, "expectedImpact": string }],
  "conclusion": "Specific next steps with owners and timelines"
}`;
```

### Data Understanding Chat — Initial Prompt
```typescript
const DATA_UNDERSTANDING_PROMPT = (headers: string[], sampleRows: any[]) => `
You are analyzing a maintenance data file. Headers: ${headers.join(', ')}.
Sample rows: ${JSON.stringify(sampleRows.slice(0, 3))}

Identify:
1. id column (order number, work order ID)
2. date column (breakdown date, notification date)
3. equipment column (asset name, functional location)
4. description column (short text, work order description)
5. finishDate column (completion date, actual finish) — optional

Common CMMS keywords:
SAP: AUFNR (order), QMEL (notification), EQUNR (equipment), IWERK (plant), TPLNR (functional location)
Maximo: WONUM (work order), ASSETNUM (asset), ACTSTART/REPORTDATE (date), ACTFINISH (finish)

Return JSON: { idCol, dateCol, equipmentCol, descriptionCol, finishDateCol, systemType, notes }`;
```

## Chatbot UI Component Pattern

The floating chatbot component pattern (from FailSense):

```typescript
interface ChatbotProps {
  mode: 'agent' | 'assistant';
  onModeChange: (mode: 'agent' | 'assistant') => void;
  messages: ChatMsg[];
  onSendMessage: (text: string) => void;
  isLoading: boolean;
  onConfirmAction: (msgId: string) => void;
  onUndoLastAction: () => void;
}

interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  // Agent-specific
  pendingAction?: () => any;        // mutation function awaiting confirmation
  actionStatus?: 'pending' | 'executed' | 'undone';
  actionPreview?: string;           // "Will remove 45 events matching: Bearing"
}
```

Key UI elements:
- Mode toggle (Agent / Assistant) at the top
- Message list with markdown rendering
- Action preview cards with Confirm / Cancel buttons
- Loading indicator during AI calls
- Undo button for last executed action
- Collapsible / minimizable panel
- Context badge showing current project

## Streaming Response Pattern

For long responses (reports, analysis), use streaming:

```typescript
async function streamGemini(apiKey, messages, systemPrompt, onChunk: (text: string) => void) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?key=${apiKey}&alt=sse`;

  const response = await fetch(url, { method: 'POST', /* headers/body */ });
  const reader = response.body!.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = new TextDecoder().decode(value);
    // Parse SSE chunks and extract text
    const lines = text.split('\n').filter(l => l.startsWith('data: '));
    for (const line of lines) {
      const data = JSON.parse(line.slice(6));
      const chunk = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (chunk) onChunk(chunk);
    }
  }
}
```

## Intent Classification Pattern (for RAG routing)

Route user queries to appropriate retrieval strategies:

```typescript
type QueryIntent =
  | 'STRUCTURE_REVIEW'    // "Review the FMECA structure"
  | 'LOCATE_TRACE'        // "Find all modes related to bearing"
  | 'CONSISTENCY_CHECK'   // "Are there duplicate failure modes?"
  | 'GAP_ANALYSIS'        // "What failure modes are missing?"
  | 'RISK_QUERY'          // "What are the highest RPN items?"
  | 'RECOMMENDATION'      // "What should I fix first?"
  | 'CALCULATION'         // "What is the MTBF for pump A?"
  | 'GENERAL_CHAT';       // Everything else

function classifyIntent(query: string): QueryIntent {
  const q = query.toLowerCase();
  if (q.includes('review') || q.includes('structure')) return 'STRUCTURE_REVIEW';
  if (q.includes('find') || q.includes('locate') || q.includes('where')) return 'LOCATE_TRACE';
  if (q.includes('duplicate') || q.includes('consistent')) return 'CONSISTENCY_CHECK';
  if (q.includes('missing') || q.includes('gap') || q.includes('should add')) return 'GAP_ANALYSIS';
  if (q.includes('rpn') || q.includes('risk') || q.includes('critical')) return 'RISK_QUERY';
  if (q.includes('recommend') || q.includes('priorit') || q.includes('fix first')) return 'RECOMMENDATION';
  if (q.includes('mtbf') || q.includes('mttr') || q.includes('calculate')) return 'CALCULATION';
  return 'GENERAL_CHAT';
}

// Map intent to retrieval strategy
const intentToStrategy: Record<QueryIntent, string> = {
  'STRUCTURE_REVIEW': 'full_index',
  'LOCATE_TRACE': 'topk',
  'CONSISTENCY_CHECK': 'full_index',
  'GAP_ANALYSIS': 'full_index',
  'RISK_QUERY': 'rpn_filter',
  'RECOMMENDATION': 'topk',
  'CALCULATION': 'topk',
  'GENERAL_CHAT': 'topk',
};
```

## Batch Processing Pattern

For classifying hundreds of events efficiently:

```typescript
async function batchClassify(events: RawEvent[], apiKey: string, provider: AIProvider) {
  const BATCH_SIZE = 50;  // Respect token limits
  const results: ClassifiedEvent[] = [];

  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    const batch = events.slice(i, i + BATCH_SIZE);
    const prompt = formatBatchPrompt(batch);

    try {
      const response = await callAI(provider, apiKey, [{ role: 'user', content: prompt }], CLASSIFICATION_SYSTEM_PROMPT);
      const parsed = JSON.parse(extractJSON(response.text!));
      results.push(...parsed);
    } catch (e) {
      // Fallback: classify as unclassified with low confidence
      results.push(...batch.map(b => ({ ...b, failureMode: 'Unclassified', confidence: 0 })));
    }

    // Progress callback
    onProgress?.((i + batch.length) / events.length * 100);
  }

  return results;
}
```

## Mock/Demo Mode

Always implement a mock analyzer for demos without API keys:

```typescript
const DEMO_FAILURE_MODES = ['Bearing Failure', 'Seal Leak', 'Electrical Fault', 'Corrosion', 'PM/Inspection', 'Vibration'];

function mockClassify(events: RawEvent[]): ClassifiedEvent[] {
  return events.map(e => {
    const desc = e.description.toLowerCase();
    let mode = 'Unclassified';
    if (desc.includes('bearing')) mode = 'Bearing Failure';
    else if (desc.includes('seal') || desc.includes('leak')) mode = 'Seal Leak';
    else if (desc.includes('electric') || desc.includes('motor')) mode = 'Electrical Fault';
    else if (desc.includes('corrosi')) mode = 'Corrosion';
    else if (desc.includes('pm') || desc.includes('inspection') || desc.includes('lubri')) mode = 'PM/Inspection';
    else mode = DEMO_FAILURE_MODES[Math.floor(Math.random() * DEMO_FAILURE_MODES.length)];

    return {
      ...e,
      failureMode: mode,
      isSignificant: !['PM/Inspection'].includes(mode),
      confidence: 70 + Math.floor(Math.random() * 30),
      confidenceReason: 'Demo mode classification'
    };
  });
}
```
