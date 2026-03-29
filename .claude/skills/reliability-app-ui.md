# Reliability App UI Design Language

When building a reliability or engineering application, follow this design system exactly. This is the canonical UI specification — do not deviate unless the user explicitly overrides. All apps in this family must share the same visual language.

---

## 1. Tech Stack

- **Framework**: React 19 + TypeScript
- **Build Tool**: Vite
- **Styling**: Tailwind CSS via CDN (`<script src="https://cdn.tailwindcss.com">`) — utility-first, no CSS-in-JS
- **Component Library**: None — all components are hand-built with Tailwind classes
- **Fonts**: Google Fonts — Inter (sans, weights 300–700) + JetBrains Mono (mono, weight 500)
- **Dependencies**: Loaded via ESM import map in `index.html`

### HTML Boilerplate

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta name="theme-color" content="#0f172a">
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
    <script src="https://cdn.tailwindcss.com"></script>
</head>
```

---

## 2. Tailwind Configuration

Always include this configuration in a `<script>` tag after the Tailwind CDN import:

```javascript
tailwind.config = {
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace']
      },
      colors: {
        slate: { 850: '#1e293b', 900: '#0f172a' },
        brand: { 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8' }
      }
    }
  }
}
```

---

## 3. Color System

| Token | Value | Usage |
|-------|-------|-------|
| `brand-500` | `#3b82f6` | Primary accent, focus rings, active links |
| `brand-600` | `#2563eb` | Active tab backgrounds, primary buttons, hover |
| `brand-700` | `#1d4ed8` | Pressed/dark brand states |
| `slate-900` | `#0f172a` | Header background, dark UI panels, primary dark buttons |
| `slate-850` | `#1e293b` | Secondary dark surfaces (tab container backgrounds) |
| `slate-50` | `#f8fafc` | Body background |
| `slate-100` | `#f1f5f9` | Editor content area background, table header bg |
| `white` | `#ffffff` | Cards, panels, input backgrounds |
| `slate-200` | `#e2e8f0` | Card borders, input borders, dividers |
| `slate-300` | `#cbd5e1` | Connector lines, dashed borders, scrollbar thumb |
| `slate-400` | `#94a3b8` | Labels, meta text, inactive tabs, placeholders |
| `slate-500` | `#64748b` | Secondary text, table headers |
| `slate-700` | `#334155` | Body text |
| `slate-900` | `#0f172a` | Headings |

### Risk/Severity Colors (3-Tier)

```javascript
const getRiskColor = (score) =>
  score >= 100 ? "bg-red-100 text-red-800"
  : score >= 40 ? "bg-yellow-100 text-yellow-800"
  : "bg-green-100 text-green-800";
```

Badge: `text-xs font-bold rounded py-1 border ${getRiskColor(score)}`

---

## 4. Typography Scale

| Element | Classes |
|---------|---------|
| Page title | `text-3xl font-bold text-slate-900` |
| Section header | `text-lg font-semibold` |
| Card title | `font-bold text-lg` |
| Body text | `text-sm text-slate-700` |
| Table header | `text-xs font-bold uppercase text-slate-400` |
| Micro label | `text-[10px] font-bold uppercase text-slate-400 mb-1 ml-1` |
| Settings label | `text-xs font-semibold text-slate-500 mb-1` |
| Meta/timestamp | `text-xs text-slate-400` |
| Empty state | `text-slate-400 italic` |
| Monospace | `font-mono` (file paths, code, API keys) |

---

## 5. Layout Architecture

### App Shell
```jsx
<div className="h-screen flex flex-col font-sans text-slate-700 bg-slate-50">
  <header>...</header>
  <main>...</main>
</div>
```

### Header
```jsx
<header className="h-14 bg-slate-900 text-white flex items-center justify-between px-6 shadow-md shrink-0 z-20">
  {/* Left: Logo + App Name */}
  <div className="flex items-center gap-3">
    <img src="logo.png" className="w-12 h-12 rounded" />
    <div>
      <div className="font-bold text-sm">App Name</div>
      <div className="text-xs text-slate-400 animate-pulse">Auto-saved</div>
    </div>
  </div>
  {/* Right: Tab switcher + toolbar buttons + exit */}
</header>
```

