import { ContextData } from '../types';
import { RICH_LIBRARY } from '../constants';
import { buildCopilotPrompt, parseCopilotReply, getCopilotSessionId } from './copilotHelper';
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
- Do not invent design values, operating limits, component names, causes, controls, or operating conditions. Use exact specifications only when provided in the Specs, system description, reference data, or checklist knowledge. Otherwise use "required", "specified", or "operating range".`;

const FMECA_CONCISE_WORDING_RULES = `Professional FMECA wording:
- Return concise, direct engineering statements. Prefer 6-14 words for functional failures, 2-7 words for failure modes, and 2-8 words for causes.
- Avoid explanatory clauses, narratives, stacked adjectives, and long comma chains.
- Do not write generic words such as "failed", "problem", "malfunction", "issue", or "not working" unless a specific failed condition is also stated.
- Never include internal reasoning, uncertainty, self-correction, reviewer notes, or conversational text such as "wait", "let me", "I think", "reconsider", "analysis", or "reasoning".
- Do not add labels, prefixes, numbering, bullets, markdown, or commentary unless the output contract requires them.`;

const FUNCTION_DESCRIPTION_TECHNICAL_RULES = `Function description rules:
- Describe intended operation only: what the subsystem provides, controls, transfers, supports, protects, measures, contains, or conditions for the parent system.
- Start with the subsystem name where natural.
- Use exact values from Specs only when Specs provides them. If Specs is empty or generic, do not invent numbers; use "required", "specified", or "operating range".
- Do not include functional failures, failure modes, causes, effects, alarms, trips, inspections, PM tasks, controls, mitigations, recommendations, or maintenance wording.
- Output one concise sentence only.`;

const FUNCTION_BREAKDOWN_TECHNICAL_RULES = `Function breakdown rules:
- Break the subsystem function into reasonable smaller intended actions only when decomposition is part of this workflow.
- Each row must use one functional verb plus one object plus a required performance boundary or purpose.
- Rewrite source text into compact engineering function labels; do not copy long clauses from the function description.
- Do not start function labels with "to", gerunds such as "maintaining/filtering/limiting", or vague nouns.
- Include only functions inside the subsystem boundary and supported by the function description/specs.
- Do not create rows from causes, effects, alarms, trips, safeguards, controls, mitigations, inspections, repairs, tests, tags, values, personnel instructions, or maintenance tasks.
- Stop at useful FMECA functions. Do not split into bolts, gaskets, fasteners, individual values, or sentence fragments unless the subsystem scope requires it.`;

const FUNCTIONAL_FAILURE_TECHNICAL_RULES = `Functional failure rules:
- Describe required performance not achieved, not a physical mechanism.
- Link directly to the subsystem function or decomposed function.
- Use concise patterns such as "Fails to ...", "Unable to ...", "Does not ...", "Provides insufficient ...", "Provides excessive ...", "Operates intermittently ...", or "Operates when not required".
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
        const refBlock = `REFERENCE DATA:\n"""\n${refText.slice(0, 15000)}\n"""\n`;
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
            .replace(/^\s*(?:Function(?: Description)?|Functional Failure|Failure Mode|Failure Effect|Failure Cause|Cause|Effect)\s*:\s*/i, '')
            .replace(/\s+/g, ' ')
            .trim();
    },

    normalizeFunctionPhraseForFailure(text: string): string {
        let s = this.cleanSingleFieldText(text)
            .replace(/^(?:to|and)\s+/i, '')
            .replace(/\bwithin\b.*$/i, '')
            .replace(/\s+/g, ' ')
            .trim();
        const replacements: Record<string, string> = {
            supplies: 'supply',
            supply: 'supply',
            supplying: 'supply',
            delivers: 'deliver',
            delivering: 'deliver',
            transfers: 'transfer',
            transferring: 'transfer',
            circulates: 'circulate',
            circulating: 'circulate',
            conditions: 'condition',
            conditioning: 'condition',
            maintains: 'maintain',
            maintaining: 'maintain',
            filters: 'filter',
            filtering: 'filter',
            limits: 'limit',
            limiting: 'limit',
            lubricates: 'lubricate',
            lubricating: 'lubricate',
            cools: 'cool',
            cooling: 'cool',
            seals: 'seal',
            sealing: 'seal',
            protects: 'protect',
            protecting: 'protect',
            controls: 'control',
            controlling: 'control',
            measures: 'measure',
            measuring: 'measure'
        };
        s = s.replace(/\b(supplies|supplying|delivers|delivering|transfers|transferring|circulates|circulating|conditions|conditioning|maintains|maintaining|filters|filtering|limits|limiting|lubricates|lubricating|cools|cooling|seals|sealing|protects|protecting|controls|controlling|measures|measuring)\b/gi, m => replacements[m.toLowerCase()] || m);
        return s.replace(/\s+/g, ' ').trim();
    },

    fallbackFunctionalFailure(row?: { function?: string; standard?: string }): string {
        const fn = this.normalizeFunctionPhraseForFailure(row?.function || 'perform required function');
        const standard = this.cleanSingleFieldText(row?.standard || '');
        const combined = standard && !fn.toLowerCase().includes(standard.toLowerCase())
            ? `${fn} ${standard}`
            : fn;
        return `Fails to ${combined}`.replace(/\s+/g, ' ').trim();
    },

    cleanFunctionalFailureText(text: string, row?: { function?: string; standard?: string }): string {
        let s = this.cleanSingleFieldText(text);
        const leakPattern = /\b(?:wait|let me|i need|i should|i think|i will|reconsider|analysis|reasoning|scratchpad|thought process|internal note|actually)\b/i;
        if (leakPattern.test(s)) {
            const candidates = Array.from(s.matchAll(/\b(?:Fails to|Unable to|Does not|Provides insufficient|Provides excessive|Operates intermittently|Operates when not required|Performs [^.;!?]+)\b[^.;!?]*/gi))
                .map(m => this.cleanSingleFieldText(m[0]))
                .filter(Boolean);
            s = candidates.length ? candidates[candidates.length - 1] : '';
        }
        s = s
            .replace(/^(?:here(?:'s| is)|the functional failure is|functional failure)\s*[:\-]?\s*/i, '')
            .replace(/\b(?:wait|let me|i need|i should|i think|i will|reconsider|analysis|reasoning|scratchpad|thought process|internal note|actually)\b.*$/i, '')
            .replace(/\s+/g, ' ')
            .trim();

        const words = s.split(/\s+/).filter(Boolean);
        const startsLikeFailure = /^(Fails to|Unable to|Does not|Provides insufficient|Provides excessive|Operates intermittently|Operates when not required|Performs\b)/i.test(s);
        const invalid = !s || !startsLikeFailure || words.length > 22 || leakPattern.test(s);
        return invalid ? this.fallbackFunctionalFailure(row) : s;
    },

    cleanBreakdownRow(row: { function: string; standard: string; snippet: string }): { function: string; standard: string; snippet: string } {
        const fn = this.normalizeFunctionPhraseForFailure(row.function);
        const standard = this.cleanSingleFieldText(row.standard)
            .replace(/^(?:to|and)\s+/i, '')
            .replace(/\s+/g, ' ')
            .trim();
        return {
            function: fn,
            standard,
            snippet: this.cleanSingleFieldText(row.snippet || row.function),
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

    // -------------------------------------------------------------------------
    // FEATURE IMPLEMENTATIONS (Refactored to use contract)
    // -------------------------------------------------------------------------

    async generate(prompt: string, currentText: string, key: string, modelName: string, mode: string = 'ai', refText: string = '', contextData: ContextData = {}, aiProvider: string = '', azureEndpoint: string = '', systemContext: string = '', powerAutomateUrl: string = ''): Promise<string> {
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
                ? `PM CHECKLIST KNOWLEDGE (plant's EXISTING PM program, organized by team and interval):\n"""\n${checklistContent.slice(0, 6000)}\n"""\n\n`
                : '';
            const referenceBlock = refText.trim()
                ? `REFERENCE DATA (deployed equipment, instruments, alarms, trips, interlocks, limits):\n"""\n${refText.slice(0, 7000)}\n"""\n\n`
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
- If nothing is evidenced for this failure mode, return an empty response.
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
                model: modelName,
                messages: [{ role: 'user', content: controlsContent }],
                mode: 'ai',
                apiKey: key,
                responseFormat: 'text'
            });
            return this.cleanNumberedActionList(controlsRes);
        }
        // --- END CURRENT CONTROLS SPECIALIST ---

        if (!isFMECAContentField && currentText && wordCount > 0 && wordCount <= 5) {
            return this.chat({
                feature: 'field-generation',
                provider: (aiProvider || inferProvider(key)) as any,
                azureEndpoint: azureEndpoint || undefined,
                powerAutomateUrl: powerAutomateUrl || undefined,
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
                const refSection = refText?.trim() ? `REFERENCE DATA (P&IDs, datasheets, safeguarding instruments with tag numbers and alarm limits):\n"""\n${refText.slice(0, 7000)}\n"""\n\n` : '';
                const checkSection = checklistContent?.trim() ? `PM CHECKLIST KNOWLEDGE (organized by team and PM interval):\n"""\n${checklistContent.slice(0, 6000)}\n"""\n\n` : '';
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
                corePrompt = `Context: System "${contextData.project || 'Unknown'}", Subsystem "${contextData.subsystem}".
                The user wrote these specifications: """${currentText}"""
                Task: Rewrite and enhance them in the correct format.
                Format: Comma-separated list of "Key: Value Unit".
                Example: Power: 400 W, Voltage: 415 V, Speed: 3590 RPM, Material: SS316, Protection: IP55.
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
                Task: Write a Function Description for this subsystem.
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
                corePrompt = `Context: System "${contextData.project || 'Unknown'}", Subsystem "${contextData.subsystem}".
                Task: Generate technical specifications.
                Format: Comma-separated list of "Key: Value Unit".
                Requirements: Use only values, ratings, materials, limits, or equipment details already present in the project context or reference data. If no specifications are provided, return an empty response. Keep it technical and concise. Do not include the word "Specs:" at the start.`;
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
            model: modelName,
            messages: [{ role: 'user', content: content }],
            mode: mode as 'ai'|'file'|'hybrid',
            refText,
            contextData,
            apiKey: key,
            responseFormat: 'text'
        });
        if (isFunctionalFailureField) return this.cleanFunctionalFailureText(generated, { function: (contextData as any).subsystemFunction || (contextData as any).function || '', standard: '' });
        if (isFMECAContentField) return this.cleanSingleFieldText(generated);
        return generated;
    },

    async generateMasterStructure(sysName: string, sysDesc: string, key: string, modelName: string, mode: string, refText: string, aiProvider: string = '', azureEndpoint: string = '', systemContext: string = '', powerAutomateUrl: string = ''): Promise<any> {
        if((!key || key.length < 10) && aiProvider !== 'copilot') { await new Promise(r => setTimeout(r, 2000)); return []; }
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

    async generateCompleteSubsystem(name: string, specs: string, funcDesc: string, projectContext: string, key: string, modelName: string, mode: string = 'ai', refText: string = '', aiProvider: string = '', azureEndpoint: string = '', systemContext: string = '', checklistText: string = '', powerAutomateUrl: string = '', existingFailures: string[] = [], detailLevel: 'normal' | 'detailed' = 'detailed'): Promise<any> {
        // eslint-disable-next-line
        const generateId = () => Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
        if((!key || key.length < 10) && aiProvider !== 'copilot') { await new Promise(r => setTimeout(r, 1500)); return { failures: [{ desc: `Failure to perform`, modes: [{ id: generateId(), mode: "Fatigue", effect: "Local: Loss of integrity; End: Reduced system availability", cause: "Aging", currentControls: "", mitigation: "1- Scheduled inspection (Mechanical team)", rpn: blankGeneratedRpn(), rpnStatus: "unscored" }] }] }; }
        const checklistBlock = (checklistText?.trim() && (mode === 'file' || mode === 'hybrid'))
            ? `PM CHECKLIST KNOWLEDGE (use section names as team owners for mitigation tasks):\n"""\n${checklistText.slice(0, 6000)}\n"""\n\n` : '';
        const controlsKnowledgeAvailable = (mode === 'file' || mode === 'hybrid') && (Boolean(checklistText?.trim()) || Boolean(refText?.trim()));
        const existingBlock = existingFailures.length > 0
            ? `Existing Functional Failures already defined for this subsystem (DO NOT repeat or closely resemble):\n${existingFailures.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n\n` : '';
        const mitigationInstruction = `\n${MODE_ACTION_FORMAT_RULES}`;
        const corePrompt = `${checklistBlock}${existingBlock}Context: System "${projectContext}", Subsystem "${name}". Specs: "${specs}". Function Provided: "${funcDesc}".
        ${FMECA_HIERARCHY_RULES}
        ${FMECA_CONCISE_WORDING_RULES}
        ${FUNCTION_DESCRIPTION_TECHNICAL_RULES}
        ${FUNCTIONAL_FAILURE_TECHNICAL_RULES}
        ${FAILURE_MODE_TECHNICAL_RULES}
        Task:
        1. If "Function Provided" is empty, infer the subsystem function internally using intended-operation wording, then derive failures from that inferred function. Do not add a function field to the JSON. Use exact values from Specs only when provided; otherwise do not invent values.
        ${detailLevel === 'normal'
            ? '2. Derive distinct Functional Failures strictly from the Function. Scale the count to complexity (simple component: 2, complex subsystem: up to 3). Cover the most credible loss modes; do not enumerate every theoretical variant.'
            : '2. Derive distinct Functional Failures strictly from the Function. Scale the count to the subsystem\'s complexity and criticality (simple component: 2, critical complex subsystem: up to 5). Cover total loss, partial loss, intermittent operation, incorrect operation, and over-function only where the function supports them.'}
        3. For each failure, generate Failure Modes, Effects, Causes, Current Controls and Mitigations. Failure modes must be unique across the whole subsystem — never repeat a mode under two failures. Treat other generated modes as siblings; do not share generic controls or actions across them.
        4. Internally validate every row before final JSON: function = intended operation; functional failure = required performance not achieved; mode = specific failed state; cause = why mode occurs; effect = what happens after mode; controls/mitigation = barriers only.
        ${buildModeFieldRules(controlsKnowledgeAvailable, 'THIS failure mode')}
        Do NOT generate or include RPN/S/O/D values. RPN is scored later by the dedicated RPN scorer.
        Return JSON object: { "failures": [ { "desc": "string (Functional Failure)", "modes": [ { "mode": "string", "effect": "string", "cause": "string", "currentControls": "string", "mitigation": "string" } ] } ] }${mitigationInstruction}`;

        const content = corePrompt + (systemContext
            ? `\n\nApply operational history only to Task 3 Failure Mode selection; never use it to write Functional Failure text.\n${OPERATIONAL_HISTORY_GUIDANCE_RULES}\n\n${systemContext}`
            : '');

        try {
            const res = await this.chat({
                feature: 'subsystem-generation',
                provider: (aiProvider || inferProvider(key)) as any,
                azureEndpoint: azureEndpoint || undefined,
                powerAutomateUrl: powerAutomateUrl || undefined,
                model: modelName,
                messages: [{ role: 'user', content: content }],
                mode: mode as 'ai'|'file'|'hybrid',
                refText,
                apiKey: key,
                responseFormat: 'json'
            });
            const parsed = this.extractJSON(res);
            // currentControls require checklist/reference evidence — forced empty otherwise,
            // no matter what the model returned.
            if (!controlsKnowledgeAvailable) {
                (parsed?.failures || []).forEach((f: any) => (f.modes || []).forEach((m: any) => { m.currentControls = ''; }));
            }
            (parsed?.failures || []).forEach((f: any) => (f.modes || []).forEach((m: any) => { m.rpn = blankGeneratedRpn(); m.rpnStatus = 'unscored'; }));
            return parsed;
        } catch(e) { console.warn('[generateCompleteSubsystem] failed:', e); return null; }
    },

    async generateModesForFailure(failDesc: string, subName: string, subSpecs: string, subFunc: string, project: string, key: string, modelName: string, mode: string = 'ai', refText: string = '', aiProvider: string = '', azureEndpoint: string = '', systemContext: string = '', checklistText: string = '', powerAutomateUrl: string = '', existingModes: string[] = []): Promise<any[]> {
        // eslint-disable-next-line
        const generateId = () => Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
        if ((!key || key.length < 10) && aiProvider !== 'copilot') { await new Promise(r => setTimeout(r, 1000)); return [{ id: generateId(), mode: "Simulated", effect: "Local: Effect; End: System effect", cause: "Cause", currentControls: "", mitigation: "1- Scheduled inspection (Mechanical team)", rpn: blankGeneratedRpn(), rpnStatus: "unscored" }]; }
        const checklistBlock = (checklistText?.trim() && (mode === 'file' || mode === 'hybrid'))
            ? `PM CHECKLIST KNOWLEDGE (use section names as team owners for mitigation tasks):\n"""\n${checklistText.slice(0, 6000)}\n"""\n\n` : '';
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
        rows: Array<{ id: string; function: string; standard: string; snippet: string }>;
        existingFailures: string[];
        key: string;
        modelName: string;
        aiProvider?: string;
        azureEndpoint?: string;
        powerAutomateUrl?: string;
        systemContext?: string;
    }): Promise<{ failures: Array<{ rowId: string; desc: string; sourceSnippet?: string }> }> {
        const { systemName, subsystemName, subsystemSpecs, funcDesc, rows, existingFailures, key, modelName, aiProvider = '', azureEndpoint = '', powerAutomateUrl = '', systemContext = '' } = args;
        if (!rows.length) return { failures: [] };
        if ((!key || key.length < 10) && aiProvider !== 'copilot') {
            return { failures: rows.map(r => ({ rowId: r.id, desc: `Fails to ${r.function} ${r.standard}`.replace(/\s+/g, ' ').trim(), sourceSnippet: r.snippet })) };
        }
        const existingBlock = existingFailures.length > 0
            ? `Existing Functional Failures already defined (DO NOT repeat or closely resemble):\n${existingFailures.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n\n`
            : '';
        const prompt = `Context: System "${systemName}", Subsystem "${subsystemName}".
Subsystem Specs: "${subsystemSpecs || 'N/A'}"
Subsystem Function: "${funcDesc}"

Function breakdown rows:
${JSON.stringify(rows.map(r => ({ rowId: r.id, function: r.function, standard: r.standard, snippet: r.snippet })), null, 2)}

${existingBlock}Task: Generate ONE Functional Failure for each breakdown row.
${FMECA_HIERARCHY_RULES}
${FMECA_CONCISE_WORDING_RULES}
${FUNCTIONAL_FAILURE_TECHNICAL_RULES}
Use each row's function label and performance/condition standard as the primary source. The standard defines what "failed" means; do not ignore it.
Use the full subsystem function only to resolve ambiguity, not to add extra details.
Write short professional FMECA failure states, not narratives.
Length per failure: 6-14 words.
Do NOT generate duplicate or closely similar failures. If two rows would produce the same failure, return the clearer one and omit the duplicate row.

Return ONLY strict JSON:
{ "failures": [ { "rowId": "same rowId from input", "desc": "Functional Failure", "sourceSnippet": "source snippet from row" } ] }`;
        // Functional Failure generation must remain independent from historical
        // failed-state labels. Keep parameter for API compatibility.
        const content = prompt;
        try {
            const parsed = await this._withRetry(async () => {
                const res = await this.chat({
                    feature: 'ff-batch-generation',
                    provider: (aiProvider || inferProvider(key)) as any,
                    azureEndpoint: azureEndpoint || undefined,
                    powerAutomateUrl: powerAutomateUrl || undefined,
                    model: modelName,
                    messages: [{ role: 'user', content }],
                    mode: 'ai',
                    refText: '',
                    apiKey: key,
                    responseFormat: 'json'
                });
                return this.extractJSON(res);
            });
            const failures = Array.isArray(parsed?.failures) ? parsed.failures : [];
            const validRowIds = new Set(rows.map(r => r.id));
            return {
                failures: failures
                    .map((f: any) => ({
                        rowId: String(f?.rowId ?? f?.row_id ?? '').trim(),
                        desc: this.cleanFunctionalFailureText(
                            String(f?.desc ?? f?.failure ?? f?.functionalFailure ?? '').trim(),
                            rows.find(r => r.id === String(f?.rowId ?? f?.row_id ?? '').trim())
                        ),
                        sourceSnippet: String(f?.sourceSnippet ?? f?.source_snippet ?? '').trim(),
                    }))
                    .filter((f: any) => validRowIds.has(f.rowId) && f.desc)
            };
        } catch (e) {
            console.warn('[generateFFsForBreakdownRows] failed:', e);
            return { failures: [] };
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
    }): Promise<{ failures: Array<{ failureId: string; modes: any[] }> }> {
        const { project, subName, subSpecs, subFunc, failures, key, modelName, mode = 'ai', refText = '', aiProvider = '', azureEndpoint = '', systemContext = '', checklistText = '', powerAutomateUrl = '', existingModes = [] } = args;
        if (!failures.length) return { failures: [] };
        if ((!key || key.length < 10) && aiProvider !== 'copilot') {
            return { failures: failures.map(f => ({ failureId: f.id, modes: [{ mode: "Simulated", effect: "Local: Effect; End: System effect", cause: "Cause", currentControls: "", mitigation: "1- Scheduled inspection (Mechanical team)", rpn: blankGeneratedRpn(), rpnStatus: "unscored" }] })) };
        }
        const checklistBlock = (checklistText?.trim() && (mode === 'file' || mode === 'hybrid'))
            ? `PM CHECKLIST KNOWLEDGE (use section names as team owners for mitigation tasks):\n"""\n${checklistText.slice(0, 6000)}\n"""\n\n` : '';
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
  }
): Promise<{ s: number; o: number; d: number; reason?: string; confidence?: 'high' | 'medium' | 'low'; baseline?: { s: number; o: number; d: number }; improvement?: { baselineRpn: number; mitigatedRpn: number; detectionImprovement: number; rpnReduction: number; summary: string } }> {
  const {
    project, subName, subSpecs, subFunc, failDesc,
    mode, effect, cause, currentControls = '', mitigation,
    key, modelName, modeSource = 'ai', refText = '',
    aiProvider = '', azureEndpoint = '', systemContext = '', systemType = '', systemModes = [], powerAutomateUrl = ''
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
      model: modelName,
      messages: [{ role: 'user', content: rpnContent }],
      mode: modeSource,
      refText,
      apiKey: key,
      responseFormat: 'json'
    });
    return this.extractJSON(res);
  });

  // Normalize and clamp
  const clamp = (n: any) => Math.min(10, Math.max(1, Math.round(Number(n) || 5)));

  const hasConcreteMitigation = mitigation.trim() && !/^(none|n\/a|unknown|improve maintenance|regular maintenance|inspect regularly|monitor condition)$/i.test(mitigation.trim());
  const preventiveMitigation = /\b(replace|redesign|upgrade|modify|prevent|eliminate|filter|clean|balance|align|lubricat|seal|tighten|torque|calibrat|flush|change oil|oil analysis|contamination control|root cause)\b/i.test(mitigation);
  const detectionMitigation = /\b(alarm|trip|monitor|sensor|transmitter|switch|inspect|inspection|test|proof|diagnostic|vibration|temperature|pressure|flow|level|analysis|sample|trend|detect)\b/i.test(mitigation);
  const severityMitigation = /\b(relief|contain|secondary containment|shutdown|trip|isolate|interlock|protect|fire|blast|spill|consequence)\b/i.test(mitigation);

  const parsedS = clamp(parsed.s);
  const parsedO = clamp(parsed.o);
  const parsedD = clamp(parsed.d);
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
  const rawReason = typeof parsed.reason === 'string' ? this.cleanSingleFieldText(parsed.reason) : '';
  const reason = /^S:\s*\d+.*\bO:\s*\d+.*Baseline D:\s*\d+.*Mitigated D:\s*\d+.*Confidence:\s*(high|medium|low)/i.test(rawReason)
    ? rawReason
    : fallbackReason;

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

    async _powerAutomateRequest(req: AIRequestPayload): Promise<string> {
        if (!req.powerAutomateUrl) {
            throw new Error('Power Automate URL is required for Copilot provider.');
        }

        const rawPrompt = req.feature === 'chatbot'
            ? req.messages
                .map(m => `${m.role.toUpperCase()}:\n${typeof m.content === 'string' ? m.content : ''}`)
                .join('\n\n')
            : (() => {
                const lastUserMessage = [...req.messages].reverse().find(m => m.role === 'user');
                return typeof lastUserMessage?.content === 'string' ? lastUserMessage.content : '';
            })();

        const fullPrompt = this.attachContext(rawPrompt, req.mode, req.refText ?? '', req.responseFormat);

        const payload = {
            sessionId: req.sessionId ?? crypto.randomUUID(),
            prompt: fullPrompt,
            responseFormat: req.responseFormat ?? 'text',
        };

        const res = await fetch(req.powerAutomateUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Power Automate Error: ${res.statusText}${errText ? ` — ${errText}` : ''}`);
        }

        return res.text();
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
        systemContext: string = ''
    ): Promise<string> {
        if ((!key || key.length < 10) && aiProvider !== 'copilot') return '';
        const existingBlock = existingFailures.length > 0
            ? `Existing Functional Failures already defined (DO NOT repeat or closely resemble):\n${existingFailures.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n\n`
            : '';
        const prompt = `Context: System "${systemName}", Subsystem "${subsystemName}".
Subsystem Specs: "${subsystemSpecs || 'N/A'}"
Subsystem Function: "${funcDesc}"
Function label (black text): "${breakdownSnippet}"
Performance/condition standard (grey text): "${breakdownStandard || 'N/A'}"

${existingBlock}Task: Generate ONE Functional Failure that specifically addresses the loss or degradation of this functional aspect.
${FMECA_HIERARCHY_RULES}
${FMECA_CONCISE_WORDING_RULES}
${FUNCTIONAL_FAILURE_TECHNICAL_RULES}
Use the function label and performance/condition standard as the primary source. The standard defines what "failed" means; do not ignore it.
Use the full subsystem function only to resolve ambiguity, not to add extra details.
Write a short professional FMECA failure state, not a narrative.
Length: 6-14 words.
Return ONLY the Functional Failure statement — one concise line, no prefix, no explanation.`;

        const content = prompt + (systemContext ? '\n\n' + systemContext : '');
        try {
            const res = await this._withRetry(() => this.chat({
                feature: 'ff-for-row',
                provider: (aiProvider || inferProvider(key)) as any,
                azureEndpoint: azureEndpoint || undefined,
                powerAutomateUrl: powerAutomateUrl || undefined,
                model: modelName,
                messages: [{ role: 'user', content }],
                mode: 'ai',
                refText: '',
                apiKey: key,
                responseFormat: 'text'
            }));
            return this.cleanFunctionalFailureText(res, { function: breakdownSnippet, standard: breakdownStandard });
        } catch {
            return '';
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
        detailLevel: 'normal' | 'detailed' = 'detailed'
    ): Promise<Array<{ function: string; standard: string; snippet: string }>> {
        if (!funcDesc?.trim()) return [];
        if ((!key || key.length < 10) && aiProvider !== 'copilot') return [];

        const contextLine = (subsystemName || projectName)
            ? `Subsystem: "${subsystemName}"${projectName ? ` within System: "${projectName}"` : ''}\n\n`
            : '';

        const detailRule = detailLevel === 'normal'
            ? 'Return 2-5 rows. Include each present seed type separately; prefer fewer rows when rows would be similar.'
            : 'Return up to 6 rows. Split only genuinely distinct intended functions or failure consequences, not values, tags, safeguards, or sentence parts.';

        const prompt = `Role: You are a senior FMECA facilitator. Your task is not text splitting. Your task is to identify Functional Failure seeds from a subsystem Function description. Be deterministic: given the same input, always produce the same rows.
${FMECA_HIERARCHY_RULES}
${FMECA_CONCISE_WORDING_RULES}
${FUNCTION_BREAKDOWN_TECHNICAL_RULES}

${contextLine}Function description:
"""
${funcDesc}
"""

Use this method silently:
1. Read the whole description as one subsystem duty.
2. Identify subsystem mission: value, service, containment, conversion, movement, protection, storage, or support it must provide.
3. Identify controlled performance: variables, states, sequences, capacities, demand response, standby behavior, or operating targets that must be maintained.
4. Identify operating envelope: measurable ranges, boundaries, or limits within which operation must remain acceptable.
5. Identify equipment-health expectations: integrity or condition requirements needed for acceptable operation.
6. Treat design facts, protection devices, monitoring references, control architecture, locations, identifiers, and personnel instructions as supporting context only unless they are the subsystem mission.
7. Merge clauses within the same seed type when they would fail in the same way or produce the same Functional Failure.
8. Keep a row only if its loss or degradation would produce a distinct Functional Failure statement.
9. Before final answer, audit silently:
   - Did I over-split one duty into many rows?
   - Did I over-skip measurable limits, control behavior, operating envelope, or equipment-health expectations?
   - Did I create standalone rows for context-only facts?
   - Would every row become a useful Functional Failure?

Output rows only for these seed types, but do not include the type name in the JSON:
- mission
- performance_control
- operating_envelope
- equipment_health

Do not combine different seed types into one row. If mission, performance_control, operating_envelope, and equipment_health are all present, output separate rows for each present type.

Decompose by failure consequence, not by grammar, sentence boundaries, individual values, tags, safeguards, or equipment parts.
${detailRule}

JSON field rules:
- function = concise functional verb + object, 2-7 words.
- standard = required performance standard, control requirement, operating envelope, or condition requirement, 3-10 words.
- snippet = verbatim source slice from the original description, 15-80 characters.

Return ONLY this JSON, no prose, no markdown:
{ "rows": [ { "function": "...", "standard": "...", "snippet": "..." } ] }`;

        const content = prompt + (systemContext ? '\n\n' + systemContext : '');
        try {
            const parsed = await this._withRetry(async () => {
                const res = await this.chat({
                    feature: 'function-decomposition',
                    provider: (aiProvider || inferProvider(key)) as any,
                    azureEndpoint: azureEndpoint || undefined,
                    powerAutomateUrl: powerAutomateUrl || undefined,
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
            type BreakdownRow = { function: string; standard: string; snippet: string };
            const rawRows: BreakdownRow[] = parsed.rows
                .map((r: any) => this.cleanBreakdownRow({
                    function: String(r?.function ?? '').trim(),
                    standard: String(r?.standard ?? '').trim(),
                    snippet: String(r?.snippet ?? '').trim(),
                }))
                .filter((r: any) => r.function && r.standard);

            const isControlSubsystem = /transmitter|sensor|instrument|control|panel|plc|ucp|pcs|sgs|logic|controller/i.test(`${subsystemName} ${projectName}`);
            const compact = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
            const textOf = (r: BreakdownRow) => compact(`${r.function} ${r.standard} ${r.snippet}`);
            const includesAny = (text: string, terms: RegExp[]) => terms.some(re => re.test(text));
            const rows: BreakdownRow[] = [];
            const usedKeys = new Set<string>();
            const maxRows = detailLevel === 'normal' ? 5 : 6;
            const rowKey = (row: BreakdownRow) => `${compact(row.function)}|${compact(row.standard)}`
                .replace(/\b(leaks?|leakage)\b/g, 'leak')
                .replace(/\b(properly|correctly|adequately|reliably)\b/g, '')
                .replace(/\s+/g, ' ')
                .trim();
            const addRow = (row: BreakdownRow) => {
                const cleaned = {
                    function: row.function.trim(),
                    standard: row.standard.trim(),
                    snippet: (row.snippet || row.function).trim(),
                };
                const key = rowKey(cleaned);
                if (!cleaned.function || !cleaned.standard || usedKeys.has(key)) return;
                usedKeys.add(key);
                rows.push(cleaned);
            };

            const weakOnly = /^(reliable|efficient|safe|available|continuous|proper|properly|as required|normal|normal operation|good condition|acceptable|adequate|within limits|per design)$/i;
            const controlTerms = [/\b(control|regulate|maintain|stabilize|modulate|sequence|start|stop|load|unload|setpoint|set point|feedback|demand response)\b/];
            const envelopeTerms = [/\b(operating envelope|envelope|range|limit|rated|design|maximum|minimum|temperature|pressure|flow|speed|capacity|level)\b/];
            const conditionTerms = [/\b(abnormal|condition|integrity|vibration|leak|overheat|overheating|temperature rise|thermal|noise|sound|wear|corrosion)\b/];
            const serviceFunctionTerms = [/\b(deliver|supply|provide|pump|transfer|convert|heat|cool|filter|separate|store|contain|generate)\b/];
            const ppeTerms = [/\b(hearing protection|ppe|personnel|operator exposure|protective equipment)\b/];
            const safeguardTerms = [/\b(safety valve|relief valve|rupture disc|interlock|trip|alarm|shutdown|protection device|overpressure protection|set pressure)\b/];
            const monitoringTerms = [/\b(transmitter|sensor|indicator|feedback|monitored|monitoring|control panel|plc|dcs|scada|ucp|pcs|sgs)\b/];
            const designOnlyTerms = [/\b(material|construction|casing|housing|frame|skid|designed for)\b/];

            const isNoiseExposureOnly = (text: string) =>
                /\b(noise|sound)\b/.test(text) && /\b(db|decibel|hearing|personnel|operator|meter|metre)\b/.test(text);
            const isFunctionalVerb = (fn: string) =>
                /\b(operate|run|maintain|deliver|supply|provide|contain|control|regulate|protect|store|transfer|generate)\b/.test(compact(fn));
            const conditionLabels = (text: string) => {
                const source = compact(text);
                const labels = [
                    [/\bvibration\b/, 'abnormal vibration'],
                    [/\bleak/, 'leakage'],
                    [/\b(overheat|overheating|temperature rise|excessive temperature|thermal)\b/, 'abnormal temperature'],
                    [/\b(unusual noise|abnormal noise)\b/, 'abnormal noise'],
                    [/\bwear\b/, 'abnormal wear'],
                    [/\bcorrosion\b/, 'corrosion'],
                ].filter(([re]) => (re as RegExp).test(source)).map(([, label]) => label as string);
                return Array.from(new Set(labels));
            };
            const joinList = (items: string[]) => {
                if (items.length <= 2) return items.join(' or ');
                return `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1]}`;
            };
            const shouldSkip = (row: BreakdownRow) => {
                const text = textOf(row);
                if (weakOnly.test(row.standard.trim())) return true;
                if (includesAny(text, ppeTerms)) return true;
                if (!/noise|sound|acoustic/i.test(`${subsystemName} ${projectName}`) && isNoiseExposureOnly(text)) return true;
                if (!isControlSubsystem && includesAny(text, safeguardTerms)) return true;
                if (!isControlSubsystem && includesAny(text, monitoringTerms)) return true;
                if (includesAny(text, designOnlyTerms) && !isFunctionalVerb(row.function)) return true;
                return false;
            };

            const candidateRows: BreakdownRow[] = [];
            rawRows.forEach(row => {
                if (shouldSkip(row)) return;
                const text = textOf(row);
                const hasEnvelope = includesAny(text, envelopeTerms);
                const labels = conditionLabels(`${row.function} ${row.standard} ${row.snippet}`);
                if (hasEnvelope && labels.length) {
                    candidateRows.push({
                        function: row.function,
                        standard: 'within the specified operating envelope',
                        snippet: row.snippet || row.function,
                    });
                    candidateRows.push({
                        function: 'operates within equipment condition limits',
                        standard: `without ${joinList(labels)}`,
                        snippet: row.snippet || row.standard || row.function,
                    });
                    return;
                }
                candidateRows.push(row);
            });

            const hasConditionCandidate = candidateRows.some(row => includesAny(textOf(row), conditionTerms));
            const sourceConditionLabels = conditionLabels(funcDesc);
            if (!hasConditionCandidate && sourceConditionLabels.length) {
                candidateRows.push({
                    function: 'operates within equipment condition limits',
                    standard: `without ${joinList(sourceConditionLabels)}`,
                    snippet: funcDesc.match(/(?:without|no|abnormal|excessive|unusual)[^.]{15,160}/i)?.[0]?.slice(0, 160) || 'equipment condition limits',
                });
            }

            const bucketOf = (row: BreakdownRow) => {
                if (shouldSkip(row)) return '';
                const text = textOf(row);
                const fn = compact(row.function);
                if (includesAny(text, conditionTerms)) return 'condition';
                if (includesAny(text, controlTerms)) return 'control';
                if (includesAny(text, envelopeTerms) && !includesAny(fn, serviceFunctionTerms)) return 'envelope';
                return `row:${rowKey(row)}`;
            };
            const mergeBucket = (bucket: string, group: BreakdownRow[]): BreakdownRow => {
                const first = group[0];
                if (group.length === 1) return first;
                const joined = group.map(textOf).join(' ');
                if (bucket === 'condition') {
                    const conditions = conditionLabels(joined);
                    return {
                        function: isFunctionalVerb(first.function) ? first.function : 'operates within equipment condition limits',
                        standard: conditions.length ? `without ${joinList(conditions)}` : first.standard,
                        snippet: first.snippet || first.function,
                    };
                }
                if (bucket === 'control') {
                    return {
                        function: first.function,
                        standard: 'to the specified control target, band, sequence, or demand response',
                        snippet: first.snippet || first.function,
                    };
                }
                if (bucket === 'envelope') {
                    return {
                        function: first.function,
                        standard: 'within the specified operating envelope',
                        snippet: first.snippet || first.function,
                    };
                }
                return first;
            };

            const bucketOrder: string[] = [];
            const buckets = new Map<string, BreakdownRow[]>();
            candidateRows.forEach(row => {
                const bucket = bucketOf(row);
                if (!bucket) return;
                if (!buckets.has(bucket)) {
                    buckets.set(bucket, []);
                    bucketOrder.push(bucket);
                }
                buckets.get(bucket)!.push(row);
            });

            bucketOrder.forEach(bucket => addRow(mergeBucket(bucket, buckets.get(bucket)!)));
            return rows.slice(0, maxRows);
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
        systemContext: string = ''
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
