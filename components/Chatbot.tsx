import React, { useState, useEffect, useRef } from 'react';
import { AIService, AIMessage } from '../services/AIService';
import { RAGService } from '../services/RAGService';
import { Project } from '../types';
import { Icon } from './Icon';

interface ChatbotProps {
  activeProject: Project | null;
  apiKey: string;
  modelName: string;
  responseStyle: "normal" | "concise" | "one_sentence";
  aiProvider?: string;
  azureEndpoint?: string;
  systemContext?: string;
}

function styleDirective(style: "normal" | "concise" | "one_sentence") {
  if (style === "one_sentence") {
    return `
RESPONSE STYLE (HARD RULE):
- Output EXACTLY ONE sentence.
- No line breaks, no bullets, no numbering.
- If more detail is needed, compress into one sentence using semicolons.
`.trim();
  }
  if (style === "concise") {
    return `
RESPONSE STYLE:
- Be concise and direct.
- Prefer short paragraphs or up to 5 bullets.
- Avoid long explanations unless asked.
`.trim();
  }
  return "";
}

interface Message {
    role: 'user' | 'assistant' | 'system';
    content: string;
}
// ===== System Prompts =====

const SYSTEM_RAG_ON = `
You are an FMECA project copilot. Use the provided project context as the primary source of truth.
If required details are missing from the context, say what is missing and ask for the minimum needed info.
Keep answers structured and practical for reliability engineering.
`.trim();

const SYSTEM_RAG_OFF = `
You are a senior reliability-focused subject-matter expert.
The user may ask about any field or topic.
Answer the question directly and accurately for that field.
Where relevant, apply reliability engineering thinking such as:
failure modes, degradation mechanisms, risk, safe operation,
maintainability, inspection, and lifecycle considerations.
Do not assume access to any project-specific data unless it is provided.
`.trim();

const SYSTEM_RETRIEVAL_PLANNER = `
You are a retrieval planner for an FMECA chatbot.

Return ONLY valid JSON.

Your goal: request the MINIMAL project context needed to answer correctly, while staying within a context budget.

Levels: "project_header", "subsystem", "functional_failure", "failure_mode"
Fields (examples):
- subsystem: name, func, specs
- functional_failure: desc
- failure_mode: mode, cause, effect, mitigation, rpn (S/O/D/Total)

Output JSON schema:
{
  "include": Array<{ "level": string, "fields": string[], "within"?: string }>,
  "filters": { "subsystems": string[], "terms": string[], "rpn_min": number|null, "ids": string[] },
  "strategy": { "mode": "topk"|"index_then_expand"|"full_index", "top_k": number, "expand_k": number, "sort": string[] },
  "budget": { "max_chars": number },
  "reason": string
}

Rules:
- If the user asks to "list/review/all/rank", avoid "topk" alone; use "index_then_expand" or "full_index".
- Default budget max_chars=80000.
`.trim();

function safeJsonParse(raw: string) {
  if (!raw) return null;
  const s = String(raw).trim();

  const unfenced = s
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(unfenced.slice(start, end + 1)); } catch {}
  }
  try { return JSON.parse(unfenced); } catch {}
  return null;
}