### Dashboard View (Project List)
```jsx
<div className="flex-1 p-10 overflow-y-auto flex flex-col">
  <div className="max-w-5xl mx-auto w-full">
    {/* Tab buttons + grid */}
    <div className="grid md:grid-cols-3 gap-6">
      {/* Project cards */}
    </div>
  </div>
</div>
```

### Editor View (Tabbed Content)
```jsx
<div className="flex-1 flex overflow-hidden relative">
  <div className="flex-1 bg-slate-100 overflow-y-auto scroll-thin p-8">
    <div className="max-w-7xl mx-auto">
      {/* Tabbed content: Build / Table / Map */}
    </div>
  </div>
</div>
```

### Right Sidebar (Optional)
```jsx
<div className="w-80 border-l border-slate-200 bg-white h-full overflow-y-auto shadow-xl p-4 absolute right-0 top-0 bottom-0 animate-enter z-30">
  {/* Sidebar content */}
</div>
```

---

## 6. Component Patterns

### Buttons

**Primary (dark)**:
```
bg-slate-900 text-white px-4 py-2 rounded font-bold flex items-center gap-2
```

**Primary (brand)**:
```
bg-brand-600 text-white px-4 py-2 rounded font-bold
```

**Gradient CTA**:
```
bg-gradient-to-r from-brand-600 to-indigo-600 text-white px-4 py-2 rounded shadow font-bold text-xs inline-flex items-center hover:shadow-lg transition
```

**Secondary**:
```
bg-white border text-slate-600 px-4 py-2 rounded font-bold flex items-center gap-2 cursor-pointer hover:bg-slate-50
```

**Danger**:
```
bg-red-600 text-white px-3 py-2 text-sm rounded-lg
```

**Header toolbar button**:
```
text-xs font-bold bg-slate-800 px-3 py-1 rounded border border-slate-600 whitespace-nowrap
```

**Icon-only delete**:
```
text-slate-300 hover:text-red-500 transition p-1
```

**Dashed add button**:
```
w-full py-4 border-2 border-dashed border-slate-300 rounded font-bold text-slate-400 hover:border-brand-500 hover:text-brand-500
```

**Inline add link**:
```
text-xs font-bold text-brand-600
```

### Inputs

**Standard input**:
```
w-full bg-white border border-slate-200 rounded p-2 text-sm outline-none focus:border-brand-500 transition shadow-sm
```

**Standard textarea**: Same as input plus `min-h-[50px]`

**Settings input**:
```
w-full border border-slate-200 rounded px-3 py-2 text-sm outline-none focus:border-brand-500
```

**Tiny input** (scores/ratings):
```
w-5 text-center border text-xs
```

**Checkbox**:
```
w-4 h-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500
```

### Smart Input (AI-Augmented Field)

Wrapper: `w-full mb-1 relative group`

Label: `block text-[10px] font-bold text-slate-400 uppercase mb-1 ml-1`

AI wand button (appears on hover):
```
absolute right-2 top-2 text-slate-300 hover:text-brand-600 bg-white p-1 rounded-full opacity-0 group-hover:opacity-100 transition border border-transparent hover:border-slate-200
```

### Tabs

**Header tabs (pill inside dark container)**:
```jsx
{/* Container */}
<div className="flex bg-slate-800 rounded p-1">
  {/* Active tab */}
  <button className="px-3 py-1 rounded text-xs font-bold bg-brand-600 text-white">Active</button>
  {/* Inactive tab */}
  <button className="px-3 py-1 rounded text-xs font-bold text-slate-400">Inactive</button>
</div>
```

**Dashboard tabs (outlined pills)**:
```jsx
{/* Active */}
<button className="px-3 py-1 rounded-full border font-semibold text-xs bg-slate-900 text-white border-slate-900">Active</button>
{/* Inactive */}
<button className="px-3 py-1 rounded-full border font-semibold text-xs bg-slate-100 text-slate-600 border-slate-300">Inactive</button>
```

### Cards

**Project card (dashboard)**:
```jsx
<div className="bg-white p-6 rounded shadow hover:shadow-lg cursor-pointer relative group">
  <button className="absolute top-4 right-4 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition">
    <Icon name="trash" />
  </button>
  <h3 className="font-bold text-lg">{title}</h3>
  <p className="text-sm text-slate-500 mt-1 line-clamp-2">{description}</p>
  <div className="mt-4 flex justify-between items-center text-xs text-slate-400">
    <span>Created: {date}</span>
    <span>Updated: {date}</span>
  </div>
</div>
```

