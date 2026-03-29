# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **IMPORTANT:** Before implementing any feature or modification — no matter how small — you MUST invoke both skills:
> - `/reliability_app_Create` — for reliability engineering logic, feature design, and domain behavior
> - `/reliability-app-ui` — for all UI, styling, and layout decisions
>
> Do not write or modify any code without consulting these skills first.

## Commands

```bash
npm install        # Install dependencies
npm run dev        # Dev server on http://localhost:3000
npm run build      # Production build
npm run preview    # Preview production build
```

No test runner is configured. Set `GEMINI_API_KEY` in `.env.local` before running.

## Architecture

This is a fully client-side SPA — no backend. AI calls go directly from the browser to Gemini or OpenAI APIs.

### Key files

- **`App.tsx`** — monolithic main component (~745 lines). Owns all state (30+ `useState` hooks) and business logic. All CRUD, export/import, and AI orchestration lives here.
- **`types.ts`** — domain model (Project → Subsystems → Failures → Modes with RPN scores)
- **`constants.ts`** — pre-loaded failure library (JSON)
- **`components/`** — stateless-ish children that receive props from App
- **`services/AIService.ts`** — all AI calls (chat, vision, generation, RPN scoring); supports Gemini and OpenAI (detected by `sk-` prefix on API key)
- **`services/RAGService.ts`** — client-side RAG for the chatbot; builds searchable indexes from project data and retrieves compact context to stay within token budgets
- **`services/FileSystem.ts`** — wraps the File System Access API; persists folder handles in IndexedDB (`FmecaPro_FS`)
- **`.claude/skills/reliability-app-ui.md`** — canonical design system spec (color palette, typography, layout patterns); consult this when editing UI

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

- **Projects** — `localStorage` (versioned at `v44`)
- **Filesystem folder handles** — IndexedDB (`FmecaPro_FS`); survives page reloads

### AI integration

`AIService` has two operation modes controlled by `AI_CONFIG.baseUrl`:
- **Direct (default)** — browser calls Gemini/OpenAI directly
- **Remote** — proxies through a backend URL

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

### Export formats

JSON (full project), Excel (merged cells via `xlsx-js-style`), PNG (tree via `html2canvas`)

### Styling

Tailwind CSS loaded via CDN at runtime (not PostCSS). The vite config injects `VITE_GEMINI_API_KEY` from `.env.local`. Custom Tailwind theme extends with `brand-500/600/700` and `slate-850/900` colors; fonts are Inter and JetBrains Mono.
