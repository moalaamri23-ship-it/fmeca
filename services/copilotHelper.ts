import type { AIMessage, ToolCall, ToolDefinition } from './AIService';

/**
 * Copilot (Power Automate) tool-calling emulation.
 *
 * The Power Automate flow is a text-only transport: no structured `tool_calls`,
 * no streaming, just `{ sessionId, prompt, responseFormat }` in and a plain
 * string out. To give Copilot the SAME tool-calling capability as OpenAI /
 * OpenRouter / Gemini, tool calling is emulated over text:
 *
 *   1. buildCopilotPrompt() flattens the messages and appends a TOOL PROTOCOL
 *      block that teaches the model to reply with ONE fenced ```tool JSON block.
 *   2. parseCopilotReply() converts that fence back into the same ToolCall shape
 *      the native providers produce, so chatWithTools() / the chatbot pipeline
 *      run unchanged.
 *
 * Ported from FileLM (src/lib/ai/copilot-helper.ts), adapted to FMECA Studio's
 * AIMessage / ToolDefinition / ToolCall types.
 */

// Each tool result is truncated to this many chars before being re-sent.
export const COPILOT_TOOL_RESULT_CHAR_CAP = 16000;
// Whole serialized prompt cap; the largest orientation block is trimmed to fit.
// FileLM measured the production flow (HTTP trigger → Copilot Studio agent)
// carrying ~900k chars end-to-end. Re-measure before raising or after changing
// the flow.
export const COPILOT_PROMPT_CHAR_CAP = 900000;

const BLOCK_SEPARATOR = '\n\n---\n\n';

// Orientation/context blocks that are safe to trim first when over the prompt
// cap — they can be re-fetched via tools, unlike the live question or a tool
// result mid-loop.
const TRIMMABLE_MARKERS = ['PROJECT INDEX', 'PROJECT OUTLINE', 'RETRIEVED DATA'];
const TRIMMED_BLOCK_FLOOR = 30000;

// Stable per app session so the flow can correlate the requests of one
// conversation (and so emulated tool round-trips share one Copilot Studio
// session instead of polluting separate ones).
let sessionId: string | null = null;
export function getCopilotSessionId(): string {
    if (!sessionId) sessionId = crypto.randomUUID();
    return sessionId;
}

function contentToText(content: AIMessage['content']): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .map(part => {
            if (part.type === 'text') return part.text ?? '';
            if (part.type === 'image_url') return `[Image: ${part.image_url?.url ?? ''}]`;
            return '';
        })
        .filter(Boolean)
        .join('\n');
}

function truncateToolResult(content: string): string {
    if (content.length <= COPILOT_TOOL_RESULT_CHAR_CAP) return content;
    return `${content.slice(0, COPILOT_TOOL_RESULT_CHAR_CAP)}\n…[truncated]`;
}

function renderMessage(message: AIMessage): string | null {
    const role = (message.role || '').toLowerCase();

    // Tool results are fed back as messages tagged role:'tool'. AIMessage does
    // not declare name/tool_call_id, so read them defensively.
    if (role === 'tool') {
        const meta = message as AIMessage & { name?: string; tool_call_id?: string };
        const content = contentToText(message.content).trim();
        const header = `TOOL RESULT #${meta.tool_call_id ?? '?'} (${meta.name ?? 'unknown'}):`;
        return `${header}\n${truncateToolResult(content)}`;
    }

    const content = contentToText(message.content).trim();
    if (!content) return null;
    return `${role.toUpperCase()}:\n${content}`;
}

interface ParamSchema {
    type?: string;
    description?: string;
    enum?: unknown[];
}

function describeParameters(parameters: ToolDefinition['parameters']): string {
    const schema = parameters as {
        properties?: Record<string, ParamSchema>;
        required?: string[];
    };
    const props = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    const lines = Object.entries(props).map(([name, def]) => {
        const type = Array.isArray(def.enum) ? `one of: ${def.enum.join(' | ')}` : (def.type ?? 'any');
        const req = required.has(name) ? 'required' : 'optional';
        const desc = def.description ? ` — ${def.description}` : '';
        return `    ${name} (${type}, ${req})${desc}`;
    });
    return lines.length > 0 ? lines.join('\n') : '    (no arguments)';
}

function buildToolProtocol(tools: ToolDefinition[]): string {
    const catalog = tools
        .map(t => `• ${t.name} — ${t.description}\n${describeParameters(t.parameters)}`)
        .join('\n');

    return [
        'TOOL PROTOCOL',
        'You can call tools to fetch exact FMECA project data. Available tools:',
        '',
        catalog,
        '',
        'To call a tool, reply with ONLY one or more of these fenced blocks and NOTHING else:',
        '```tool',
        '{"name": "<tool name>", "arguments": { <arguments as JSON> }}',
        '```',
        'Rules:',
        '- You MAY emit several ```tool fences in one reply to fetch independent data in parallel (e.g. failure modes for two subsystems). Use one fence per tool call.',
        '- Only batch calls that are INDEPENDENT. If one call needs another call\'s result first, emit just that first call, read its TOOL RESULT, then call the next.',
        '- No text before, between, or after the fences when calling tools — fences only.',
        '- Each fence body must be valid JSON with a "name" string and an "arguments" object.',
        '- Tool results come back in the next message as "TOOL RESULT #<id>". Read them, then either call more tools or answer.',
        '- When you have the data needed, reply with plain text and NO ```tool fence.',
        '- Ground every answer in the tool results / project data — never invent subsystems, failure modes, or RPN values.',
    ].join('\n');
}