**Settings card**:
```
bg-white p-6 rounded border max-w-xl
```
Title: `text-lg font-semibold mb-4`

**Editor subsystem card**:
```
bg-white rounded border shadow-sm mb-8 overflow-hidden animate-enter
```
Active state: `border-2 border-brand-500 ring-2 ring-brand-100`
Inactive state: `border-2 border-slate-200`
Header section: `bg-slate-50 p-4 border-b flex justify-between items-start`

### Modals

**Overlay**:
```
fixed inset-0 z-[9999] bg-black/40 grid place-items-center
```

**Content**:
```
bg-white rounded-xl p-4 w-[92vw] max-w-sm border
```

**Confirmation dialog**:
```jsx
<div className="fixed inset-0 z-[9999] bg-black/40 grid place-items-center" onMouseDown={close}>
  <div className="bg-white rounded-xl p-4 w-[92vw] max-w-sm border" onMouseDown={e => e.stopPropagation()}>
    <div className="text-sm text-slate-700">{message}</div>
    <div className="mt-4 flex justify-end gap-2">
      <button className="px-3 py-2 text-sm border rounded-lg">Cancel</button>
      <button className="px-3 py-2 text-sm bg-red-600 text-white rounded-lg">Delete</button>
    </div>
  </div>
</div>
```

### Tables

**Inline-edit table**:
```
w-full text-left text-sm border-collapse
```
Thead: `bg-slate-50 text-slate-500 text-xs font-bold uppercase`
Row hover: `group hover:bg-slate-50`
Cells: `p-2 border-r`

**Read-only merged table**: Use `.merged-table` CSS class (see Custom CSS section).

### Dropdown Menu
```
absolute top-10 right-0 bg-white border rounded shadow-xl flex flex-col w-40 z-30
```

### Risk/Severity Badge
```jsx
<div className={`text-xs font-bold rounded py-1 border text-center ${getRiskColor(score)}`}>
  {score}
</div>
```

---

## 7. Tree Visualization

### Node Types with Color-Coded Borders

**Root node**:
```
bg-slate-900 text-white border border-slate-800 rounded-xl px-10 py-6 min-w-[320px] max-w-[420px] shadow-lg text-center text-lg relative z-20 transition-all hover:scale-105 hover:shadow-xl hover:z-50 cursor-pointer select-none
```

**Subsystem node**: White card + `border-l-[5px] border-l-brand-500`
```
bg-white border border-slate-200 rounded-lg p-3 min-w-[220px] max-w-[300px] shadow-sm text-left relative z-20 transition-all hover:scale-105 hover:shadow-lg hover:border-brand-500 hover:z-50 whitespace-pre-wrap border-l-[5px] border-l-brand-500
```

**Failure node**: Same white card + `border-l-[5px] border-l-amber-500`

**Mode node**: Same white card + `border-l-[5px] border-l-red-500`

**Selected state**: Add `ring-2 ring-brand-500`

### TreeNode Component Pattern

```tsx
interface TreeNodeProps {
  id: string;
  content: React.ReactNode;
  type: 'root' | 'sub' | 'fail' | 'mode';
  children?: React.ReactNode;
  isExpanded: boolean;
  onToggle: (id: string) => void;
  isSelected?: boolean;
  onSelect?: (id: string) => void;
}
```

Use `role="treeitem"` and `aria-expanded` for accessibility.

---

## 8. Floating Chatbot Panel

**Trigger button** (right rail, half-circle):
```
fixed z-50 w-14 h-14 rounded-l-full bg-slate-900 text-white shadow-xl flex items-center justify-center cursor-pointer transition-all duration-300
```
With notification dot: `absolute top-2 left-2 w-2.5 h-2.5 bg-red-500 rounded-full`

**Chat panel**:
```
fixed inset-0 z-50
```
Card: `bg-white w-full sm:w-[400px] h-[80vh] sm:h-[600px] shadow-2xl rounded-t-xl sm:rounded-xl flex flex-col border border-slate-200`

**Panel header**: `bg-slate-900 text-white p-4`

**Messages area**: `flex-1 overflow-y-auto p-4 bg-slate-50 space-y-4`

**User bubble**: `bg-brand-600 text-white rounded-2xl rounded-tr-none p-3 text-sm`

