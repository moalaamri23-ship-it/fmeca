# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **IMPORTANT:** Before implementing any feature or modification — no matter how small — you MUST invoke both skills:
> - `/reliability_app_Create` — for reliability engineering logic, feature design, and domain behavior
> - `/reliability-app-ui` — for all UI, styling, and layout decisions
>
> Do not write or modify any code without consulting these skills first.
>
> The canonical skill files are **global** (accessible across all projects), located at:
> `~/.claude/plugins/cache/local/reliability-tools/unknown/skills/`

## Commands

```bash
npm install        # Install dependencies
npm run dev        # Dev server on http://localhost:3000
npm run build      # Production build
npm run preview    # Preview production build
```

No test runner is configured. Set `GEMINI_API_KEY` in `.env.local` before running.

## Architecture

This is a fully client-side SPA — no backend. AI calls go directly from the browser to provider APIs.

### Key files

- **`App.tsx`** — monolithic main component (~960 lines). Owns all state (30+ `useState` hooks) and business logic. All CRUD, export/import, and AI orchestration lives here.
- **`types.ts`** — domain model (Project → Subsystems → Failures → Modes with RPN scores)
- **`constants.ts`** — pre-loaded failure library (JSON)
- **`components/`** — stateless-ish children that receive props from App:
  - `Icon.tsx` — inline SVG icon system
  - `SmartInput.tsx` — AI-augmented input field with hover wand
  - `ModelSelector.tsx` — live model picker with search, tier groups, and favorites
  - `Chatbot.tsx` — floating RCM Consultant panel. RAG ON: calls `chatWithTools()` to select tools, `executeToolCall()` to fetch exact data, then `chat()` for the final answer. Falls back to JSON planner then keyword retrieval. RAG OFF: direct general-knowledge chat.
  - `SystemModesModal.tsx` — System Modes feature: upload Excel failure data (mode + count), inject as ranked context block into every AI prompt when enabled
  - `TreeNode.tsx` — tree visualization node
  - `AttachmentModal.tsx`, `SystemModesModal.tsx`, `MitigationBuilder.tsx`
- **`services/AIService.ts`** — all AI calls (~820 lines); supports Gemini, OpenAI, Anthropic, Azure, OpenRouter. Key additions:
  - `chatWithTools(req, tools)` — sends tool definitions to OpenAI (`tools` param + `tool_calls` parsing) and Gemini (`function_declarations` + `functionCall` parsing); falls back to `chat()` for Anthropic/errors. Returns `ToolChatResult` (`type: 'text' | 'tool_calls'`).
  - Exported interfaces: `ToolDefinition`, `ToolCall`, `ToolChatResult`
  - `fetchModels(provider, apiKey)` — live model list fetching with `TieredModels` classification (Pro / Balanced / Efficient), cached 24h.
- **`services/RAGService.ts`** — client-side RAG + tool execution engine for the chatbot. Key methods:
  - `buildRichIndex(project)` — two-level orientation index (subsystems + all FF descriptions)
  - `resolveSubsystem(name, project)` — fuzzy name matching (exact → contains → word-overlap)
  - `executeToolCall(name, args, project)` — executes one of 5 named tools against real project data: `list_subsystems`, `get_subsystem_detail`, `get_failure_modes`, `search_project`, `get_rpn_summary`
  - `buildContextByPlan(plan, query, project)` — JSON-planner-driven retrieval (fallback path)
  - `retrieveContext(query, project, limit)` — keyword scoring fallback (last resort)
- **`services/FileSystem.ts`** — wraps the File System Access API; persists folder handles in IndexedDB (`FmecaPro_FS`)

### Data model hierarchy

```
Project
  └── Subsystems[]
      └── Failures[] (Functional Failures)
          └── Modes[] (Failure Modes)
              ├── RPN { s, o, d }  // Severity, Occurrence, Detection
              └── mode, effect, cause, mitigation
```

### Persistence

- **Projects** — `localStorage` key `rcm_projects_v44`
- **API key** — `localStorage` key `rcm_api_key_v44`
- **Model name** — `localStorage` key `rcm_model_name_v1`
- **Live model cache** — `localStorage` key `fmeca_models_cache` (JSON of `Record<provider, TieredModels>`, 24h TTL)
- **Favorites** — `localStorage` key `fmeca_fav_${provider}` per provider (max 4 model IDs)
- **My Models** (OpenRouter) — `localStorage` key `fmeca_user_models_${provider}` per provider
- **Filesystem folder handles** — IndexedDB (`FmecaPro_FS`); survives page reloads

### AI integration

Multi-provider: Gemini, OpenAI, Anthropic, Azure OpenAI, OpenRouter. Provider is selected via tabs in the settings panel. Switching provider resets model to that provider's default.

`AIService` has two operation modes controlled by `AI_CONFIG.baseUrl`:
- **Direct (default)** — browser calls provider APIs directly
- **Remote** — proxies through a backend URL

**Live model fetching:** `AIService.fetchModels(provider, apiKey)` calls the provider's model list API, filters to chat-capable models only (allowlist per provider), and classifies into Pro / Balanced / Efficient tiers. Results cached 24h in `fmeca_models_cache`. Gemini, OpenAI, Anthropic support live fetch; Azure and OpenRouter do not.

The `aiSourceMode` state in App controls context injection:
- `ai` — general knowledge only
- `file` — reference file as context
- `hybrid` — combines RAG project context + reference file

### Views

| Tab | Description |
|-----|-------------|
| Dashboard | Project list and settings |
| Build | Tree editor (hierarchical) |
| ViewTable | Spreadsheet-style structured view |
| Map | Tree diagram visualization with PNG export |

### Chatbot RAG architecture

The chatbot uses a three-step pipeline when RAG is ON:

1. **Tool selection** — `AIService.chatWithTools()` sends the user query + a rich project index (subsystems + all FF descriptions) to the AI with 5 tool definitions. The AI calls the right tool(s) without answering yet.
2. **Tool execution** — `RAGService.executeToolCall()` runs the requested tool against real project data and returns exact structured text.
3. **Answer generation** — `AIService.chat()` receives the tool results as `RETRIEVED DATA` in the system prompt and generates the final answer.

Fallback chain if tool calling fails or provider doesn't support it:
- Step 1b: JSON planner (`SYSTEM_RETRIEVAL_PLANNER` prompt → `buildContextByPlan()`)
- Step 1c: Keyword retrieval (`retrieveContext()`)

RAG OFF bypasses all retrieval; the AI answers from general knowledge only.

### AI writing assistant (magic wand)

`AIService.generate(fieldLabel, currentText, ...)` dispatches by word count:
- **0 words** — from-scratch generation with field-specific structured prompts (Function, Spec, Subsystem, other)
- **1–5 words** — grammar/spelling fix only
- **6+ words** — field-specific enhancement: same output rules as from-scratch but incorporates the user's existing text

### Export formats

JSON (full project), Excel (merged cells via `xlsx-js-style`), PNG (tree via `html2canvas`)

### Styling

Tailwind CSS loaded via CDN at runtime (not PostCSS). The vite config injects `VITE_GEMINI_API_KEY` from `.env.local`. Custom Tailwind theme extends with `brand-500/600/700` and `slate-850/900` colors; fonts are Inter and JetBrains Mono.
