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
  /** Controls already in place — Detection (D) is scored against these only. */
  currentControls?: string;
  /** Recommended actions — proposed, not yet implemented; never credited toward D. */
  mitigation: string;
  rpn: RPN;
  /** Hidden audit note from AI RPN scoring; available to the chatbot. */
  rpnReason?: string;
  /** Optional source/provenance labels shown only when Hybrid labels are enabled. */
  sourceTags?: string[];
}

export interface Failure {
  id: string;
  desc: string;
  modes: Mode[];
  collapsed?: boolean;
  sourceTags?: string[];
}

export interface BreakdownRow {
  id: string;
  function: string;  // verb + object
  standard: string;  // value/expectation
  snippet: string;   // verbatim slice from the function description
}

export interface BreakdownMatch {
  rowId: string;
  failureIds: string[];
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
  functionBreakdown?: BreakdownRow[];
  breakdownMatches?: BreakdownMatch[];
  funcHashAtBreakdown?: string;
  sourceTags?: string[];
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
  /** Mode's existing controls — mitigation generation recommends only what these don't cover. */
  currentControls?: string;
}
