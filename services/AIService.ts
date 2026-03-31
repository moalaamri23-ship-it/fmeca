import { ContextData } from '../types';

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
    provider: 'openai' | 'gemini' | 'anthropic' | 'azure' | 'openrouter';
    azureEndpoint?: string;
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

    attachContext(prompt: string, mode: string, refText: string): string {
        if (!refText || !refText.trim()) return prompt;
        const refBlock = `REFERENCE DATA:\n"""\n${refText.slice(0, 15000)}\n"""\n`;
        if (mode === 'file') return `${refBlock}Use ONLY Reference Data. If not found, say "N/A".\nTASK: ${prompt}`;
        if (mode === 'hybrid') return `${refBlock}Use Reference Data as primary. Supplement with general knowledge.\nTASK: ${prompt}`;
        return prompt;
    },

    extractJSON(text: string): any {
        try { return JSON.parse(text); } catch (e) {
            const start = text.indexOf('{'); const end = text.lastIndexOf('}');
            if (start !== -1 && end !== -1) return JSON.parse(text.substring(start, end + 1));
            throw new Error("No JSON");
        }
    },

    // -------------------------------------------------------------------------
    // FEATURE IMPLEMENTATIONS (Refactored to use contract)
    // -------------------------------------------------------------------------

    async generate(prompt: string, currentText: string, key: string, modelName: string, mode: string = 'ai', refText: string = '', contextData: ContextData = {}, aiProvider: string = '', azureEndpoint: string = '', systemContext: string = ''): Promise<string> {
        if (!key || key.length < 10) { await new Promise(r => setTimeout(r, 600)); const wc = currentText ? currentText.trim().split(/\s+/).filter(Boolean).length : 0; return currentText && wc > 5 ? currentText + " [Enhanced]" : currentText && wc > 0 ? currentText + " [Spell-checked]" : "AI Suggested Text"; }

        const fieldLabel = prompt || "text";
        const lowerLabel = fieldLabel.toLowerCase();
        let corePrompt = "";

        const wordCount = currentText ? currentText.trim().split(/\s+/).filter(Boolean).length : 0;

        if (currentText && wordCount > 0 && wordCount <= 5) {
            corePrompt = `Fix only the grammar and spelling of the following text. Return only the corrected text with no explanations or changes to meaning. Original: """${currentText}"""`;
        } else if (currentText && wordCount > 5) {
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
            provider: (aiProvider || (key.startsWith('sk-') ? 'openai' : 'gemini')) as any,
            azureEndpoint: azureEndpoint || undefined,
            model: modelName,
            messages: [{ role: 'user', content: content }],
            mode: mode as 'ai'|'file'|'hybrid',
            refText,
            contextData,
            apiKey: key,
            responseFormat: 'text'
        });
    },

    async generateMasterStructure(sysName: string, sysDesc: string, key: string, modelName: string, mode: string, refText: string, aiProvider: string = '', azureEndpoint: string = '', systemContext: string = ''): Promise<any> {
        if(!key || key.length < 10) { await new Promise(r => setTimeout(r, 2000)); return []; }
        const corePrompt = `Act as Senior Reliability Engineer. Analyze System "${sysName}" (${sysDesc}).
        Break into 3-6 critical Subsystems.
        Step 1: For each subsystem, generate 'specs' first using format "Key: Value Unit, Key: Value Unit".
        Step 2: Generate 'func' (Function) using: Action + Specs Values + Normal Expectations (continuous op, no noise/leaks).
        Step 3: Generate multiple (2-4) distinct 'failures' (Functional Failures) that represent different ways the function can fail (e.g., total loss, partial loss, intermittent operation, over-function).
        Step 4: For EACH failure, generate 1-2 Failure Modes, Effects, Causes, and Mitigations (Hierarchy: Func -> Multiple Failures -> Mode -> Effect -> Cause -> Mitigation).
        Output strictly valid JSON object:
        { "subsystems": [ {
            "name": "string (Subsystem Name)",
            "specs": "string (Key: Value Unit, ...)",
            "func": "string (Action + Specs + Normal Expectations)",
            "failures": [ {
                "desc": "string (Functional Failure 1)",
                "modes": [ { "mode": "string", "effect": "string", "cause": "string", "mitigation": "string", "rpn": {"s": 5, "o": 5, "d": 5} } ]
            },
            {
                "desc": "string (Functional Failure 2)",
                "modes": [ ... ]
            } ]
        } ] }`;

        const content = corePrompt + (systemContext ? '\n\n' + systemContext : '');

        try {
            const res = await this.chat({
                feature: 'master-structure',
                provider: (aiProvider || (key.startsWith('sk-') ? 'openai' : 'gemini')) as any,
                azureEndpoint: azureEndpoint || undefined,
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

    async generateCompleteSubsystem(name: string, specs: string, funcDesc: string, projectContext: string, key: string, modelName: string, mode: string = 'ai', refText: string = '', aiProvider: string = '', azureEndpoint: string = '', systemContext: string = ''): Promise<any> {
        // eslint-disable-next-line
        const generateId = () => Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
        if(!key || key.length < 10) { await new Promise(r => setTimeout(r, 1500)); return { failures: [{ desc: `Failure to perform`, modes: [{ id: generateId(), mode: "Fatigue", effect: "Loss of integrity", cause: "Aging", mitigation: "Inspection", rpn: {s:5,o:5,d:5} }] }] }; }
        const corePrompt = `Context: System "${projectContext}", Subsystem "${name}". Specs: "${specs}". Function Provided: "${funcDesc}".
        Task:
        1. If "Function Provided" is empty, generate it first: Action + Specs + Normal Expectations.
        2. Derive multiple (2-4) distinct Functional Failures strictly from the Function (negation of expectations).
        3. For each failure, generate Failure Modes, Effects, Causes, and Mitigations.
        Return JSON object: { "failures": [ { "desc": "string (Functional Failure)", "modes": [ { "mode": "string", "effect": "string", "cause": "string", "mitigation": "string", "rpn": {"s": 5, "o": 5, "d": 5} } ] } ] }`;

        const content = corePrompt + (systemContext ? '\n\n' + systemContext : '');

        try {
            const res = await this.chat({
                feature: 'subsystem-generation',
                provider: (aiProvider || (key.startsWith('sk-') ? 'openai' : 'gemini')) as any,
                azureEndpoint: azureEndpoint || undefined,
                model: modelName,
                messages: [{ role: 'user', content: content }],
                mode: mode as 'ai'|'file'|'hybrid',
                refText,
                apiKey: key,
                responseFormat: 'json'
            });
            return this.extractJSON(res);
        } catch(e) { return null; }
    },

    async generateModesForFailure(failDesc: string, subName: string, subSpecs: string, subFunc: string, project: string, key: string, modelName: string, mode: string = 'ai', refText: string = '', aiProvider: string = '', azureEndpoint: string = '', systemContext: string = ''): Promise<any[]> {
        // eslint-disable-next-line
        const generateId = () => Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
        if (!key || key.length < 10) { await new Promise(r => setTimeout(r, 1000)); return [{ id: generateId(), mode: "Simulated", effect: "Effect", cause: "Cause", mitigation: "Task", rpn: {s:6,o:4,d:3} }]; }
        const corePrompt = `Context: System "${project}", Subsystem "${subName}", Specs "${subSpecs}". Function: "${subFunc}". Functional Failure: "${failDesc}".
        Task: Generate 2-3 specific Failure Modes that result in this Functional Failure.
        For each mode, determine Effect, Root Cause, and Mitigation Task.
        Return JSON object: { "modes": [ { "mode": "string", "effect": "string", "cause": "string", "mitigation": "string", "rpn": {"s": 5, "o": 5, "d": 5} } ] }`;

        const content = corePrompt + (systemContext ? '\n\n' + systemContext : '');

        try {
            const res = await this.chat({
                feature: 'mode-generation',
                provider: (aiProvider || (key.startsWith('sk-') ? 'openai' : 'gemini')) as any,
                azureEndpoint: azureEndpoint || undefined,
                model: modelName,
                messages: [{ role: 'user', content: content }],
                mode: mode as 'ai'|'file'|'hybrid',
                refText,
                apiKey: key,
                responseFormat: 'json'
            });
            const parsed = this.extractJSON(res);
            return parsed.modes || [];
        } catch(e) { return []; }
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
    mitigation: string;
    key: string;
    modelName: string;
    modeSource?: 'ai' | 'file' | 'hybrid';
    refText?: string;
    aiProvider?: string;
    azureEndpoint?: string;
    systemContext?: string;
  }
): Promise<{ s: number; o: number; d: number; reason?: string }> {
  const {
    project, subName, subSpecs, subFunc, failDesc,
    mode, effect, cause, mitigation,
    key, modelName, modeSource = 'ai', refText = '',
    aiProvider = '', azureEndpoint = '', systemContext = ''
  } = args;

  if (!key || key.length < 10) {
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
- Existing Mitigation / Controls: "${mitigation}"

Mandatory Scoring Logic (DO NOT VIOLATE):

Severity (S):
- Rate the consequence of the EFFECT only, not the cause.
- Safety, environmental harm, and total production loss dominate Severity.
- If the effect is local, reversible, or causes minor performance degradation, Severity MUST be LOW.
- If the effect description is vague or mild, do NOT assume worst-case.
- High Severity (8–10) is allowed ONLY if the effect clearly implies safety risk, regulatory breach, or major system outage.

Occurrence (O):
- Estimate likelihood using typical industrial experience for the stated FAILURE MODE and CAUSE.
- Do NOT assume rare failures are frequent.
- Wear, fouling, leakage, misalignment → moderate occurrence unless stated otherwise.
- Random catastrophic failures should have LOW occurrence unless explicitly frequent.
- If no frequency indicators exist, choose a conservative MID-RANGE value (4–6), not extremes.

Detection (D):
- Detection reflects how likely the CURRENT CONTROLS can detect or prevent the failure BEFORE impact.
- Better detection → LOWER D value.
- Poor or reactive controls → HIGHER D value.
- If mitigation includes condition monitoring, alarms, trips, inspections, or diagnostics,
  Detection MUST IMPROVE (D decreases).
- If mitigation is vague, generic, or absent, Detection MUST be HIGH.
- Never assign low Detection unless detection capability is explicitly stated.

Consistency Rules:
- Improved mitigation must NEVER increase Detection rating.
- Mild effects must NEVER result in high Severity.
- Conservative scoring is preferred over aggressive scoring.
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
    provider: (aiProvider || (key.startsWith('sk-') ? 'openai' : 'gemini')) as any,
    azureEndpoint: azureEndpoint || undefined,
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

    async _directChat(req: AIRequestPayload): Promise<string> {
        // DIRECT mode: Use direct calls to OpenAI/Gemini
        // Apply context attachment locally as backend is not involved
        const rawContent = typeof req.messages[0].content === 'string' ? req.messages[0].content : ""; 
        const fullPrompt = this.attachContext(rawContent, req.mode, req.refText || '');
        
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
    }
};
