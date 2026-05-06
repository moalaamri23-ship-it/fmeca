import { ContextData, FailureCategory, BreakdownRow } from '../types';
export type { FailureCategory } from '../types';

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

const FAILURE_CATEGORIES: FailureCategory[] = [
    'Total Failure',
    'Partial/Degraded Failure',
    'Erratic Failure',
    'Secondary/Conditional Failure',
];

// Phase 5 — Mitigation count scales with the mode's RPN total (S × O × D, range 1-1000).
// Higher RPN warrants layered defenses; low RPN doesn't need busywork.
export const mitigationCountForRpn = (rpn: number): string => {
    if (rpn >= 200) return '4-6';
    if (rpn >= 100) return '3-4';
    if (rpn >= 50)  return '2-3';
    return '1-2';
};

const normalizeCategory = (raw: any): FailureCategory => {
    const s = String(raw ?? '').toLowerCase();
    if (s.includes('partial') || s.includes('degrad')) return 'Partial/Degraded Failure';
    if (s.includes('erratic') || s.includes('fluctuat')) return 'Erratic Failure';
    if (s.includes('secondary') || s.includes('conditional') || s.includes('qualitative')) return 'Secondary/Conditional Failure';
    return 'Total Failure';
};

export interface CoverageAnalysis {
    decomposition: Array<{
        function: string;
        standard: string;
        category: FailureCategory;
        matched_failure_index: number | null; // 1-based
        covered: boolean;
    }>;
    missing_pairs: Array<{
        function: string;
        standard: string;
        category: FailureCategory;
        suggested_failure: string;
    }>;
    is_exhausted: boolean;
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

