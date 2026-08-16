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
  /** Controls already in place. */
  currentControls?: string;
  /** Recommended actions considered by the RPN robot as post-mitigation barriers. */
  mitigation: string;
  rpn: RPN;
  rpnStatus?: "unscored" | "ai_scored" | "manual";
  /** Baseline score before mitigation, using current controls only. */
  rpnBaseline?: RPN;
  rpnImprovement?: {
    baselineRpn?: number;
    mitigatedRpn?: number;
    detectionImprovement?: number;
    rpnReduction?: number;
    summary?: string;
  };
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
  sourceBreakdownRowId?: string;
  sourceSnippet?: string;
  /** Which JA1012 failed state this row covers. Several failures share one breakdown row. */
  failedState?: FailedStateType;
  /** Set when generation fell back to a template — the text is a placeholder, not analysis. */
  needsReview?: boolean;
}

/** SAE JA1011 5.1 function classes. Secondary functions carry the highest-severity failures. */
export type FunctionClass = 'primary' | 'containment' | 'protection' | 'control' | 'support' | 'efficiency';

/** JA1012 failed-state types. One function yields several of these. */
export type FailedStateType = 'total' | 'partial' | 'upper_limit' | 'lower_limit' | 'intermittent' | 'on_demand';

export interface BreakdownRow {
  id: string;
  function: string;  // verb + object
  standard: string;  // value/expectation
  snippet: string;   // verbatim slice from the function description
  functionClass?: FunctionClass;
  /** True when `standard` carries a real measurable value; false flags an unauditable standard (JA1011 5.1.2). */
  quantified?: boolean;
  /** Hidden functions have no operational evidence of failure and drive failure-finding tasks (JA1011 5.2). */
  evidence?: 'evident' | 'hidden';
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
  /** Set after a successful publish to the SharePoint RCM register. */
  rcmRegister?: {
    rcmInternalNumber: string;
    itemId: number;
    itemLink: string;
    publishedAt: string;   // ISO
    status: string;        // what was sent
  };
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
  /** The project's Context field — operating philosophy, redundancy, duty. Seeds standby/lead-lag functions. */
  projectDescription?: string;
  subsystem?: string;
  specs?: string;
  subsystemFunction?: string;
  functionalFailure?: string;
  failureMode?: string;
  failureEffect?: string;
  failureCause?: string;
  checklistText?: string;
  detectionScore?: number;
  /** Mode's existing controls — mitigation generation recommends only what these don't cover. */
  currentControls?: string;
  /** Other modes in same functional failure/subsystem — used to exclude sibling-mode barriers. */
  siblingFailureModes?: Array<Pick<Mode, 'mode' | 'cause' | 'effect'>>;
  /** Names of the project's other subsystems — used to keep Specs inside this subsystem's boundary. */
  siblingSubsystems?: string[];
}
