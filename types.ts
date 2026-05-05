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
}

export type FailureCategory =
  | 'Total Failure'
  | 'Partial/Degraded Failure'
  | 'Erratic Failure'
  | 'Secondary/Conditional Failure';

export interface Failure {
  id: string;
  desc: string;
  modes: Mode[];
  collapsed?: boolean;
  sourcePair?: {
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
    funcHash: string;
    failureCount: number;
    isExhausted: boolean;
  };
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
  subsystemExhausted?: boolean;   // when true, FF wand short-circuits to '' (no AI call)
}