    async generate(prompt: string, currentText: string, key: string, modelName: string, mode: string = 'ai', refText: string = '', contextData: ContextData = {}, aiProvider: string = '', azureEndpoint: string = '', systemContext: string = '', powerAutomateUrl: string = ''): Promise<string> {
        if ((!key || key.length < 10) && aiProvider !== 'copilot') { await new Promise(r => setTimeout(r, 600)); const wc = currentText ? currentText.trim().split(/\s+/).filter(Boolean).length : 0; return currentText && wc > 5 ? currentText + " [Enhanced]" : currentText && wc > 0 ? currentText + " [Spell-checked]" : "AI Suggested Text"; }

        const fieldLabel = prompt || "text";
        const lowerLabel = fieldLabel.toLowerCase();
        let corePrompt = "";

        const wordCount = currentText ? currentText.trim().split(/\s+/).filter(Boolean).length : 0;

        if (currentText && wordCount > 0 && wordCount <= 5) {
            return this.chat({
                feature: 'field-generation',
                provider: (aiProvider || (key.startsWith('sk-') ? 'openai' : 'gemini')) as any,
                azureEndpoint: azureEndpoint || undefined,
                powerAutomateUrl: powerAutomateUrl || undefined,
                model: modelName,
                messages: [{ role: 'user', content: `Fix only the grammar and spelling of the following text. Return only the corrected text with no explanations or changes to meaning. Original: """${currentText}"""` }],
                mode: 'ai',
                apiKey: key,
                responseFormat: 'text'
            });
        }

        // --- FUNCTIONAL FAILURE SPECIALIST ---
        if (lowerLabel.includes("functional failure")) {
            const func = (contextData.funcDescription as string) ?? '';
            const existing = (contextData.existingFailures as string[]) ?? [];
            const breakdownRowsCtx = ((contextData as any)?.breakdownRows as BreakdownRow[] | undefined) ?? [];
            const filledIds = new Set<string>(((contextData as any)?.filledBreakdownIds as string[] | undefined) ?? []);
            const existingBlock = existing.length > 0
                ? `Existing Functional Failures already defined (DO NOT repeat or closely resemble any of these):\n${existing.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n\n`
                : '';
            const funcBlock = func?.trim() ? `Subsystem Function: "${func}"\n` : '';
            let ffPrompt: string;
            if (currentText && wordCount > 5) {
                ffPrompt = `Context: System "${contextData.project || 'Unknown'}", Subsystem "${contextData.subsystem || 'Unknown'}".
${funcBlock}${existingBlock}The user has typed this Functional Failure: "${currentText}"
Task: Rewrite and improve this as a proper Functional Failure statement.
Requirements:
1. Express as a negation or loss of function (e.g., "Fails to deliver...", "Unable to maintain...", "Delivers less than required...", "Runs at higher than rated...").
2. Describe the failure of the function — NOT a physical failure mode or root cause.
3. Return ONLY the Functional Failure statement — one concise line, no prefix, no explanation.`;
            } else {
                // Phase 1: deterministic exhaustion via persisted breakdown rows (no AI call here).
                if (breakdownRowsCtx.length > 0) {
                    const firstUnfilled = breakdownRowsCtx.find(r => !filledIds.has(r.id));
                    if (!firstUnfilled) return ''; // exhausted: every row already linked
                    return firstUnfilled.canonical_failure || '';
                }
                // Backward compat: subsystemExhausted flag (legacy, still respected).
                if ((contextData as any)?.subsystemExhausted === true) return '';
                // Fallback (no breakdown stored — e.g. imported project on its very first wand click)
                ffPrompt = `Context: System "${contextData.project || 'Unknown'}", Subsystem "${contextData.subsystem || 'Unknown'}".
${funcBlock}${existingBlock}Task: Generate ONE new Functional Failure that addresses a functional aspect of the above function NOT yet covered by any existing failure.
Express it as a negation or loss of function (e.g., "Fails to deliver...", "Unable to maintain...", "Delivers less than required...", "Runs at higher than rated...").
Return ONLY the Functional Failure statement — one concise line, no prefix, no explanation.`;
            }
            return this.chat({
                feature: 'field-generation',
                provider: (aiProvider || (key.startsWith('sk-') ? 'openai' : 'gemini')) as any,
                azureEndpoint: azureEndpoint || undefined,
                powerAutomateUrl: powerAutomateUrl || undefined,
                model: modelName,
                messages: [{ role: 'user', content: ffPrompt + (systemContext ? '\n\n' + systemContext : '') }],
                mode: mode as 'ai' | 'file' | 'hybrid',
                refText,
                contextData,
                apiKey: key,
                responseFormat: 'text'
            });
        }
        // --- END FUNCTIONAL FAILURE SPECIALIST ---

        // --- FAILURE MODE SPECIALIST ---
        if (lowerLabel.includes("failure mode")) {
            const failDesc = (contextData.failureDesc as string) ?? '';
            const existing = (contextData.existingModes as string[]) ?? [];
            const sysModes = (contextData.systemModes as Array<{ mode: string; count: number }> | undefined) ?? [];

            // Phase 4 — wand on a blank FM cell prefers historical System Modes when relevance is
            // strong. Returns the verbatim mode name (no AI call). App.tsx's updateMode auto-links
            // the systemModeId/count and overwrites O on next render.
            if (!currentText && sysModes.length > 0) {
                const haystack = `${failDesc} ${(contextData.subsystem as string) || ''}`.toLowerCase();
                const existingNorm = new Set(existing.map(e => e.toLowerCase().trim()));
                const scored = sysModes
                    .filter(m => !existingNorm.has(m.mode.toLowerCase().trim())) // skip already-used
                    .map(m => {
                        const words = m.mode.toLowerCase().split(/\s+/).filter(w => w.length > 3);
                        const overlap = words.filter(w => haystack.includes(w)).length;
                        return { mode: m, overlap };
                    })
                    .sort((a, b) => b.overlap - a.overlap || b.mode.count - a.mode.count);
                if (scored.length > 0 && scored[0].overlap > 0) {
                    return scored[0].mode.mode;
                }
            }

            const existingBlock = existing.length > 0
                ? `Existing Failure Modes already defined (DO NOT repeat or closely resemble):\n${existing.map((m, i) => `${i + 1}. ${m}`).join('\n')}\n\n`
                : '';
            const sysModesBlock = (!currentText && sysModes.length > 0)
                ? `Historical Failure Modes (operational data — prefer matching one of these if it fits):\n${sysModes.slice(0, 8).map((m, i) => `${i + 1}. ${m.mode} — ${m.count} occurrences`).join('\n')}\n\n`
                : '';
            const failBlock = failDesc?.trim() ? `Functional Failure: "${failDesc}"\n` : '';
            let fmPrompt: string;
            if (currentText && wordCount > 5) {
                fmPrompt = `Context: System "${contextData.project || 'Unknown'}", Subsystem "${contextData.subsystem || 'Unknown'}".
${failBlock}${existingBlock}The user has typed this Failure Mode: "${currentText}"
Task: Rewrite and improve this as a proper Failure Mode.
Requirements:
1. Describe the physical way the failure occurs (e.g., "Bearing wear", "Seal leakage", "Impeller erosion").
2. Be specific — describe the physical failure mechanism, NOT the effect or cause.
3. Return ONLY the Failure Mode — one concise phrase, no prefix, no explanation.`;
            } else {
                fmPrompt = `Context: System "${contextData.project || 'Unknown'}", Subsystem "${contextData.subsystem || 'Unknown'}".
${failBlock}${existingBlock}${sysModesBlock}Task: Generate ONE new Failure Mode for this Functional Failure.
Requirements:
1. Describe the physical way the failure occurs (e.g., "Bearing wear", "Seal leakage", "Impeller erosion", "Shaft misalignment").
2. Be specific and different from any existing modes listed above.
3. Return ONLY the Failure Mode — one concise phrase, no prefix, no explanation.`;
            }
            return this.chat({
                feature: 'field-generation',
                provider: (aiProvider || (key.startsWith('sk-') ? 'openai' : 'gemini')) as any,
                azureEndpoint: azureEndpoint || undefined,
                powerAutomateUrl: powerAutomateUrl || undefined,
                model: modelName,
                messages: [{ role: 'user', content: fmPrompt + (systemContext ? '\n\n' + systemContext : '') }],
                mode: mode as 'ai' | 'file' | 'hybrid',
                refText,
                contextData,
                apiKey: key,
                responseFormat: 'text'
            });
        }
        // --- END FAILURE MODE SPECIALIST ---

        // --- MITIGATION SPECIALIST ---
        if (lowerLabel.includes("mitigation")) {
            const d = (contextData.detectionScore as number) ?? 5;
            const checklistContent = (contextData.checklistText as string) ?? '';
            // Phase 5 — count scales with the FULL RPN total (S × O × D), not just D.
            // Falls back to a D-derived estimate when only D is available (legacy callers).
            const rpnTotal = (contextData.rpnTotal as number) ?? (d * 25);
            const count = mitigationCountForRpn(rpnTotal);
            const detectionNote = d >= 7
                ? `Detection score is HIGH (D=${d}/10). Prioritize adding monitoring instruments and detection barriers to reduce this score.`
                : d <= 3
                ? `Detection is already good (D=${d}/10). Focus on preventive maintenance actions.`
                : `Detection score is moderate (D=${d}/10). Balance preventive tasks with detection controls.`;
            const ownerRules = `Owner assignment (add team in parentheses after each action):\n- Sensor, transmitter, switch, monitor, level/pressure/vibration/flow tag → (Instrument team)\n- Lubrication, alignment, bearing, seal, coupling, mechanical inspection → (Mechanical team)\n- Control system, PLC, SCADA, interlock, delay, communication → (Automation team)\n- Operational round, manual monitoring, log, operator check → (Operation team)`;
            const formatRule = `Format: "1- Action description [Tag: TAGNO (Hi: X unit, Hi-Hi: Y unit) if applicable] (Owner)"\nWrite each action on its own line. Return ONLY the numbered list, no headers or explanations.`;
            const existingNote = currentText?.trim() ? `Existing mitigations to enhance and expand:\n"""${currentText}"""\n` : '';
            let mitigationPrompt: string;
            if (mode === 'file' || mode === 'hybrid') {
                const refSection = refText?.trim() ? `REFERENCE DATA (P&IDs, datasheets, safeguarding instruments with tag numbers and alarm limits):\n"""\n${refText.slice(0, 7000)}\n"""\n\n` : '';
                const checkSection = checklistContent?.trim() ? `PM CHECKLIST KNOWLEDGE (organized by team and PM interval):\n"""\n${checklistContent.slice(0, 6000)}\n"""\n\n` : '';
                mitigationPrompt = `${refSection}${checkSection}Context: System "${contextData.project || 'Unknown'}", Subsystem "${contextData.subsystem || 'Unknown'}".\n${detectionNote}\n${existingNote}\nGenerate ${count} mitigation actions using this priority:\n1. Extract relevant PM tasks from CHECKLIST KNOWLEDGE — use the checklist section name as the team owner.\n2. From REFERENCE DATA, identify safeguarding instruments (tags like VXIT, PT, TT, LE, FIT, etc.) with their alarm limits; suggest utilizing or installing them for detection improvement.\n3. Add reliability-knowledge mitigations to further reduce Detection if D > 6.\n${ownerRules}\n${formatRule}`;
            } else {
                mitigationPrompt = `Context: System "${contextData.project || 'Unknown'}", Subsystem "${contextData.subsystem || 'Unknown'}".\n${detectionNote}\n${existingNote}\nGenerate ${count} maintenance mitigation actions for this failure.\n${ownerRules}\n${formatRule}`;
            }
            const mitigationContent = mitigationPrompt + (systemContext ? '\n\n' + systemContext : '');
            return this.chat({
                feature: 'field-generation',
                provider: (aiProvider || (key.startsWith('sk-') ? 'openai' : 'gemini')) as any,
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
            provider: (aiProvider || (key.startsWith('sk-') ? 'openai' : 'gemini')) as any,
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

    /**
     * Phase 3 — slim front-end of masterGen. Returns ONLY [{name, specs, brief}] per subsystem
     * so each subsystem can then run its own isolated pipeline (function → decompose → bounded
     * generation). Lessens cross-subsystem hallucination compared to the legacy
     * generateMasterStructure that asks for the full FF/FM hierarchy in one giant call.
     */
    async generateSubsystemSkeleton(
        sysName: string, sysDesc: string,
        key: string, modelName: string,
        mode: string = 'ai', refText: string = '',
        aiProvider: string = '', azureEndpoint: string = '',
        systemContext: string = '', powerAutomateUrl: string = ''
    ): Promise<Array<{ name: string; specs: string; brief: string }>> {
        if ((!key || key.length < 10) && aiProvider !== 'copilot') {
            await new Promise(r => setTimeout(r, 1500));
            return [];
        }
        const corePrompt = `Act as a Senior Reliability Engineer. Analyze System "${sysName}" (${sysDesc || 'no description provided'}).

Task: Break the system into 3-6 critical SUBSYSTEMS. For each subsystem produce:
  • name  — short subsystem name (e.g. "Drive Motor", "Cooling System").
  • specs — comma-separated technical specs in the format "Key: Value Unit" (e.g. "Power: 110 kW, Speed: 2960 rpm").
  • brief — one sentence stating the subsystem's role in the system (used downstream to build the full Function description).

Do NOT generate Functions, Functional Failures, Failure Modes, or Mitigations here — those are produced in later steps to keep this call focused.

Return strictly valid JSON:
{ "subsystems": [ { "name": "string", "specs": "string (Key: Value Unit, ...)", "brief": "string (one sentence)" } ] }`;

        const content = corePrompt + (systemContext ? '\n\n' + systemContext : '');

        try {
            const res = await this.chat({
                feature: 'subsystem-skeleton',
                provider: (aiProvider || (key.startsWith('sk-') ? 'openai' : 'gemini')) as any,
                azureEndpoint: azureEndpoint || undefined,
                powerAutomateUrl: powerAutomateUrl || undefined,
                model: modelName,
                messages: [{ role: 'user', content }],
                mode: mode as 'ai' | 'file' | 'hybrid',
                refText,
                apiKey: key,
                responseFormat: 'json'
            });
            const parsed = this.extractJSON(res);
            if (!parsed?.subsystems || !Array.isArray(parsed.subsystems)) return [];
            return parsed.subsystems
                .map((s: any) => ({
                    name: String(s?.name ?? '').trim(),
                    specs: String(s?.specs ?? '').trim(),
                    brief: String(s?.brief ?? '').trim(),
                }))
                .filter((s: any) => s.name);
        } catch {
            return [];
        }
    },

    async generateCompleteSubsystem(name: string, specs: string, funcDesc: string, projectContext: string, key: string, modelName: string, mode: string = 'ai', refText: string = '', aiProvider: string = '', azureEndpoint: string = '', systemContext: string = '', checklistText: string = '', powerAutomateUrl: string = '', existingFailures: string[] = [], breakdownRows: BreakdownRow[] = [], relevantSystemModes: Array<{ mode: string; count: number }> = []): Promise<any> {
        // eslint-disable-next-line
        const generateId = () => Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
        if((!key || key.length < 10) && aiProvider !== 'copilot') { await new Promise(r => setTimeout(r, 1500)); return { failures: [{ desc: `Failure to perform`, modes: [{ id: generateId(), mode: "Fatigue", effect: "Loss of integrity", cause: "Aging", mitigation: "1- Scheduled inspection (Mechanical team)", rpn: {s:5,o:5,d:5} }] }] }; }
        const checklistBlock = (checklistText?.trim() && (mode === 'file' || mode === 'hybrid'))
            ? `PM CHECKLIST KNOWLEDGE (use section names as team owners for mitigation tasks):\n"""\n${checklistText.slice(0, 6000)}\n"""\n\n` : '';
        const existingBlock = existingFailures.length > 0
            ? `\nExisting Functional Failures already defined (DO NOT repeat or closely resemble — generate only NEW ones not yet covered):\n${existingFailures.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n`
            : '';
        const mitigationInstruction = `\nMitigation format — return as a numbered string per mode:\n"1- Action [Tag: TAGNO (Hi: X, Hi-Hi: Y) if applicable] (Owner)\\n2- ..."\nOwner rules: sensor/transmitter/tag → (Instrument team) | lubrication/mechanical → (Mechanical team) | PLC/interlock/control → (Automation team) | rounds/monitoring → (Operation team)\nUse checklist knowledge for PM tasks and reference data for instrument tags and limits.\n\nMitigation COUNT (per mode) scales with that mode's RPN total = S × O × D:\n  • RPN ≥ 200 → 4-6 actions\n  • RPN 100-199 → 3-4 actions\n  • RPN 50-99 → 2-3 actions\n  • RPN < 50 → 1-2 actions\nCompute each mode's RPN from the S/O/D you assign, then size its mitigation list to match.`;

        // Phase 4 — historical modes block (System Modes). When the AI generates a Failure Mode
        // that semantically matches one of the listed historical modes, it MUST emit that mode's
        // name verbatim and tag the output with systemModeId so the client can attach the
        // historical count and overwrite the Occurrence (O) score deterministically.
        const slugForPrompt = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        const systemModesBlock = relevantSystemModes.length > 0
            ? `\nHISTORICAL FAILURE MODES (operational data — match these FIRST before inventing new modes):\n${relevantSystemModes.map((m, i) => `${i + 1}. "${m.mode}" — ${m.count} occurrences (systemModeId: "${slugForPrompt(m.mode)}")`).join('\n')}\n\nMATCHING RULE: For each Failure Mode you generate, FIRST check whether one of the listed historical modes describes the SAME physical failure mechanism (same component, same failure type). If yes, use the listed mode name VERBATIM as the "mode" field AND set "systemModeId" to its slug shown above. Only invent a new mode (with no systemModeId) when no listed mode applies. Do NOT force a match — leave systemModeId omitted when there is no genuine semantic overlap.\n`
            : '';

        const bounded = breakdownRows.length > 0;

        const breakdownBlock = bounded
            ? `\nBOUNDED GENERATION — produce failures for ONLY the following [function, standard, category] breakdown rows. Each row has a stable breakdownId you MUST echo back so we can link the generated FF to the right row. Do not invent additional failures beyond this list. Produce EXACTLY ONE Functional Failure per row, in the SAME ORDER as listed:\n${breakdownRows.map((r, i) => `${i + 1}. breakdownId: "${r.id}" | function: "${r.function}" | standard: "${r.standard}" | category: "${r.category}" | canonical_failure: "${r.canonical_failure}"`).join('\n')}\n\nFor each row, set the output failure's:\n  • desc                       = the canonical_failure text (you may lightly polish wording but stay faithful to the category).\n  • sourcePair.breakdownId     = the row's breakdownId verbatim.\n  • sourcePair.function        = the row's function.\n  • sourcePair.standard        = the row's standard.\n  • sourcePair.category        = the row's category.\n  • modes                      = 2 to 3 distinct Failure Modes per failure (DO NOT return only one).\n`
            : '';

        const taskBlock = bounded
            ? `Task:
        1. For EACH numbered row above, output one Functional Failure entry as specified.
        2. Each failure MUST include 2-3 Failure Modes (mode/effect/cause/mitigation/rpn) — never fewer than 2.
        3. Do NOT generate any failures outside the listed rows.`
            : `Task:
        1. If "Function Provided" is empty, generate it first: Action + Specs + Normal Expectations.
        2. Derive 1-2 NEW Functional Failures from the Function (negation of expectations) that are NOT already covered by any existing failure above.
        3. For each new failure, generate 2-3 Failure Modes, Effects, Causes, and Mitigations.`;

        const modeFields = relevantSystemModes.length > 0
            ? `{ "mode": "string", "systemModeId": "<slug from list above, OR omit if no match>", "effect": "string", "cause": "string", "mitigation": "string", "rpn": {"s": 5, "o": 5, "d": 5} }`
            : `{ "mode": "string", "effect": "string", "cause": "string", "mitigation": "string", "rpn": {"s": 5, "o": 5, "d": 5} }`;

        const schemaBlock = bounded
            ? `Return JSON object: { "failures": [ { "desc": "string", "sourcePair": { "breakdownId": "string", "function": "string", "standard": "string", "category": "Total Failure" | "Partial/Degraded Failure" | "Erratic Failure" | "Secondary/Conditional Failure" }, "modes": [ ${modeFields}, ... at least 2 entries ] } ] }`
            : `Return JSON object: { "failures": [ { "desc": "string (Functional Failure)", "modes": [ ${modeFields}, ... at least 2 entries ] } ] }`;

        const corePrompt = `${checklistBlock}${systemModesBlock}Context: System "${projectContext}", Subsystem "${name}". Specs: "${specs}". Function Provided: "${funcDesc}".${existingBlock}${breakdownBlock}
        ${taskBlock}
        ${schemaBlock}${mitigationInstruction}`;

        const content = corePrompt + (systemContext ? '\n\n' + systemContext : '');

        try {
            const res = await this.chat({
                feature: 'subsystem-generation',
                provider: (aiProvider || (key.startsWith('sk-') ? 'openai' : 'gemini')) as any,
                azureEndpoint: azureEndpoint || undefined,
                powerAutomateUrl: powerAutomateUrl || undefined,
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

    async generateModesForFailure(failDesc: string, subName: string, subSpecs: string, subFunc: string, project: string, key: string, modelName: string, mode: string = 'ai', refText: string = '', aiProvider: string = '', azureEndpoint: string = '', systemContext: string = '', checklistText: string = '', powerAutomateUrl: string = ''): Promise<any[]> {
        // eslint-disable-next-line
        const generateId = () => Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
        if ((!key || key.length < 10) && aiProvider !== 'copilot') { await new Promise(r => setTimeout(r, 1000)); return [{ id: generateId(), mode: "Simulated", effect: "Effect", cause: "Cause", mitigation: "1- Scheduled inspection (Mechanical team)", rpn: {s:6,o:4,d:3} }]; }
        const checklistBlock = (checklistText?.trim() && (mode === 'file' || mode === 'hybrid'))
            ? `PM CHECKLIST KNOWLEDGE (use section names as team owners for mitigation tasks):\n"""\n${checklistText.slice(0, 6000)}\n"""\n\n` : '';
        const mitigationInstruction = `\nMitigation format — return as a numbered string per mode:\n"1- Action [Tag: TAGNO (Hi: X, Hi-Hi: Y) if applicable] (Owner)\\n2- ..."\nOwner rules: sensor/transmitter/tag → (Instrument team) | lubrication/mechanical → (Mechanical team) | PLC/interlock/control → (Automation team) | rounds/monitoring → (Operation team)\nUse checklist knowledge for PM tasks and reference data for instrument tags and limits.\n\nMitigation COUNT (per mode) scales with that mode's RPN total = S × O × D:\n  • RPN ≥ 200 → 4-6 actions\n  • RPN 100-199 → 3-4 actions\n  • RPN 50-99 → 2-3 actions\n  • RPN < 50 → 1-2 actions\nCompute each mode's RPN from the S/O/D you assign, then size its mitigation list to match.`;
        const corePrompt = `${checklistBlock}Context: System "${project}", Subsystem "${subName}", Specs "${subSpecs}". Function: "${subFunc}". Functional Failure: "${failDesc}".
        Task: Generate 2-3 specific Failure Modes that result in this Functional Failure.
        For each mode, determine Effect, Root Cause, and Mitigation Task.
        Return JSON object: { "modes": [ { "mode": "string", "effect": "string", "cause": "string", "mitigation": "string", "rpn": {"s": 5, "o": 5, "d": 5} } ] }${mitigationInstruction}`;

        const content = corePrompt + (systemContext ? '\n\n' + systemContext : '');

        try {
            const res = await this.chat({
                feature: 'mode-generation',
                provider: (aiProvider || (key.startsWith('sk-') ? 'openai' : 'gemini')) as any,
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
            return parsed.modes || [];
        } catch(e) { return []; }
    },

    async analyzeFunctionCoverage(funcDesc: string, existingFailures: string[], key: string, modelName: string, aiProvider: string = '', azureEndpoint: string = '', powerAutomateUrl: string = ''): Promise<CoverageAnalysis> {
        const SAFE_DEFAULT: CoverageAnalysis = { decomposition: [], missing_pairs: [], is_exhausted: false };

        if (!funcDesc?.trim()) return SAFE_DEFAULT;
        if ((!key || key.length < 10) && aiProvider !== 'copilot') return SAFE_DEFAULT;

        const existingBlock = existingFailures.length > 0
            ? existingFailures.map((f, i) => `${i + 1}. ${f}`).join('\n')
            : '(none yet)';

        const prompt = `You are a reliability engineer doing a strict mapping-and-exhaustion analysis using a fixed 4-category failure taxonomy. Be exhaustive and deterministic — given the same Function description and same Existing Failures, you must always produce the same decomposition.

Subsystem Function description:
"""
${funcDesc}
"""

Existing Functional Failures (numbered, 1-based):
${existingBlock}

STEP 1 — DECOMPOSE the Function description into [function, standard] pairs.
  • function  = verb + object (e.g. "delivers cooling water", "maintains discharge pressure", "rotates shaft", "contains fluid").
  • standard  = the operating value or qualitative expectation (e.g. "400 GPM at 100 PSI", "continuous 24/7", "no abnormal vibration", "no external leakage").
  • Every distinct standard mentioned in the description (numerical, temporal, qualitative, "no X") gets its OWN row.
  • If the description is bare (e.g. just "Provides rotational energy"), the function still has implicit standards — at minimum produce rows for the four taxonomy categories below where applicable.

STEP 2 — APPLY THE 4-CATEGORY TAXONOMY. For each [function, standard] pair, expand into one row per APPLICABLE category. Most pairs apply to 2-4 categories — never zero.

  Categories (use these strings VERBATIM in the "category" field):
  1. "Total Failure"               — completely stops doing the function (e.g. "Fails to deliver any flow", "Motor fails to rotate").
  2. "Partial/Degraded Failure"    — does the function but falls short of a NUMERICAL target (e.g. "Delivers less than 400 GPM", "Output below rated speed"). Only applies when the standard has a numerical value.
  3. "Erratic Failure"             — does the function but output FLUCTUATES unacceptably (e.g. "Flow oscillates", "Speed surges"). Applies to most active functions.
  4. "Secondary/Conditional Failure" — does the function but violates a QUALITATIVE side-condition (e.g. "Operates with vibration", "Operates while leaking", "Runs above rated temperature"). Applies to "no X" expectations and qualitative constraints.

  Applicability rules:
  • A numerical/rate standard ("400 GPM") → produce Total + Partial/Degraded + Erratic rows (3 rows).
  • A qualitative "no X" standard ("no leakage", "no vibration") → produce Secondary/Conditional row (1 row, the standard IS the side-condition).
  • A binary on/off function with no numerical target → produce Total + Erratic rows (2 rows).
  • Continuous-operation standards ("24/7") → produce Total (loss of operation) + Erratic (intermittent) rows.

STEP 3 — INVERT & MATCH (1-to-1, NO REUSE). For each decomposition row, find the existing failure that represents its loss/violation.
  • CRITICAL: Each existing failure number may match AT MOST ONE decomposition row. Do not let one failure cover two rows.
  • If a row has a clear 1-to-1 match → set matched_failure_index to that 1-based number and covered=true.
  • Otherwise → matched_failure_index=null, covered=false.
  • Match by semantic equivalence with the SAME category. A "partial/degraded" row is NOT covered by a "total failure" failure description, and vice versa.
    – Row: function "delivers cooling water" / standard "400 GPM" / category "Total Failure"     ↔ "Fails to deliver any cooling water"
    – Row: function "delivers cooling water" / standard "400 GPM" / category "Partial/Degraded"  ↔ "Delivers less than 400 GPM"
    – Row: function "operates" / standard "no abnormal vibration" / category "Secondary"         ↔ "Operates with excessive vibration"

STEP 4 — MISSING PAIRS. For every uncovered row, write a canonical-negation suggested_failure that matches its category:
  • Total Failure              → "Fails to <verb> <object>" or "<Verb-noun> not performed"
  • Partial/Degraded Failure   → "Delivers less than <numerical target>" or "<Output> below rated <unit>"
  • Erratic Failure            → "Erratic <output>" or "<Output> fluctuates beyond acceptable range"
  • Secondary/Conditional      → "Operates with <violation>" or "<Function> performed but <side-condition violated>"

STEP 5 — EXHAUSTION FLAG. Set is_exhausted = true ONLY if EVERY row in decomposition has covered=true.

Return ONLY this JSON, no prose, no markdown:
{
  "decomposition": [
    { "function": "<verb + object>", "standard": "<value/expectation>", "category": "<one of the 4 strings above>", "matched_failure_index": <number|null>, "covered": <true|false> }
  ],
  "missing_pairs": [
    { "function": "<verb + object>", "standard": "<value/expectation>", "category": "<one of the 4 strings above>", "suggested_failure": "<canonical negation>" }
  ],
  "is_exhausted": <true|false>
}`;

        try {
            const res = await this.chat({
                feature: 'coverage-analysis',
                provider: (aiProvider || (key.startsWith('sk-') ? 'openai' : 'gemini')) as any,
                azureEndpoint: azureEndpoint || undefined,
                powerAutomateUrl: powerAutomateUrl || undefined,
                model: modelName,
                messages: [{ role: 'user', content: prompt }],
                mode: 'ai',
                refText: '',
                apiKey: key,
                responseFormat: 'json'
            });
            const parsed = this.extractJSON(res);
            if (!parsed || !Array.isArray(parsed.decomposition)) return SAFE_DEFAULT;

            // Enforce 1-to-1 matching client-side as well — if the AI reuses an index across rows,
            // keep only the first row that claimed it; mark subsequent claims as uncovered.
            const claimed = new Set<number>();
            const decomposition = parsed.decomposition.map((d: any) => {
                let idx: number | null = typeof d?.matched_failure_index === 'number' ? d.matched_failure_index : null;
                let covered = d?.covered === true && idx !== null;
                if (idx !== null) {
                    if (claimed.has(idx)) { idx = null; covered = false; }
                    else claimed.add(idx);
                }
                return {
                    function: String(d?.function ?? ''),
                    standard: String(d?.standard ?? ''),
                    category: normalizeCategory(d?.category),
                    matched_failure_index: idx,
                    covered,
                };
            });

            // Synthesize missing_pairs from any decomposition row marked uncovered (covers AI omissions).
            const synthesizedMissing = decomposition
                .filter((d: any) => !d.covered)
                .map((d: any) => ({
                    function: d.function,
                    standard: d.standard,
                    category: d.category as FailureCategory,
                    suggested_failure: '',
                }));

            // Merge AI-supplied missing_pairs (better wording) on top of synthesized, keyed by function+standard+category.
            const aiMissing = Array.isArray(parsed.missing_pairs)
                ? parsed.missing_pairs.map((m: any) => ({
                    function: String(m?.function ?? ''),
                    standard: String(m?.standard ?? ''),
                    category: normalizeCategory(m?.category),
                    suggested_failure: String(m?.suggested_failure ?? '').trim(),
                }))
                : [];

            const keyOf = (p: { function: string; standard: string; category: FailureCategory }) =>
                `${p.function}||${p.standard}||${p.category}`;
            const wordedByKey = new Map<string, string>();
            aiMissing.forEach((m: any) => { if (m.suggested_failure) wordedByKey.set(keyOf(m), m.suggested_failure); });

            const missing_pairs = synthesizedMissing.map((p: any) => ({
                ...p,
                suggested_failure: wordedByKey.get(keyOf(p)) || `Fails to ${p.function}${p.standard ? ` (${p.standard})` : ''}`,
            }));

            const is_exhausted = decomposition.length > 0 && decomposition.every((d: any) => d.covered === true);

            return { decomposition, missing_pairs, is_exhausted };
        } catch {
            return SAFE_DEFAULT;
        }
    },

    /**
     * Phase 1 — Persistent Function Breakdown.
     * Decomposes a Function description into [function, standard, category, snippet, canonical_failure]
     * rows using the 4-category taxonomy. The result is meant to be PERSISTED on the Subsystem
     * (Subsystem.functionBreakdown) so exhaustion checks become a pure function of stored data
     * (no more AI run-to-run variance).
     *
     * On any parse / network failure → returns []. Caller treats empty as "no breakdown available;
     * do NOT change exhaustion state".
     */
    async decomposeFunction(
        funcDesc: string,
        key: string,
        modelName: string,
        aiProvider: string = '',
        azureEndpoint: string = '',
        powerAutomateUrl: string = '',
        systemContext: string = ''
    ): Promise<Omit<BreakdownRow, 'id'>[]> {
        if (!funcDesc?.trim()) return [];
        if ((!key || key.length < 10) && aiProvider !== 'copilot') return [];

        const prompt = `You are a reliability engineer decomposing a subsystem Function description into a strict, exhaustive set of [function, standard, category] rows using a fixed 4-category failure taxonomy. Be deterministic — given the same input, always produce the same rows.

Subsystem Function description:
"""
${funcDesc}
"""

STEP 1 — DECOMPOSE the description into [function, standard] pairs.
  • function = verb + object (e.g. "delivers cooling water", "rotates shaft", "contains fluid").
  • standard = the operating value or qualitative expectation (e.g. "400 GPM at 100 PSI", "continuous 24/7", "no abnormal vibration", "no external leakage").
  • Every distinct standard mentioned (numerical, temporal, qualitative, "no X") gets its OWN row.

STEP 2 — APPLY THE 4-CATEGORY TAXONOMY. For each [function, standard] pair, expand into one row per APPLICABLE category. Most pairs apply to 2-4 categories — never zero.

  Categories (use these strings VERBATIM in "category"):
  1. "Total Failure"               — completely stops doing the function.
  2. "Partial/Degraded Failure"    — does the function but falls short of a NUMERICAL target. Only applies when the standard has a numerical value.
  3. "Erratic Failure"             — does the function but output FLUCTUATES unacceptably. Applies to most active functions.
  4. "Secondary/Conditional Failure" — does the function but violates a QUALITATIVE side-condition (vibration, leakage, temperature, noise).

  Applicability rules:
  • A numerical/rate standard ("400 GPM") → produce Total + Partial/Degraded + Erratic rows (3 rows).
  • A qualitative "no X" standard ("no leakage") → produce Secondary/Conditional row (1 row, the standard IS the side-condition).
  • A binary on/off function with no numerical target → produce Total + Erratic rows (2 rows).
  • Continuous-operation standards ("24/7") → produce Total + Erratic rows.

STEP 3 — For each row, write:
  • snippet           = the verbatim slice from the original Function description that the pair came from (15-80 chars).
  • canonical_failure = the canonical-negation Functional Failure text matching the category:
      Total Failure              → "Fails to <verb> <object>" or "<Verb-noun> not performed".
      Partial/Degraded Failure   → "Delivers less than <numerical target>" or "<Output> below rated <unit>".
      Erratic Failure            → "Erratic <output>" or "<Output> fluctuates beyond acceptable range".
      Secondary/Conditional      → "Operates with <violation>" or "<Function> performed but <side-condition violated>".

Return ONLY this JSON, no prose, no markdown:
{
  "rows": [
    { "function": "<verb + object>", "standard": "<value/expectation>", "category": "<one of the 4 strings>", "snippet": "<verbatim slice from description>", "canonical_failure": "<canonical negation>" }
  ]
}`;

        const content = prompt + (systemContext ? '\n\n' + systemContext : '');

        try {
            const res = await this.chat({
                feature: 'function-decomposition',
                provider: (aiProvider || (key.startsWith('sk-') ? 'openai' : 'gemini')) as any,
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
                    category: normalizeCategory(r?.category),
                    snippet: String(r?.snippet ?? '').trim(),
                    canonical_failure: String(r?.canonical_failure ?? '').trim(),
                }))
                .filter((r: any) => r.function && r.canonical_failure);
        } catch {
            return [];
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
    mode, effect, cause, mitigation,
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

        const fullPrompt = this.attachContext(rawPrompt, req.mode, req.refText ?? '');

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
    },

    // -------------------------------------------------------------------------
    // LIVE MODEL FETCHING
    // -------------------------------------------------------------------------

    async fetchModels(provider: 'gemini' | 'openai' | 'anthropic', apiKey: string): Promise<TieredModels> {
        let all: string[] = [];

        if (provider === 'openai') {
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
    }
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
