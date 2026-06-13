# App Architecture Reference

## Standard Project Structure

Every reliability app follows this folder structure:

```
my-reliability-app/
├── index.html
├── package.json
├── vite.config.ts
├── tsconfig.json
├── tsconfig.app.json
├── .npmrc                          # peer dep fixes
├── src/
│   ├── main.tsx                    # React root
│   ├── App.tsx                     # Routes, top-level state
│   ├── types.ts                    # All TypeScript interfaces
│   ├── constants.ts                # App constants, default values
│   │
│   ├── store/
│   │   └── useAppStore.ts          # Zustand store with localStorage
│   │
│   ├── utils/
│   │   ├── aiService.ts            # Multi-provider AI abstraction
│   │   ├── metrics.ts              # MTBF, MTTR, availability calcs
│   │   ├── parser.ts               # CSV/Excel parsing (PapaParse, XLSX)
│   │   └── export.ts               # JSON, Excel, PDF export
│   │
│   ├── components/
│   │   ├── Layout.tsx              # App shell, navigation, header
│   │   ├── Chatbot.tsx             # Floating AI chatbot panel
│   │   ├── Icon.tsx                # Custom SVG icons
│   │   ├── Markdown.tsx            # Render AI markdown responses
│   │   └── [feature]/              # Feature-specific components
│   │
│   ├── pages/
│   │   ├── ProjectsPage.tsx        # Dashboard / project list
│   │   ├── SettingsPage.tsx        # API keys, AI config
│   │   └── [feature]/              # Feature pages
│   │
│   └── services/
│       ├── AIService.ts            # (alias of aiService.ts, or extend)
│       └── RAGService.ts           # Retrieval-augmented generation
│
└── dist/                           # Built output
```

## package.json Template

```json
{
  "name": "reliability-tool-name",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "lint": "eslint .",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^7.0.0",
    "zustand": "^5.0.0",
    "recharts": "^3.0.0",
    "papaparse": "^5.4.0",
    "xlsx": "^0.18.5",
    "date-fns": "^4.0.0",
    "clsx": "^2.1.0",
    "tailwind-merge": "^3.0.0",
    "lucide-react": "^0.577.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@types/papaparse": "^5.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.5.0",
    "vite": "^8.0.0",
    "@tailwindcss/vite": "^4.0.0",
    "tailwindcss": "^4.0.0",
    "eslint": "^9.0.0",
    "@typescript-eslint/eslint-plugin": "^8.0.0",
    "@typescript-eslint/parser": "^8.0.0",
    "eslint-plugin-react-hooks": "^5.0.0",
    "eslint-plugin-react-refresh": "^0.4.0"
  }
}
```

**.npmrc** (critical for Vite 8 peer dep issues):
```
legacy-peer-deps=true
```

## vite.config.ts
```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
});
```

## Zustand Store Template

