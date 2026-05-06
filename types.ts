export interface RPN {
  s: number | string;
  o: number | string;
  d: number | string;
}

export interface Mode {
  id: string;
  mode: string;
  effect: string;
  cause: string;
  mitigation: string;
  rpn: RPN;
  systemModeId?: string;       // matched System Mode key (slug of mode name)
  systemModeCount?: number;    // historical count at time of generation (drives O score)
}

export type FailureCategory =
  | 'Total Failure'
  | 'Partial/Degraded Failure'
  | 'Erratic Failure'
  | 'Secondary/Conditional Failure';

export interface BreakdownRow {
  id: string;                  // stable id, referenced by Failure.sourcePair.breakdownId
  function: string;            // verb + object
  standard: string;            // value/expectation
  category: FailureCategory;
  snippet: string;             // verbatim slice from the original function description
  canonical_failure: string;   // pre-computed FF text — wand returns this verbatim
}

export interface Failure {
  id: string;
  desc: string;
  modes: Mode[];
  collapsed?: boolean;
  sourcePair?: {
    breakdownId?: string;            // hard link to Subsystem.functionBreakdown row (preferred)
    function: string;
    standard: string;
    category: FailureCategory;
  };
}

export interface Subsystem {
  id: string;
  name: string;
  specs: string;
  func: string;
  imageData: string;
  imageName: string;
  imageJson: string;
  showImageJson: boolean;
  failures: Failure[];
  collapsed?: boolean;
  exhaustionState?: {
    // Legacy: kept readable for backward compat. New code derives exhaustion from functionBreakdown.
    funcHash: string;
    failureCount: number;
    isExhausted: boolean;
  };
  functionBreakdown?: BreakdownRow[];  // canonical decomposition; null until first run
  funcHashAtBreakdown?: string;        // hash of sub.func when breakdown was last generated
}

export interface Project {
  id: string;
  name: string;
  desc: string;
  created: string;
  updated: string;
  subsystems: Subsystem[];
}

export interface LibraryItem {
  fail: string;
  mode: string;
  effect: string;
  cause: string;
  task: string;
}

export interface RichLibrary {
  [key: string]: LibraryItem[];
}

export interface FileEntry {
  name: string;
  handle: FileSystemFileHandle;
}

// Minimal types for File System Access API if not present in environment
declare global {
  interface Window {
    showDirectoryPicker(): Promise<FileSystemDirectoryHandle>;
  }
}

export interface ContextData {
  project?: string;
  subsystem?: string;
  specs?: string;
  checklistText?: string;
  detectionScore?: number;
  funcDescription?: string;       // subsystem function description (for FF wand)
  existingFailures?: string[];    // other FF descriptions already defined (for uniqueness)
  failureDesc?: string;           // parent functional failure (for FM wand context)
  existingModes?: string[];       // other FM names already defined (for uniqueness)
  // Persistent-breakdown wiring (Phase 1) — supersedes the legacy subsystemExhausted flag.
  // The wand consumes these to compute exhaustion deterministically without an AI call:
  //   exhausted iff breakdownRows is non-empty AND every row's id is in filledBreakdownIds.
  breakdownRows?: BreakdownRow[];      // current subsystem's full breakdown
  filledBreakdownIds?: string[];       // breakdownId values that already have a linked FF
  // System Modes wiring (Phase 4):
  systemModes?: Array<{ mode: string; count: number }>;  // relevant historical modes for FM wand preference
  // RPN-aware mitigation (Phase 5):
  rpnTotal?: number;              // S * O * D for the parent mode (drives mitigation count)
}