/**
 * Flattens the conversation into a single prompt string for the Power Automate
 * flow. When `tools` are supplied, appends the TOOL PROTOCOL so the model can
 * emit a ```tool fence. Trims orientation blocks if the prompt exceeds the cap.
 */
export function buildCopilotPrompt(messages: AIMessage[], tools?: ToolDefinition[]): string {
    const blocks = messages
        .map(renderMessage)
        .filter((b): b is string => b !== null);

    if (tools && tools.length > 0) {
        blocks.push(buildToolProtocol(tools));
    }

    const totalLength = () =>
        blocks.reduce((sum, b) => sum + b.length, 0) + BLOCK_SEPARATOR.length * Math.max(0, blocks.length - 1);

    // Over the cap: trim the largest trimmable orientation block first. Tool
    // results and the live question are the exact facts being assembled — losing
    // one corrupts the answer, while trimming the orientation index only degrades
    // grounding the tools can re-fetch. Keep a floor so some context survives.
    if (totalLength() > COPILOT_PROMPT_CHAR_CAP) {
        const isTrimmable = (b: string) => TRIMMABLE_MARKERS.some(m => b.includes(m));
        // Trim largest-first until under cap or nothing left to trim.
        let guard = 0;
        while (totalLength() > COPILOT_PROMPT_CHAR_CAP && guard++ < blocks.length) {
            let idx = -1;
            let max = TRIMMED_BLOCK_FLOOR;
            for (let i = 0; i < blocks.length; i++) {
                if (isTrimmable(blocks[i]) && blocks[i].length > max) { max = blocks[i].length; idx = i; }
            }
            if (idx === -1) break;
            const excess = totalLength() - COPILOT_PROMPT_CHAR_CAP;
            const target = Math.max(TRIMMED_BLOCK_FLOOR, blocks[idx].length - excess);
            blocks[idx] = blocks[idx].slice(0, target) +
                '\n…[context trimmed to fit the prompt cap — use the tools for anything beyond this point]';
        }
    }

    return blocks.join(BLOCK_SEPARATOR);
}

export interface CopilotParseResult {
    content: string;
    calls: ToolCall[];
    malformedToolFence?: boolean;
}

/**
 * Parses a raw Copilot reply. Each ```tool fence becomes a ToolCall (matching
 * the native providers' shape) — multiple fences in one reply are all collected,
 * so Copilot can request independent calls in parallel like OpenAI/Gemini.
 * Anything without a tool fence is returned as plain text.
 *
 * malformedToolFence is set only when a ```tool fence has invalid JSON AND no
 * other valid tool call was found — so the caller can attempt one repair
 * round-trip. If some fences parsed, the bad one is skipped (best effort).
 */
export function parseCopilotReply(raw: string): CopilotParseResult {
    const fenceRe = /```[ \t]*([A-Za-z]*)[ \t]*\r?\n([\s\S]*?)```/g;
    const calls: ToolCall[] = [];
    let sawMalformedToolFence = false;
    let seq = 0;

    for (const match of raw.matchAll(fenceRe)) {
        const lang = match[1].toLowerCase();
        const isToolFence = lang === 'tool';
        // Untagged/json fences are only treated as tool calls when their body has
        // the exact call shape — a legit ```json fence in a final answer passes through.
        if (!isToolFence && lang !== 'json' && lang !== '') continue;

        let parsed: unknown;
        try {
            parsed = JSON.parse(match[2].trim());
        } catch {
            if (isToolFence) sawMalformedToolFence = true;
            continue;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            if (isToolFence) sawMalformedToolFence = true;
            continue;
        }
        const call = parsed as { name?: unknown; arguments?: unknown };
        if (typeof call.name !== 'string' || !call.name) {
            if (isToolFence) sawMalformedToolFence = true;
            continue;
        }
        if (!isToolFence && (call.arguments === undefined || typeof call.arguments !== 'object')) continue;

        const args = (call.arguments && typeof call.arguments === 'object')
            ? call.arguments as Record<string, any>
            : {};
        // Unique id per call in the batch — Date.now() alone collides when several
        // fences parse within the same millisecond.
        calls.push({ id: `copilot_${Date.now()}_${seq++}`, name: call.name, args });
    }

    if (calls.length > 0) {
        // Discard any narration around the fences — the flow returns no real
        // reasoning, so surfacing it only clutters the UI.
        return { content: '', calls };
    }

    return { content: raw.trim(), calls: [], malformedToolFence: sawMalformedToolFence };
}