```typescript
// src/store/useAppStore.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface Project {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  data: any[];
  chatMessages: ChatMsg[];
  filters: ProjectFilters;
  undoStack: any[][];
  redoStack: any[][];
}

interface AppState {
  // Projects
  projects: Project[];
  currentProjectId: string | null;
  // AI Config
  aiProvider: AIProvider;
  apiKey: string;
  azureEndpoint: string;
  modelId: string;
  // Actions
  setCurrentProject: (id: string) => void;
  createProject: (name: string, desc: string) => void;
  updateProject: (id: string, updates: Partial<Project>) => void;
  deleteProject: (id: string) => void;
  // Undo/redo
  pushUndoSnapshot: (projectId: string, snapshot: any[]) => void;
  undo: (projectId: string) => void;
  redo: (projectId: string) => void;
  // AI Config
  setAIProvider: (provider: AIProvider) => void;
  setApiKey: (key: string) => void;
  setModelId: (id: string) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      projects: [],
      currentProjectId: null,
      aiProvider: 'gemini',
      apiKey: '',
      azureEndpoint: '',
      modelId: '',

      setCurrentProject: (id) => set({ currentProjectId: id }),

      createProject: (name, desc) => {
        const project: Project = {
          id: crypto.randomUUID(),
          name, desc,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          data: [],
          chatMessages: [],
          filters: {},
          undoStack: [],
          redoStack: [],
        };
        set(state => ({ projects: [...state.projects, project] }));
      },

      updateProject: (id, updates) => set(state => ({
        projects: state.projects.map(p =>
          p.id === id ? { ...p, ...updates, updatedAt: new Date().toISOString() } : p
        )
      })),

      pushUndoSnapshot: (projectId, snapshot) => set(state => ({
        projects: state.projects.map(p =>
          p.id === projectId ? {
            ...p,
            undoStack: [...(p.undoStack || []).slice(-9), snapshot],  // max 10 undo steps
            redoStack: []  // clear redo on new action
          } : p
        )
      })),

      undo: (projectId) => set(state => {
        const project = state.projects.find(p => p.id === projectId);
        if (!project || !project.undoStack.length) return state;
        const snapshot = project.undoStack[project.undoStack.length - 1];
        return {
          projects: state.projects.map(p =>
            p.id === projectId ? {
              ...p,
              data: snapshot,
              undoStack: p.undoStack.slice(0, -1),
              redoStack: [...(p.redoStack || []), p.data]
            } : p
          )
        };
      }),

      setAIProvider: (provider) => set({ aiProvider: provider }),
      setApiKey: (key) => set({ apiKey: key }),
      setModelId: (id) => set({ modelId: id }),
    }),
    { name: 'reliability-app-storage-v1' }
  )
);
```

## React Router Setup

```typescript
// src/App.tsx
import { BrowserRouter, Routes, Route } from 'react-router-dom';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<ProjectsPage />} />
        <Route path="/project/:projectId" element={<Layout />}>
          <Route index element={<DashboardPage />} />
          <Route path="analysis" element={<AnalysisPage />} />
          <Route path="charts" element={<ChartsPage />} />
          <Route path="report" element={<ReportPage />} />
        </Route>
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </BrowserRouter>
  );
}
```

## Tailwind Configuration

Tailwind 4 uses a CSS-first config. In `src/index.css`:

```css
@import "tailwindcss";

@theme {
  --color-primary: #2563eb;       /* reliability blue */
  --color-warning: #d97706;       /* amber warning */
  --color-danger: #dc2626;        /* red critical */
  --color-success: #16a34a;       /* green good */
  --color-surface: #1e293b;       /* dark surface */
  --color-surface-light: #f8fafc; /* light surface */
}
```

## Chart Templates (Recharts)

### Pareto Chart (Bar + Cumulative Line)
```tsx
<ComposedChart data={paretoData}>
  <CartesianGrid strokeDasharray="3 3" />
  <XAxis dataKey="mode" />
  <YAxis yAxisId="left" />
  <YAxis yAxisId="right" orientation="right" domain={[0, 100]} unit="%" />
  <Bar yAxisId="left" dataKey="count" fill="#2563eb" />
  <Line yAxisId="right" type="monotone" dataKey="cumulative" stroke="#dc2626" dot={false} />
  <ReferenceLine yAxisId="right" y={80} stroke="#dc2626" strokeDasharray="5 5" />
  <Tooltip />
  <Legend />
</ComposedChart>
```

### Reliability Trend Line
```tsx
<LineChart data={trendData}>
  <XAxis dataKey="date" />
  <YAxis domain={[0, 100]} unit="%" />
  <Line type="monotone" dataKey="availability" stroke="#16a34a" strokeWidth={2} />
  <Line type="monotone" dataKey="target" stroke="#d97706" strokeDasharray="5 5" />
  <ReferenceLine y={95} stroke="#dc2626" label="Target" />
</LineChart>
```

### Weibull Probability Plot
```tsx
<ScatterChart>
  <XAxis dataKey="lnTime" name="ln(t)" />
  <YAxis dataKey="lnLnR" name="ln(ln(1/R))" />
  <Scatter data={weibullPoints} fill="#2563eb" />
  <Line data={fittedLine} stroke="#dc2626" dot={false} />  {/* Weibull fit */}
</ScatterChart>
```

## CSV/Excel Parsing