**Assistant bubble**: `bg-white text-slate-700 border border-slate-200 rounded-2xl rounded-tl-none p-3 text-sm`

**Loading dots**: Three `w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce` with staggered delays.

---

## 9. Icon System

Custom `<Icon>` component rendering inline SVGs. Default size: `w-5 h-5`. All icons use `stroke="currentColor"`, `strokeWidth={2}`, `fill="none"`, `viewBox="0 0 24 24"`.

The wand icon automatically gets `text-brand-500` tint.

```tsx
export const Icon = ({ name, className = "w-5 h-5" }: { name: string; className?: string }) => {
    const paths: Record<string, string> = {
        wand: "M13 10V3L4 14h7v7l9-11h-7z",
        plus: "M12 4v16m8-8H4",
        save: "M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4",
        trash: "M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16",
        table: "M3 10h18M3 14h18m-9-4v8m-7-4h14M4 6h16a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V8a2 2 0 012-2z",
        tree: "M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z",
        download: "M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4",
        arrowUp: "M5 10l7-7m0 0l7 7m-7-7v18",
        arrowDown: "M19 14l-7 7m0 0l-7-7m7 7V3",
        chevronDown: "M19 9l-7 7-7-7",
        chevronUp: "M5 15l7-7 7 7",
        chevronRight: "M9 5l7 7-7 7",
        arrowLeft: "M10 19l-7-7m0 0l7-7m-7 7h18",
        excel: "M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z",
        book: "M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253",
        bolt: "M13 10V3L4 14h7v7l9-11h-7z",
        image: "M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z",
        code: "M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4",
        upload: "M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12",
        move: "M4 8h16M4 16h16",
        gear: "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z",
        clip: "M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13",
        folder: "M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
    };
    return (
        <svg className={`${className} ${name === 'wand' ? 'text-brand-500' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={paths[name] || ""} />
        </svg>
    );
};
```

### Icon Semantic Usage
| Icon | When to Use |
|------|-------------|
| `wand` | AI-assisted actions |
| `plus` | Add/create items |
| `trash` | Delete actions |
| `save` | Save/download |
| `download` | Download/export |
| `upload` | Upload files |
| `table` | Table view tab |
| `tree` | Tree/map view tab |
| `code` | Export/JSON |
| `excel` | Spreadsheet export |
| `book` | Library/reference panel |
| `bolt` | Auto-generate/power actions |
| `image` | Image-related actions |
| `gear` | Settings/toolbar toggle |
| `move` | Drag handle |
| `arrowLeft` | Back/exit navigation |
| `chevronDown/Up/Right` | Expand/collapse, dropdowns |
| `clip` | Attachments |
| `folder` | Folder/directory |

---

## 10. Custom CSS

Include these styles in a `<style>` block in `index.html`:

```css
/* Custom scrollbar */
.scroll-thin::-webkit-scrollbar { width: 8px; height: 8px }
.scroll-thin::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 4px }
.scroll-thin::-webkit-scrollbar-track { background: transparent }

/* Fade-in animation */
.animate-enter { animation: fadeIn 0.3s ease-out forwards }
@keyframes fadeIn { from { opacity: 0; transform: translateY(5px) } to { opacity: 1; transform: translateY(0) } }

