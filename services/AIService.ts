import { ContextData } from '../types';
import { RICH_LIBRARY } from '../constants';

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
Detection (D) — ability of the CURRENT controls to detect or prevent before impact:
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
     * Sends a chat request with tool definitions.
     * Returns either tool_calls (AI wants to call tools) or text (final answer).
     * Supports: openai, azure, openrouter (tools param), gemini (function_declarations).
     * Falls back to plain chat() for anthropic and on any error.
     */
    async chatWithTools(req: AIRequestPayload, tools: ToolDefinition[]): Promise<ToolChatResult> {
        try {
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
                    tools: [{ function_declarations: functionDeclarations }],
                    tool_config: { function_calling_config: { mode: 'AUTO' } }
                };
                if (systemMsg) {
                    body.system_instruction = { parts: [{ text: typeof systemMsg.content === 'string' ? systemMsg.content : '' }] };
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

    // -------------------------------------------------------------------------
    // FEATURE IMPLEMENTATIONS (Refactored to use contract)
    // -------------------------------------------------------------------------

    async generate(prompt: string, currentText: string, key: string, modelName: string, mode: string = 'ai', refText: string = '', contextData: ContextData = {}, aiProvider: string = '', azureEndpoint: string = '', systemContext: string = '', powerAutomateUrl: string = ''): Promise<string> {
        if ((!key || key.length < 10) && aiProvider !== 'copilot') { await new Promise(r => setTimeout(r, 600)); const wc = currentText ? currentText.trim().split(/\s+/).filter(Boolean).length : 0; return currentText && wc > 5 ? currentText + " [Enhanced]" : currentText && wc > 0 ? currentText + " [Spell-checked]" : "AI Suggested Text"; }

        const fieldLabel = prompt || "text";
        const lowerLabel = fieldLabel.toLowerCase();
        let corePrompt = "";

        const wordCount = currentText ? currentText.trim().split(/\s+/).filter(Boolean).length : 0;

        // --- CURRENT CONTROLS SPECIALIST ---
        // Checklist-evidence only: without a loaded PM checklist in File/Hybrid mode
        // there is nothing to extract — leave the field untouched, no AI call.
        if (lowerLabel.includes("current controls")) {
            const checklistContent = (contextData.checklistText as string) ?? '';
            if (!((mode === 'file' || mode === 'hybrid') && checklistContent.trim())) return currentText || '';
            const existingNote = currentText?.trim() ? `Current field text to revise against the checklist:\n"""${currentText}"""\n` : '';
            const controlsPrompt = `PM CHECKLIST KNOWLEDGE (the plant's EXISTING PM program, organized by team and interval):\n"""\n${checklistContent.slice(0, 6000)}\n"""\n\nContext: System "${contextData.project || 'Unknown'}", Subsystem "${contextData.subsystem || 'Unknown'}".\n${existingNote}Task: List ONLY the existing PM tasks from the checklist above that act as current controls (detection or prevention) relevant to this subsystem. Use the checklist section name as the team owner.\nRules:\n- Do NOT invent tasks that are not in the checklist.\n- Do NOT pull from any other source.\n- If nothing in the checklist applies, return an empty response.\nFormat: "1- Task (Team)" one per line. Return ONLY the list, no headers or explanations.`;
            return this.chat({
                feature: 'field-generation',
                provider: (aiProvider || inferProvider(key)) as any,
                azureEndpoint: azureEndpoint || undefined,
                powerAutomateUrl: powerAutomateUrl || undefined,
                model: modelName,
                messages: [{ role: 'user', content: controlsPrompt + (systemContext ? '\n\n' + systemContext : '') }],
                mode: 'ai',
                apiKey: key,
                responseFormat: 'text'
            });
        }
        // --- END CURRENT CONTROLS SPECIALIST ---

        if (currentText && wordCount > 0 && wordCount <= 5) {
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
            const formatRule = `Format: "1- Action description [Tag: TAGNO (Hi: X unit, Hi-Hi: Y unit) if applicable] (Owner)"\nWrite each action on its own line. Return ONLY the numbered list, no headers or explanations.`;
            const existingNote = currentText?.trim() ? `Existing mitigations to enhance and expand:\n"""${currentText}"""\n` : '';
            const controlsCovered = (contextData.currentControls as string)?.trim()
                ? `CURRENT CONTROLS already in place (these failure aspects are COVERED — do NOT recommend them again; recommend only actions that close the remaining gaps):\n"""\n${(contextData.currentControls as string).trim()}\n"""\n` : '';
            let mitigationPrompt: string;
            if (mode === 'file' || mode === 'hybrid') {
                const refSection = refText?.trim() ? `REFERENCE DATA (P&IDs, datasheets, safeguarding instruments with tag numbers and alarm limits):\n"""\n${refText.slice(0, 7000)}\n"""\n\n` : '';
                const checkSection = checklistContent?.trim() ? `PM CHECKLIST KNOWLEDGE (organized by team and PM interval):\n"""\n${checklistContent.slice(0, 6000)}\n"""\n\n` : '';
                mitigationPrompt = `${refSection}${checkSection}Context: System "${contextData.project || 'Unknown'}", Subsystem "${contextData.subsystem || 'Unknown'}".\n${detectionNote}\n${controlsCovered}${existingNote}\nGenerate ${count} mitigation actions using this priority:\n1. Extract relevant PM tasks from CHECKLIST KNOWLEDGE that are NOT already listed in current controls — use the checklist section name as the team owner.\n2. From REFERENCE DATA, identify safeguarding instruments (tags like VXIT, PT, TT, LE, FIT, etc.) with their alarm limits; suggest utilizing or installing them for detection improvement.\n3. Add reliability-knowledge mitigations to further reduce Detection if D > 6.\nNever duplicate an action already covered by current controls.\n${ownerRules}\n${formatRule}`;
            } else {
                mitigationPrompt = `Context: System "${contextData.project || 'Unknown'}", Subsystem "${contextData.subsystem || 'Unknown'}".\n${detectionNote}\n${controlsCovered}${existingNote}\nGenerate ${count} maintenance mitigation actions for this failure. Never duplicate an action already covered by current controls.\n${ownerRules}\n${formatRule}`;
            }
            const mitigationContent = mitigationPrompt + (systemContext ? '\n\n' + systemContext : '');
            return this.chat({
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
        }
        // --- END MITIGATION SPECIALIST ---

        if (currentText && wordCount > 5) {
            if (lowerLabel.includes("function")) {
                corePrompt = `Context: System "${contextData.project || 'Unknown'}", Subsystem "${contextData.subsystem}", Specs "${contextData.specs || 'N/A'}".
                The user wrote this Function Description: """${currentText}"""
                Task: Rewrite and enhance it as a proper Function Description.
                Requirements:
                1. Start directly with the verb/action (e.g., "Pumps", "Delivers", "Regulates").
                2. NO introductory phrases like "The function is" or "Description:".
                3. State what the subsystem does within the System.
                4. Include key operating values from Specs if available.
                5. Clearly state normal expectations (e.g., continuous operation, no abnormal vibration, leakage, or temperature).
                6. Preserve the user's core meaning and any specific values they provided.
                Output strictly the description text only.`;
            } else if (lowerLabel.includes("spec")) {
                corePrompt = `Context: System "${contextData.project || 'Unknown'}", Subsystem "${contextData.subsystem}".
                The user wrote these specifications: """${currentText}"""
                Task: Rewrite and enhance them in the correct format.
                Format: Comma-separated list of "Key: Value Unit".
                Example: Power: 400 W, Voltage: 415 V, Speed: 3590 RPM, Material: SS316, Protection: IP55.
                Requirements: Preserve all values the user provided. Keep it technical and concise. Do not include the word "Specs:" at the start.
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
            if (lowerLabel.includes("function")) {
                corePrompt = `Context: System "${contextData.project || 'Unknown'}", Subsystem "${contextData.subsystem}", Specs "${contextData.specs || 'N/A'}".
                Task: Write a Function Description for this subsystem.
                Requirements:
                1. Start directly with the verb/action (e.g., "Pumps", "Delivers", "Regulates").
                2. NO introductory phrases like "The function is" or "Description:".
                3. State what the subsystem does within the System.
                4. Include key operating values from Specs (e.g., flow, pressure, RPM) if available.
                5. Clearly state normal expectations (e.g., continuous operation, no abnormal vibration, leakage, or temperature).
                Output strictly the description text only.`;
            } else if (lowerLabel.includes("spec")) {
                corePrompt = `Context: System "${contextData.project || 'Unknown'}", Subsystem "${contextData.subsystem}".
                Task: Generate technical specifications.
                Format: Comma-separated list of "Key: Value Unit".
                Example: Power: 400 W, Voltage: 415 V, Speed: 3590 RPM, Material: SS316, Protection: IP55.
                Requirements: Keep it technical and concise. Do not include the word "Specs:" at the start.`;
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

        const content = corePrompt + (systemContext ? '\n\n' + systemContext : '');

        return this.chat({
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
    },

    async generateMasterStructure(sysName: string, sysDesc: string, key: string, modelName: string, mode: string, refText: string, aiProvider: string = '', azureEndpoint: string = '', systemContext: string = '', powerAutomateUrl: string = ''): Promise<any> {
        if((!key || key.length < 10) && aiProvider !== 'copilot') { await new Promise(r => setTimeout(r, 2000)); return []; }
        // Skeletons only — function, failures and modes are generated by the
        // dedicated downstream steps in masterGen; anything more here is discarded.
        const corePrompt = `Act as Senior Reliability Engineer. Analyze System "${sysName}" (${sysDesc}).
        Identify the critical Subsystems for a formal FMECA. Scale the count to the system's complexity and criticality (simple package: 3-4, complex train: up to 8).
        For each subsystem, generate 'specs' using format "Key: Value Unit, Key: Value Unit" with realistic values for this class of equipment.
        Output strictly valid JSON object:
        { "subsystems": [ {
            "name": "string (Subsystem Name)",
            "specs": "string (Key: Value Unit, ...)"
        } ] }`;

        const content = corePrompt + (systemContext ? '\n\n' + systemContext : '');

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

    async generateCompleteSubsystem(name: string, specs: string, funcDesc: string, projectContext: string, key: string, modelName: string, mode: string = 'ai', refText: string = '', aiProvider: string = '', azureEndpoint: string = '', systemContext: string = '', checklistText: string = '', powerAutomateUrl: string = '', existingFailures: string[] = []): Promise<any> {
        // eslint-disable-next-line
        const generateId = () => Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
        if((!key || key.length < 10) && aiProvider !== 'copilot') { await new Promise(r => setTimeout(r, 1500)); return { failures: [{ desc: `Failure to perform`, modes: [{ id: generateId(), mode: "Fatigue", effect: "Local: Loss of integrity; End: Reduced system availability", cause: "Aging", currentControls: "", mitigation: "1- Scheduled inspection (Mechanical team)", rpn: {s:5,o:5,d:5} }] }] }; }
        const checklistBlock = (checklistText?.trim() && (mode === 'file' || mode === 'hybrid'))
            ? `PM CHECKLIST KNOWLEDGE (use section names as team owners for mitigation tasks):\n"""\n${checklistText.slice(0, 6000)}\n"""\n\n` : '';
        const existingBlock = existingFailures.length > 0
            ? `Existing Functional Failures already defined for this subsystem (DO NOT repeat or closely resemble):\n${existingFailures.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n\n` : '';
        const mitigationInstruction = `\nMitigation format — return as a numbered string per mode:\n"1- Action [Tag: TAGNO (Hi: X, Hi-Hi: Y) if applicable] (Owner)\\n2- ..."\nOwner rules: sensor/transmitter/tag → (Instrument team) | lubrication/mechanical → (Mechanical team) | PLC/interlock/control → (Automation team) | rounds/monitoring → (Operation team)\nUse checklist knowledge for PM tasks and reference data for instrument tags and limits.`;
        const corePrompt = `${checklistBlock}${existingBlock}Context: System "${projectContext}", Subsystem "${name}". Specs: "${specs}". Function Provided: "${funcDesc}".
        Task:
        1. If "Function Provided" is empty, generate it first: Action + Specs + Normal Expectations.
        2. Derive distinct Functional Failures strictly from the Function (negation of each stated expectation). Scale the count to the subsystem's complexity and criticality (simple component: 2, critical complex subsystem: up to 5). Cover total loss, partial loss, intermittent operation and over-function where the function supports them.
        3. For each failure, generate Failure Modes, Effects, Causes, Current Controls and Mitigations. Failure modes must be unique across the whole subsystem — never repeat a mode under two failures.
        Field rules:
        - "effect": format "Local: <effect at this subsystem>; End: <effect at system level>".
        ${((mode === 'file' || mode === 'hybrid') && checklistText?.trim())
            ? '- "currentControls": ONLY existing PM tasks evidenced in the PM CHECKLIST KNOWLEDGE above. Do NOT pull controls from reference data and do NOT assume typical industry practice — empty string if the checklist has no relevant task.'
            : '- "currentControls": always return an empty string "" — current controls require PM checklist evidence, which is not available.'}
        - "mitigation": RECOMMENDED actions (not yet implemented) that close the gaps NOT covered by currentControls — never duplicate a task already listed in currentControls.
        - "rpn": integers per the rating anchors below. Score "d" against currentControls only — recommended mitigations do NOT count.
        ${RPN_ANCHORS}
        ${LIBRARY_EXAMPLES}
        Return JSON object: { "failures": [ { "desc": "string (Functional Failure)", "modes": [ { "mode": "string", "effect": "string", "cause": "string", "currentControls": "string", "mitigation": "string", "rpn": {"s": <int 1-10>, "o": <int 1-10>, "d": <int 1-10>} } ] } ] }${mitigationInstruction}`;

        const content = corePrompt + (systemContext ? '\n\n' + systemContext : '');

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
            // currentControls requires PM checklist evidence — forced empty otherwise,
            // no matter what the model returned.
            if (!((mode === 'file' || mode === 'hybrid') && checklistText?.trim())) {
                (parsed?.failures || []).forEach((f: any) => (f.modes || []).forEach((m: any) => { m.currentControls = ''; }));
            }
            return parsed;
        } catch(e) { console.warn('[generateCompleteSubsystem] failed:', e); return null; }
    },

    async generateModesForFailure(failDesc: string, subName: string, subSpecs: string, subFunc: string, project: string, key: string, modelName: string, mode: string = 'ai', refText: string = '', aiProvider: string = '', azureEndpoint: string = '', systemContext: string = '', checklistText: string = '', powerAutomateUrl: string = '', existingModes: string[] = []): Promise<any[]> {
        // eslint-disable-next-line
        const generateId = () => Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
        if ((!key || key.length < 10) && aiProvider !== 'copilot') { await new Promise(r => setTimeout(r, 1000)); return [{ id: generateId(), mode: "Simulated", effect: "Local: Effect; End: System effect", cause: "Cause", currentControls: "", mitigation: "1- Scheduled inspection (Mechanical team)", rpn: {s:6,o:4,d:3} }]; }
        const checklistBlock = (checklistText?.trim() && (mode === 'file' || mode === 'hybrid'))
            ? `PM CHECKLIST KNOWLEDGE (use section names as team owners for mitigation tasks):\n"""\n${checklistText.slice(0, 6000)}\n"""\n\n` : '';
        const existingBlock = existingModes.length > 0
            ? `Failure Modes already defined in this subsystem (DO NOT repeat or closely resemble any of them):\n${existingModes.map((m, i) => `${i + 1}. ${m}`).join('\n')}\n\n` : '';
        // Retry with backoff — bulk generation can hit provider rate limits.
        const MODE_ATTEMPTS = 3;
        const mitigationInstruction = `\nMitigation format — return as a numbered string per mode:\n"1- Action [Tag: TAGNO (Hi: X, Hi-Hi: Y) if applicable] (Owner)\\n2- ..."\nOwner rules: sensor/transmitter/tag → (Instrument team) | lubrication/mechanical → (Mechanical team) | PLC/interlock/control → (Automation team) | rounds/monitoring → (Operation team)\nUse checklist knowledge for PM tasks and reference data for instrument tags and limits.`;
        const corePrompt = `${checklistBlock}${existingBlock}Context: System "${project}", Subsystem "${subName}", Specs "${subSpecs}". Function: "${subFunc}". Functional Failure: "${failDesc}".
        Task: Generate 2-3 specific Failure Modes that result in this Functional Failure. Fewer is acceptable if the failure only has one or two credible modes — do not invent filler modes.
        Field rules per mode:
        - "effect": format "Local: <effect at this subsystem>; End: <effect at system level>".
        - "cause": the dominant root cause of this mode.
        ${((mode === 'file' || mode === 'hybrid') && checklistText?.trim())
            ? '- "currentControls": ONLY existing PM tasks evidenced in the PM CHECKLIST KNOWLEDGE above. Do NOT pull controls from reference data and do NOT assume typical industry practice — empty string if the checklist has no relevant task.'
            : '- "currentControls": always return an empty string "" — current controls require PM checklist evidence, which is not available.'}
        - "mitigation": RECOMMENDED actions (not yet implemented) that close the gaps NOT covered by currentControls — never duplicate a task already listed in currentControls.
        - "rpn": integers per the rating anchors below. Score "d" against currentControls only — recommended mitigations do NOT count.
        ${RPN_ANCHORS}
        ${LIBRARY_EXAMPLES}
        Return JSON object: { "modes": [ { "mode": "string", "effect": "string", "cause": "string", "currentControls": "string", "mitigation": "string", "rpn": {"s": <int 1-10>, "o": <int 1-10>, "d": <int 1-10>} } ] }${mitigationInstruction}`;

        const content = corePrompt + (systemContext ? '\n\n' + systemContext : '');

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
                const modes = parsed.modes || [];
                // currentControls requires PM checklist evidence — forced empty otherwise.
                if (!((mode === 'file' || mode === 'hybrid') && checklistText?.trim())) modes.forEach((m: any) => { m.currentControls = ''; });
                return modes;
            } catch(e) {
                lastErr = e;
                if (attempt < MODE_ATTEMPTS) await new Promise(r => setTimeout(r, 3000 * attempt));
            }
        }
        console.warn('[generateModesForFailure] failed after retries:', lastErr);
        return [];
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
    powerAutomateUrl?: string;
  }
): Promise<{ s: number; o: number; d: number; reason?: string }> {
  const {
    project, subName, subSpecs, subFunc, failDesc,
    mode, effect, cause, currentControls = '', mitigation,
    key, modelName, modeSource = 'ai', refText = '',
    aiProvider = '', azureEndpoint = '', systemContext = '', powerAutomateUrl = ''
  } = args;

  if ((!key || key.length < 10) && aiProvider !== 'copilot') {
    // Safe offline fallback (keeps app usable)
    await new Promise(r => setTimeout(r, 600));
    return { s: 5, o: 5, d: 5, reason: "Simulated scoring (no API key)." };
  }

  const corePrompt = `
Act strictly as a Senior Reliability Engineer performing formal FMECA.
You must behave conservatively, consistently, and logically.
Your task is to assign Severity (S), Occurrence (O), and Detection (D) ratings on a 1–10 scale
based ONLY on the provided information and standard industrial reliability practice.

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
- RECOMMENDED Actions (proposed, NOT yet implemented): "${mitigation}"

${RPN_ANCHORS}

Mandatory Scoring Logic (DO NOT VIOLATE):

Severity (S):
- Rate the consequence of the EFFECT only, not the cause. If the effect states both a local and an end (system-level) effect, rate the END effect.
- Safety, environmental harm, and total production loss dominate Severity.
- If the effect is local, reversible, or causes minor performance degradation, Severity MUST be LOW.
- If the effect description is vague or mild, do NOT assume worst-case.
- High Severity (8–10) is allowed ONLY if the effect clearly implies safety risk, regulatory breach, or major system outage.

Occurrence (O):
- Estimate likelihood using typical industrial experience for the stated FAILURE MODE and CAUSE.
- Do NOT assume rare failures are frequent.
- Wear, fouling, leakage, misalignment → moderate occurrence unless stated otherwise.
- Random catastrophic failures should have LOW occurrence unless explicitly frequent.
- If no frequency indicators exist, choose a MID-RANGE value (4–6), not extremes.

Detection (D):
- Score D against the CURRENT Controls ONLY. RECOMMENDED Actions are not yet implemented and MUST NOT improve D.
- Better current detection → LOWER D value.
- Poor, reactive, or absent current controls → HIGHER D value (8-10).
- If current controls include condition monitoring, alarms, trips, inspections, or diagnostics, D decreases accordingly.
- Never assign low Detection unless detection capability is explicitly stated in CURRENT Controls.

Consistency Rules:
- Mild effects must NEVER result in high Severity.
- When genuinely uncertain between two adjacent bands, choose the HIGHER-RISK band (higher S or D) — but never jump bands beyond what the stated information supports.
- Avoid clustering all values at 5 unless justified.

Output Requirements:
- Return strictly valid JSON only.
- Values must be integers from 1 to 10.
- Include a short, professional justification referencing effect severity, failure likelihood, and detection strength.

Output format:
{
  "s": <1–10>,
  "o": <1–10>,
  "d": <1–10>,
  "reason": "Brief justification (1–3 sentences)."
}
`.trim();

  const rpnContent = corePrompt + (systemContext ? '\n\n' + systemContext : '');

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

  const parsed = this.extractJSON(res);

  // Normalize and clamp
  const clamp = (n: any) => Math.min(10, Math.max(1, Math.round(Number(n) || 5)));

  return {
    s: clamp(parsed.s),
    o: clamp(parsed.o),
    d: clamp(parsed.d),
    reason: typeof parsed.reason === 'string' ? parsed.reason : ''
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

        const lastUserMessage = [...req.messages].reverse().find(m => m.role === 'user');
        const rawPrompt = typeof lastUserMessage?.content === 'string'
            ? lastUserMessage.content
            : '';

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
                const msgs = req.feature === 'chatbot'
                    ? req.messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: typeof m.content === 'string' ? m.content : '' }))
                    : [{ role: 'user', content: fullPrompt + (req.responseFormat === 'json' ? ' Return JSON object only.' : '') }];
                const body: any = { model: (req.model && req.model.trim()) || 'claude-sonnet-4-20250514', max_tokens: 4096, messages: msgs };
                if (req.feature === 'chatbot') body.system = "You are a helpful RCM consultant.";
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
                    const contents = req.messages.map(m => ({
                        role: m.role === 'assistant' ? 'model' : 'user',
                        parts: [{ text: typeof m.content === 'string' ? m.content : '' }]
                    }));
                    // Gemini REST API expects 'contents' array
                    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${(req.model && req.model.trim()) || "gemini-1.5-flash"}:generateContent?key=${req.apiKey}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ contents, systemInstruction: { parts: [{ text: "You are a helpful RCM consultant." }] } }) // Basic system instruction support
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
        const standardNote = breakdownStandard ? ` (standard: "${breakdownStandard}")` : '';
        const prompt = `Context: System "${systemName}", Subsystem "${subsystemName}".
Subsystem Function: "${funcDesc}"
Specific functional aspect to address: "${breakdownSnippet}"${standardNote}

${existingBlock}Task: Generate ONE Functional Failure that specifically addresses the loss or degradation of this functional aspect.
Express it naturally as a reliability engineer would — a negation or reduction of that specific aspect.
Return ONLY the Functional Failure statement — one concise line, no prefix, no explanation.`;

        const content = prompt + (systemContext ? '\n\n' + systemContext : '');
        try {
            return await this.chat({
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
            });
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
        systemContext: string = ''
    ): Promise<Array<{ function: string; standard: string; snippet: string }>> {
        if (!funcDesc?.trim()) return [];
        if ((!key || key.length < 10) && aiProvider !== 'copilot') return [];

        const contextLine = (subsystemName || projectName)
            ? `Subsystem: "${subsystemName}"${projectName ? ` within System: "${projectName}"` : ''}\n\n`
            : '';

        const prompt = `You are a reliability engineer decomposing a subsystem Function description into a structured set of [function, standard, snippet] rows. Be deterministic — given the same input, always produce the same rows.

${contextLine}Function description:
"""
${funcDesc}
"""

DECOMPOSITION RULES:
1. function = verb + object (e.g. "delivers cooling water", "rotates shaft", "contains fluid")
2. standard = one SINGLE specific operating value or qualitative condition (e.g. "400 GPM at 100 PSI", "no abnormal vibration", "no leakage", "no excessive temperature")
3. snippet = the verbatim slice from the original description this row came from (15–80 chars)
4. SPLIT COMPOUND CONDITIONS: if the source text says "without vibration, leakage, or excessive temperature" — create THREE separate rows, one per condition:
   • { function: "operates without fault", standard: "no abnormal vibration", snippet: "without abnormal vibration" }
   • { function: "operates without fault", standard: "no leakage", snippet: "leakage" }
   • { function: "operates without fault", standard: "no excessive temperature", snippet: "excessive temperature" }
5. NO DUPLICATES: every [function, standard] pair must be unique. If you would repeat a pair, merge or skip.
6. Each row must represent exactly ONE condition — never combine "no vibration AND no leakage" into a single standard.

Return ONLY this JSON, no prose, no markdown:
{ "rows": [ { "function": "...", "standard": "...", "snippet": "..." } ] }`;

        const content = prompt + (systemContext ? '\n\n' + systemContext : '');
        try {
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
            const parsed = this.extractJSON(res);
            if (!parsed || !Array.isArray(parsed.rows)) return [];
            return parsed.rows
                .map((r: any) => ({
                    function: String(r?.function ?? '').trim(),
                    standard: String(r?.standard ?? '').trim(),
                    snippet: String(r?.snippet ?? '').trim(),
                }))
                .filter((r: any) => r.function);
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