```typescript
// PapaParse for CSV
import Papa from 'papaparse';

function parseCSV(file: File): Promise<{ headers: string[]; rows: any[] }> {
  return new Promise(resolve => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => resolve({
        headers: results.meta.fields || [],
        rows: results.data
      })
    });
  });
}

// XLSX for Excel
import * as XLSX from 'xlsx';

function parseExcel(file: File): Promise<{ sheets: { name: string; headers: string[]; rows: any[] }[] }> {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const workbook = XLSX.read(e.target!.result, { type: 'array' });
      const sheets = workbook.SheetNames.map(name => {
        const sheet = workbook.Sheets[name];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
        const headers = rows.length ? Object.keys(rows[0] as object) : [];
        return { name, headers, rows };
      });
      resolve({ sheets });
    };
    reader.readAsArrayBuffer(file);
  });
}
```

## Export Functions

### Export to JSON
```typescript
function exportProjectJSON(project: Project) {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `${project.name}_export.json`);
}
```

### Export to Excel (with XLSX-style)
```typescript
import * as XLSX from 'xlsx';

function exportToExcel(data: any[], columns: string[], filename: string) {
  const ws = XLSX.utils.json_to_sheet(data.map(row =>
    Object.fromEntries(columns.map(col => [col, row[col]]))
  ));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Data');
  XLSX.writeFile(wb, filename);
}
```

### Export to PDF via Print
```typescript
function exportToPDF(reportHtml: string) {
  const printWindow = window.open('', '_blank');
  printWindow!.document.write(`
    <html>
      <head>
        <title>Report</title>
        <style>
          @media print { body { font-family: Arial; } .no-print { display: none; } }
          /* Include report styles */
        </style>
      </head>
      <body>${reportHtml}</body>
    </html>
  `);
  printWindow!.document.close();
  printWindow!.print();
}
```

## Settings Page Pattern

```tsx
function SettingsPage() {
  const { aiProvider, apiKey, modelId, setAIProvider, setApiKey, setModelId } = useAppStore();
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<'success' | 'error' | null>(null);

  async function testConnection() {
    setTesting(true);
    try {
      const response = await callAI(aiProvider, apiKey, [{ role: 'user', content: 'Say "OK"' }]);
      setTestResult(response.text ? 'success' : 'error');
    } catch {
      setTestResult('error');
    } finally {
      setTesting(false);
    }
  }

  return (
    <div>
      {/* Provider selection */}
      <select value={aiProvider} onChange={e => setAIProvider(e.target.value as AIProvider)}>
        <option value="gemini">Google Gemini</option>
        <option value="openai">OpenAI</option>
        <option value="anthropic">Anthropic Claude</option>
        <option value="azure">Azure OpenAI</option>
        <option value="openrouter">OpenRouter</option>
      </select>

      {/* API key input */}
      <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="API Key" />

      {/* Model override */}
      <input value={modelId} onChange={e => setModelId(e.target.value)} placeholder="Model ID (optional)" />

      {/* Test button */}
      <button onClick={testConnection} disabled={testing}>
        {testing ? 'Testing...' : 'Test Connection'}
      </button>
      {testResult === 'success' && <span className="text-green-600">Connected</span>}
      {testResult === 'error' && <span className="text-red-600">Failed</span>}
    </div>
  );
}
```

## SVG Chart Generation for Reports

For embedding charts in exported reports:

```typescript
function generateParetoSVG(data: ParetoData[], width = 600, height = 300): string {
  const bars = data.map((d, i) => `
    <rect x="${i * (width/data.length)}" y="${height - (d.count/maxCount)*height}"
          width="${width/data.length - 4}" height="${(d.count/maxCount)*height}"
          fill="#2563eb" />
    <text x="${i * (width/data.length) + 10}" y="${height + 20}" font-size="10" transform="rotate(45)">
      ${d.mode.slice(0, 15)}
    </text>
  `).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height + 50}">${bars}</svg>`;
}
```

## Cloudflare Pages Deployment

`wrangler.toml` (or deploy via dashboard):
```toml
name = "reliability-app"
compatibility_date = "2024-01-01"

[site]
bucket = "./dist"
```

Build command: `npm run build`
Build output: `dist/`
No environment variables needed (all AI keys stored in browser localStorage).