export const Chatbot: React.FC<ChatbotProps> = ({ activeProject, apiKey, modelName, responseStyle, aiProvider = '', azureEndpoint = '', systemContext = '' }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState("");
    const [loading, setLoading] = useState(false);

    const renderMiniMarkdown = (text: string) => {
    let html = text
        .replace(/^### (.*)$/gm, '<div class="font-semibold mt-2 mb-1">$1</div>') // ### Heading
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')                         // **bold**
        .replace(/\n/g, '<br/>');                                                  // line breaks
    return { __html: html };
    };
     
    const [isRagEnabled, setIsRagEnabled] = useState(true); 
    // Floating Button State: Only Y is tracked, X is fixed to the right rail
    const [yPos, setYPos] = useState(window.innerHeight - 100);
    const [isDragging, setIsDragging] = useState(false);
    const dragStart = useRef({ y: 0, startY: 0 });
    const messagesEndRef = useRef<HTMLDivElement>(null);

    // Init Logic
    useEffect(() => {
        const savedY = localStorage.getItem('rcm_chatbot_y');
        if (savedY) {
            try { setYPos(Number(savedY)); } catch(e) {}
        } else {
            setYPos(window.innerHeight - 100);
        }

        const savedMsgs = localStorage.getItem('rcm_chatbot_msgs');
        if (savedMsgs) {
            try { setMessages(JSON.parse(savedMsgs)); } catch(e) {}
        } else {
            setMessages([{ role: 'assistant', content: "Hello! I am your RCM Consultant. I can help analyze your FMECA project, suggest improvements, or identify risks. How can I assist you today?" }]);
        }
    }, []);

    useEffect(() => {
        localStorage.setItem('rcm_chatbot_msgs', JSON.stringify(messages));
        if (isOpen && messagesEndRef.current) {
            messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
        }
    }, [messages, isOpen]);

    // Vertical Drag Logic
    const handleMouseDown = (e: React.MouseEvent) => {
        if (isOpen) return;
        setIsDragging(true);
        dragStart.current = { y: e.clientY, startY: yPos };
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    };

    const handleMouseMove = (e: MouseEvent) => {
        const deltaY = e.clientY - dragStart.current.y;
        let newY = dragStart.current.startY + deltaY;
        // Constraint to screen height with padding
        newY = Math.max(20, Math.min(window.innerHeight - 80, newY));
        setYPos(newY);
    };

    const handleMouseUp = () => {
        setIsDragging(false);
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        // Persist Y
        localStorage.setItem('rcm_chatbot_y', String(yPos)); // Use current state or ref? State updates during drag, so yPos is fresh enough for LS save on up usually, or read from last setter. 
        // Better to save the value we just set. But React state is async. 
        // We can save in useEffect [yPos] with debounce, or just save here approximately.
        // Actually, let's rely on the state update cycle or save the calc value.
        // For precision, we can use a ref to track current drag Y if needed, but state is fine for this resolution.
    };
    
    // Save Y on change (debounced implicitly by drag end, but we can explicit save on unmount/change if needed, but simple save on dragEnd is efficient enough if we had the val.
    // Let's use useEffect to save yPos when it changes if we had the val.
    const currentY = useRef(yPos);
    useEffect(() => { currentY.current = yPos; }, [yPos]);
    // Update mouseUp to use ref
    useEffect(() => {
        if (!isDragging) {
            localStorage.setItem('rcm_chatbot_y', String(yPos));
        }
    }, [yPos, isDragging]);


  const clearConversation = () => {
   const initial: Message[] = [
    {
      role: 'assistant',
      content:
        "Hello! I am your RCM Consultant. I can help analyze your FMECA project, suggest improvements, or identify risks. How can I assist you today?"
    }
  ];
  setMessages(initial);
  localStorage.removeItem('rcm_chatbot_msgs');
  };


    // Chat Logic
    const handleSend = async () => {
        if (!input.trim() || !apiKey) return;
        if (isRagEnabled && !activeProject) {
    setMessages(prev => [
        ...prev,
        { role: 'user', content: input },
        { role: 'assistant', content: "RAG is enabled, but no project is open. Either open a project or turn RAG off to chat generally." }
    ]);
    setInput("");
    return;
}


        const userText = input;
        setInput("");
        setLoading(true);

        const newHistory: Message[] = [...messages, { role: 'user', content: userText }];

        setMessages(newHistory);

// --- RAG: Planner → Retrieval Plan → Retrieved Context ---
const outline = (isRagEnabled && activeProject)
  ? `System: "${activeProject.name || 'Unnamed'}"\nSubsystems (${(activeProject.subsystems||[]).length}): ${(activeProject.subsystems||[]).map(s=>s.name||'(unnamed)').slice(0,60).join(' | ')}${(activeProject.subsystems||[]).length>60?' …':''}`
  : 'System: (none)\nSubsystems: (none)';

let retrievalPlan: any = null;
let retrievedContext = "";

if (isRagEnabled && activeProject) {
  try {
    const plannerInput =
      `User question:\n${userText}\n\n` +
      `Project:\n` +
      `System Name: "${activeProject.name || "Unnamed"}"\n` +
      `Subsystems (${(activeProject.subsystems || []).length}): ` +
      `${(activeProject.subsystems || []).map(s => s.name || "(unnamed)").slice(0, 60).join(" | ")}` +
      `${(activeProject.subsystems || []).length > 60 ? " …" : ""}\n`;

    const planRaw = await AIService.chat({
      sessionId: 'chatbot-session',
      feature: 'chatbot-planner',
      provider: (aiProvider || (apiKey.startsWith('sk-') ? 'openai' : 'gemini')) as any,
      azureEndpoint: azureEndpoint || undefined,
      model: modelName,
      messages: [
        { role: 'system', content: SYSTEM_RETRIEVAL_PLANNER },
        { role: 'user', content: plannerInput }
      ],
      mode: 'ai',
      apiKey
    });

    retrievalPlan = safeJsonParse(planRaw);
  } catch {
    retrievalPlan = null;
  }

  try {
    if (retrievalPlan) {
      // Uses your schema: include/filters/strategy/budget
      retrievedContext = RAGService.buildContextByPlan(retrievalPlan, userText, activeProject);
    }
    if (!retrievedContext) {
      retrievedContext = RAGService.retrieveContext(userText, activeProject, 80);
    }
  } catch {
    retrievedContext = RAGService.retrieveContext(userText, activeProject, 80);
  }
} else if (!isRagEnabled && activeProject) {
  // RAG off: no retrieval context
  retrievedContext = "";
}



        // System Prompt Construction
const systemPromptRagOn = `You are “FMECA Copilot”, a senior Reliability / RCM consultant supporting the user in reviewing and improving the CURRENT FMECA project.

SCOPE (hard rule):
- Ground answers in the provided Project Context and Project Outline. Do NOT invent project data.
- If something is not in the project, say so, then optionally suggest "Candidate (Not in project)" items.

INTENT ROUTER (MANDATORY — do this FIRST):
Classify the user request into exactly ONE intent and respond accordingly:

A) STRUCTURE REVIEW (project-level questions)
Examples: "What do you think of the subsystems?", "Do they relate to the main system?", "Is the breakdown logical?", "Any overlaps/gaps?"
Response rules:
1) Use Project Outline first (list subsystems and counts).
2) Evaluate alignment using only project content. If details are missing, state what's missing.
3) Identify gaps/overlaps/ambiguities.
4) If you propose additions, label them exactly: "Candidate (Not in project)".
5) Ask ONE focused follow-up question.

B) LOCATE / TRACE (term- or row-specific)
Examples: "Where is 'bearing seizure'?", "Show mitigation for X", "What causes Y?"
Response rules (HIERARCHY + NAVIGATION):
- Search Project Context for the user’s term and close variants across ALL fields (Subsystem, Function, Functional Failure, Failure Mode, Effect, Cause, Mitigation/Controls, S/O/D/RPN notes).
- If found, report the path:
  "Found in project at: Subsystem → Functional Failure → Failure Mode → [Field]"
- Then answer using ONLY those located rows.
- If multiple matches, list up to 3 and ask which one they mean.
- If no match, say: "I cannot find '<term>' in the provided Project Context." Then ask where it belongs.

C) CONSISTENCY CHECK (quality review of a specific row)
Examples: "Does this effect match the mode?", "Is mitigation adequate for the cause?"
Rules:
- Locate the exact row(s).
- Critique only using what is in the project.
- Suggestions must be labeled: "Candidate (Not in project)".

D) GAP ANALYSIS (what’s missing)
Examples: "What should I add?", "What is weak or incomplete?"
Rules:
- First point out what is missing in the project fields.
- Then provide "Candidate (Not in project)" improvements.

CRITICAL RESPONSE RULE:
- Never answer with "I cannot find 'subsystems'" or similar for STRUCTURE REVIEW questions.
- "I cannot find…" is allowed ONLY for LOCATE / TRACE questions.

OUTPUT STYLE:
- Be concise and workshop-ready.
- Quote project fields when present.
- End with one targeted question.

PROJECT OUTLINE:
"""
${outline}
"""


PROJECT CONTEXT (retrieved snippets):
"""
${retrievedContext}
"""`;

const styleBlock = styleDirective(responseStyle);

const baseSystemPrompt = isRagEnabled
  ? (styleBlock ? `${systemPromptRagOn}\n\n${styleBlock}` : systemPromptRagOn)
  : (styleBlock ? `${SYSTEM_RAG_OFF}\n\n${styleBlock}` : SYSTEM_RAG_OFF);

const systemPrompt = systemContext ? `${baseSystemPrompt}\n\n${systemContext}` : baseSystemPrompt;

    const apiMessages: AIMessage[] = [
  { role: 'system', content: systemPrompt },
  ...newHistory
    .filter((m): m is { role: 'user' | 'assistant'; content: string } =>
      m.role === 'user' || m.role === 'assistant'
    )
    .slice(-12)
    .map(m => ({ role: m.role, content: m.content }))
    ];


        try {
            const response = await AIService.chat({
                sessionId: 'chatbot-session',
                feature: 'chatbot',
                provider: (aiProvider || (apiKey.startsWith('sk-') ? 'openai' : 'gemini')) as any,
                azureEndpoint: azureEndpoint || undefined,
                model: modelName,
                messages: apiMessages,
                mode: 'ai',
                contextData: { retrievedChunks: isRagEnabled ? retrievedContext : "" },
                apiKey
            });

            setMessages(prev => [...prev, { role: 'assistant', content: response }]);
        } catch (e: any) {
            setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${e.message || "Failed to connect."}` }]);
        }
        setLoading(false);
        };

    return (
        <>
            {/* Floating Button - Right Rail Snapped */}
            {!isOpen && (
                <div 
                    onMouseDown={handleMouseDown}
                    style={{ top: yPos, right: 0 }}
                    className={`fixed z-50 w-14 h-14 rounded-l-full bg-slate-900 text-white shadow-xl flex items-center justify-center cursor-pointer 
                    transition-all duration-300 ease-out border-y border-l border-white/10
                    ${isDragging ? 'cursor-grabbing opacity-100 translate-x-0' : 'cursor-grab opacity-50 hover:opacity-100 translate-x-1/2 hover:translate-x-0'}
                    `}
                    title="RCM Consultant"
                    onClick={(e) => { if(!isDragging) setIsOpen(true); }}
                >
                    <div className="mr-2"> {/* Offset icon slightly left because of half-circle shape */}
                        <Icon name="wand" className="w-6 h-6" />
                    </div>
                    {/* Badge */}
                    <div className="absolute top-2 left-2 w-2.5 h-2.5 bg-red-500 rounded-full border border-slate-900"></div>
                </div>
            )}

            {/* Chat Panel */}
            {isOpen && (
                <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:justify-end sm:px-6 pointer-events-none">
                    <div className="pointer-events-auto bg-white w-full sm:w-[400px] h-[80vh] sm:h-[600px] shadow-2xl rounded-t-xl sm:rounded-xl flex flex-col border border-slate-200 overflow-hidden animate-enter">
                        {/* Header */}
                        <div className="bg-slate-900 text-white p-4 flex justify-between items-center shrink-0">
                            <div className="flex items-center gap-2">
                                <div className="p-1.5 bg-brand-600 rounded-lg"><Icon name="wand" className="w-4 h-4"/></div>
                                <div>
                                    <h3 className="font-bold text-sm">RCM Consultant</h3>
                                    <div className="text-[10px] text-slate-400 flex items-center gap-2">
  <span className={`w-1.5 h-1.5 rounded-full ${isRagEnabled ? "bg-green-500" : "bg-slate-400"}`}></span>
  <span>
    {isRagEnabled && activeProject
      ? "RAG ON • Project Context Active"
      : "RAG OFF • General Chat"}
  </span>

  {/* RAG Toggle */}
  <button
    onClick={() => setIsRagEnabled(v => !v)}
    className={`ml-2 px-2 py-0.5 rounded text-[9px] font-semibold transition
      ${isRagEnabled
        ? "bg-green-600 text-white hover:bg-green-700"
        : "bg-slate-600 text-white hover:bg-slate-700"}`}
    title="Toggle Retrieval-Augmented Generation"
  >
    RAG {isRagEnabled ? "ON" : "OFF"}
  </button>
</div>
                                </div>
                            </div>
                            <div className="flex gap-1"><button onClick={clearConversation} title="Clear conversation" className="p-1 text-slate-400 hover:text-white hover:bg-slate-800 rounded">🧹</button><button onClick={()=>setIsOpen(false)} title="Close" className="p-1 text-slate-400 hover:text-white hover:bg-slate-800 rounded">×</button></div>
                        </div>

                        {/* Messages */}
                        <div className="flex-1 overflow-y-auto p-4 bg-slate-50 space-y-4">
                            {messages.map((m, i) => (
                                <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                    <div className={`max-w-[85%] rounded-2xl p-3 text-sm whitespace-pre-wrap shadow-sm ${
                                        m.role === 'user' 
                                            ? 'bg-brand-600 text-white rounded-tr-none' 
                                            : 'bg-white text-slate-700 border border-slate-200 rounded-tl-none'
                                    }`}>
                                        {m.role === 'assistant'
  ? <div dangerouslySetInnerHTML={renderMiniMarkdown(m.content)} />
  : m.content}

                                    </div>
                                </div>
                            ))}
                            {loading && (
                                <div className="flex justify-start">
                                    <div className="bg-white border border-slate-200 rounded-2xl rounded-tl-none p-3 shadow-sm flex gap-1">
                                        <div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce"></div>
                                        <div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{animationDelay: '0.1s'}}></div>
                                        <div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{animationDelay: '0.2s'}}></div>
                                    </div>
                                </div>
                            )}
                            <div ref={messagesEndRef} />
                        </div>

                        {/* Input */}
                        <div className="p-3 bg-white border-t flex gap-2">
                            <input 
                                className="flex-1 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition"
                                placeholder="Ask about risks, mitigations..."
                                value={input}
                                onChange={e => setInput(e.target.value)}
                                onKeyDown={e => e.key === 'Enter' && handleSend()}
                            />
                            <button 
                                onClick={handleSend} 
                                disabled={loading || !input.trim()}
                                className="bg-slate-900 text-white p-2 rounded-lg hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                                <Icon name="arrowUp" className="w-5 h-5" />
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
};