/* Tree visualization connectors */
.tf-tree ul { display: flex; flex-direction: column; padding-left: 40px; margin: 0; position: relative }
.tf-tree li { list-style-type: none; position: relative; padding: 10px 0; display: flex; flex-direction: row; align-items: center }
.tf-tree li::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; border-left: 2px solid #cbd5e1; z-index: 0 }
.tf-tree li::after { content: ''; position: absolute; left: 0; top: 50%; width: 40px; border-top: 2px solid #cbd5e1; z-index: 0 }
.tf-tree li:first-child::before { top: 50%; height: 50% }
.tf-tree li:last-child::before { bottom: 50%; height: 50% }
.tf-tree li:only-child::before { display: none }
.tf-tree > ul { padding-left: 0 }
.tf-tree > ul > li { padding-left: 0 }
.tf-tree > ul > li > .node-wrapper::before { display: none }
.tf-tree > ul > li::before { display: none }
.tf-tree > ul > li::after { display: none }
.tf-tree li.is-collapsed::after { content: none !important; display: none !important }
.tf-tree li.is-collapsed > .node-wrapper.has-children::after { content: none !important; display: none !important }
.tf-tree li.is-collapsed > ul { display: none !important }
.node-wrapper { margin-right: 0; position: relative; z-index: 10 }
.node-wrapper.has-children::after { content: ''; position: absolute; top: 50%; right: -40px; width: 40px; height: 2px; background: #cbd5e1; z-index: -1 }

/* Merged table */
.merged-table th { background-color: #f1f5f9; position: sticky; top: 0; z-index: 10; border: 1px solid #cbd5e1; padding: 8px; font-size: 11px; font-weight: 700; color: #475569; text-transform: uppercase }
.merged-table td { border: 1px solid #e2e8f0; padding: 8px; font-size: 12px; vertical-align: top; background: white }
.merged-table tr:hover td { background-color: #f8fafc }
```

---

## 11. Animations & Micro-Interactions

| Pattern | Implementation |
|---------|---------------|
| Enter animation | `.animate-enter` class on appearing elements |
| Auto-save pulse | `animate-pulse` on status text |
| Hover scale (tree) | `hover:scale-105 hover:shadow-lg hover:z-50` |
| Group reveal | `opacity-0 group-hover:opacity-100 transition` (delete buttons, AI wand) |
| Drag state | `opacity-50 border-dashed border-brand-500` |
| Loading text | `"Generating..."` or `"Loading..."` or `"..."` |
| Loading pulse | `animate-pulse scale-110` on scoring elements |
| Bounce dots | `w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce` with staggered `animation-delay` |

---

## 12. State Management Patterns

- **React hooks only** — `useState`, `useEffect`, `useRef`. No Redux/Zustand.
- **localStorage persistence** — auto-save on every state change via `useEffect`.
- **Safe JSON parse**: `const safeGet = (k, fallback) => { try { const i = localStorage.getItem(k); return i ? JSON.parse(i) : fallback; } catch { return fallback; } }`
- **ID generation**: `Date.now().toString(36) + Math.random().toString(36).substr(2, 5)`
- **Immutable nested updates**: Always use spread operator for deep state mutations.
- **Touch on update**: `const touchProject = (p) => ({ ...p, updatedAt: new Date().toISOString() })`
- **Confirmation dialog pattern**: State object `{ msg: string, run: () => void | null }`, with `ask(message, callback)` and `closeAsk()` helpers.

---

## 13. Responsive Breakpoints

| Pattern | Classes |
|---------|---------|
| Card grid | `grid md:grid-cols-3 gap-6` |
| Chat panel | `w-full sm:w-[400px] h-[80vh] sm:h-[600px]` |
| Modals | `w-[92vw] max-w-sm` (mobile-first) |
| Dashboard content | `max-w-5xl mx-auto` |
| Editor content | `max-w-7xl mx-auto` |

---

## 14. Domain Adaptation

This design system works for any reliability or engineering domain. When adapting:

- **Terminology**: Replace domain-specific terms (e.g., "Subsystem", "Failure Mode") but keep the same visual patterns.
- **Hierarchy**: The 4-level tree (System > Subsystem > Failure > Mode) maps to any domain taxonomy. Adjust node type names and border colors as needed, but preserve the color-coded left-border pattern.
- **Risk thresholds**: The `getRiskColor` function thresholds (40, 100) are configurable per domain. The 3-tier green/yellow/red pattern is universal.
- **AI wand pattern**: The SmartInput with hover wand applies to any field needing AI assistance. Wire it to your AI service.
- **Library sidebar**: Works for any reference data catalog (part libraries, failure catalogs, standards, etc.).
- **Export formats**: JSON export + Excel with merged cells + image export (via html2canvas) pattern is reusable across domains.

---

## 15. File Structure Convention

```
project/
├── index.html          # HTML boilerplate, Tailwind config, custom CSS, import map
├── index.tsx            # React root render
├── App.tsx              # Main app component (views, state, layout)
├── types.ts             # TypeScript interfaces
├── constants.ts         # Static data (libraries, catalogs)
├── components/
│   ├── Icon.tsx          # SVG icon system
│   ├── SmartInput.tsx    # AI-augmented input field
│   ├── TreeNode.tsx      # Tree visualization node
│   └── Chatbot.tsx       # Floating AI assistant
├── services/
│   ├── AIService.ts      # AI integration layer
│   └── FileSystem.ts     # File system access
├── vite.config.ts
├── tsconfig.json
└── package.json
```
