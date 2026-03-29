import { Project } from '../types';

/**
 * RAGService
 * 
 * Implements lightweight client-side Retrieval-Augmented Generation (RAG) 
 * for the FMECA project data.
 * 
 * Future Upgrade: Replace `findRelevantChunks` logic with vector embeddings 
 * retrieval without changing the `retrieveContext` signature.
 */

interface Chunk {
    id: string;
    text: string;
    source: string; // e.g., "Subsystem: Pump"
    keywords: string[];
    type: 'project-header' | 'subsystem' | 'functional-failure' | 'failure-mode';
}

export const RAGService = {



    // Add inside RAGService object:

buildFunctionalFailureIndex(project: Project): string {
  const lines: string[] = [];
  project.subsystems.forEach(sub => {
    sub.failures.forEach(f => {
      lines.push(`[FF-${f.id}] Subsystem="${sub.name}" | Functional Failure="${f.desc}"`);
    });
  });
  return lines.join("\n");
},

buildFailureModeIndex(project: Project): string {
  const lines: string[] = [];
  project.subsystems.forEach(sub => {
    sub.failures.forEach(f => {
      f.modes.forEach(m => {
        const s = Number(m.rpn?.s) || 1;
        const o = Number(m.rpn?.o) || 1;
        const d = Number(m.rpn?.d) || 1;
        const rpn = s * o * d;

        lines.push(
          `[FM-${m.id}] Sub="${sub.name}" | FF="${f.desc}" | Mode="${m.mode}" | RPN=${rpn} (S${s} O${o} D${d})`
        );
      });
    });
  });
  return lines.join("\n");
},

buildProjectStructureIndex(project: Project): string {
  const subCount = project.subsystems?.length || 0;
  const ffCount = project.subsystems.reduce((a, s) => a + (s.failures?.length || 0), 0);
  const fmCount = project.subsystems.reduce((a, s) => a + (s.failures?.reduce((b, f) => b + (f.modes?.length || 0), 0) || 0), 0);

  return [
    `System: "${project.name}"`,
    `Subsystems: ${subCount}`,
    `Functional Failures: ${ffCount}`,
    `Failure Modes: ${fmCount}`,
    ``,
    `Subsystem list:`,
    ...(project.subsystems || []).map(s => `- ${s.name || "(unnamed)"}`)
  ].join("\n");
},

/**
 * Scoped retrieval used by the chatbot "level jump" planner.
 * This intentionally returns compact indexes (not raw JSON) to stay token-safe.
 */
retrieveByScope(
  scope: "topk" | "functional_failures" | "failure_modes" | "project_full",
  query: string,
  project: Project,
  limitTopK: number = 5
): string {
  if (!project) return "";

  switch (scope) {
    case "functional_failures":
      return [
        `FUNCTIONAL FAILURE INDEX (ALL)`,
        `---`,
        this.buildFunctionalFailureIndex(project)
      ].join("\n");

    case "failure_modes":
      return [
        `FAILURE MODE INDEX (ALL)`,
        `---`,
        this.buildFailureModeIndex(project)
      ].join("\n");

    case "project_full":
      // still NOT raw JSON; it's a compressed structure + full mode index
      return [
        `PROJECT STRUCTURE INDEX`,
        `---`,
        this.buildProjectStructureIndex(project),
        ``,
        `FAILURE MODE INDEX (ALL)`,
        `---`,
        this.buildFailureModeIndex(project)
      ].join("\n");

    case "topk":
    default:
      return this.retrieveContext(query, project, limitTopK);
  }
},

buildContextByPlan(plan: any, query: string, project: Project): string {
  if (!project) return "";

const HARD_CAP_CHARS = 200_000;

const strategyMode: string = plan?.strategy?.mode ?? "index_then_expand";

// 0 means "auto-size later"
let maxChars: number =
  typeof plan?.budget?.max_chars === "number"
    ? plan.budget.max_chars
    : 0;

  // If full_index, default to "everything that fits budget" unless planner set a limit.
  const topK: number =
  typeof plan?.strategy?.top_k === "number"
    ? plan.strategy.top_k
    : (strategyMode === "full_index" ? 999999 : 80);

  const expandK: number = typeof plan?.strategy?.expand_k === "number" ? plan.strategy.expand_k : 15;


  const include: Array<{ level: string; fields: string[]; within?: string }> =
  Array.isArray(plan?.include) ? plan.include : [];

// Self-heal: if planner under-specifies include, add a minimal safe default.
// Prevents "not mentioned in the project" due to missing retrieved level.
const hasInc = (lvl: string) => include.some(x => norm(x.level) === norm(lvl));

if (include.length === 0) {
  include.push({ level: "subsystem", fields: ["name"] });
  include.push({ level: "failure_mode", fields: ["subsystem", "functional_failure", "mode", "rpn"] });
}

// If user asks something that usually requires failure modes, ensure failure_mode is included.
const qLower = String(query || "").toLowerCase();
const needsFailureModes =
  qLower.includes("cause") ||
  qLower.includes("effect") ||
  qLower.includes("mitigation") ||
  qLower.includes("control") ||
  qLower.includes("failure mode") ||
  qLower.includes("mode") ||
  qLower.includes("rpn") ||
  qLower.includes("find") ||
  qLower.includes("where") ||
  qLower.includes("show") ||
  qLower.includes("locate") ||
  qLower.includes("trace");

if (needsFailureModes && !hasInc("failure_mode")) {
  include.push({
    level: "failure_mode",
    fields: ["subsystem", "functional_failure", "mode", "cause", "effect", "mitigation", "rpn"]
  });
}

  const norm = (s: string) => String(s || "").trim().toLowerCase().replace(/-/g, "_");
  const inc = (lvl: string) => include.find(x => norm(x.level) === norm(lvl));

// --- Auto budget sizing (based on actual project size + requested fields) ---
const countRows = (p: Project) => {
  let ff = 0, fm = 0;
  for (const sub of p.subsystems || []) {
    ff += (sub.failures || []).length;
    for (const f of sub.failures || []) fm += (f.modes || []).length;
  }
  return { ff, fm };
};

const estimateFFLineLen = (fields: string[]) => {
  const base = 30;
  const perField: Record<string, number> = { subsystem: 40, desc: 110 };
  return base + fields.reduce((a, f) => a + (perField[f] ?? 40), 0);
};

const estimateFMLineLen = (fields: string[]) => {
  const base = 40;
  const perField: Record<string, number> = {
    subsystem: 40,
    functional_failure: 80,
    mode: 90,
    cause: 120,
    effect: 120,
    mitigation: 120,
    rpn: 30
  };
  return base + fields.reduce((a, f) => a + (perField[f] ?? 40), 0);
};

const ffIncForBudget = inc("functional_failure");
const fmIncForBudget = inc("failure_mode");

const { ff: ffRows, fm: fmRows } = countRows(project);

const ffFieldsForBudget = ffIncForBudget?.fields || ["subsystem", "desc"];
const fmFieldsForBudget = fmIncForBudget?.fields || ["subsystem", "functional_failure", "mode", "rpn"];

const estimatedNeed =
  (ffIncForBudget ? ("FUNCTIONAL FAILURES:\n".length + ffRows * estimateFFLineLen(ffFieldsForBudget)) : 0) +
  (fmIncForBudget ? ("FAILURE MODES:\n".length + fmRows * estimateFMLineLen(fmFieldsForBudget)) : 0) +
  2000; // outline/header slack

// If planner didn't set budget, auto-size; always clamp to HARD_CAP_CHARS
maxChars = Math.min(maxChars > 0 ? maxChars : estimatedNeed, HARD_CAP_CHARS);



  const filters = plan?.filters || {};
  const filterSubsystems: string[] = Array.isArray(filters.subsystems) ? filters.subsystems.map((s: string) => String(s).toLowerCase()) : [];
  const terms: string[] = Array.isArray(filters.terms) ? filters.terms.map((t: string) => String(t).trim()).filter((t: string) => t.length > 0) : [];
  if (terms.length === 0 && query) {
  const auto = query.split(/\s+/).map(w => w.trim()).filter(w => w.length > 2);
  // keep it small to avoid accidental over-filtering
  terms.push(...auto.slice(0, 8));
}
  const rpnMin: number | null = (typeof filters.rpn_min === "number") ? filters.rpn_min : null;
  // Only enforce term filtering if planner explicitly provided terms
  const enforceTermFilter =
    Array.isArray(filters.terms) && filters.terms.length > 0;
    
  const safe = (x: any, fallback = "N/A") => {
    const s = String(x ?? "").trim();
    return s.length ? s : fallback;
  };

  const subsystemOk = (name: string) => {
    if (!filterSubsystems.length) return true;
    const n = (name || "").toLowerCase();
    return filterSubsystems.some(s => n.includes(s));
  };

  const termScore = (text: string) => {
    if (!terms.length) return 0;
    const t = text.toLowerCase();
    let score = 0;
    for (const k of terms) if (k && t.includes(k.toLowerCase())) score++;
    return score;
  };

  const lines: string[] = [];
  const push = (s: string) => {
    if (!s) return;
    const nextLen = lines.join("\n").length + s.length + 1;
    if (nextLen <= maxChars) lines.push(s);
  };

  // ---- Project header ----
  const ph = inc("project_header");
  if (ph) {
    const f = ph.fields || [];
    const parts: string[] = [];
    if (f.includes("name")) parts.push(`System Name: "${safe(project.name, "Unnamed")}"`);
    if (f.includes("desc")) parts.push(`Description: ${safe((project as any).desc)}`);
    if (f.includes("updated")) parts.push(`Last Updated: ${safe((project as any).updated)}`);
    push(parts.join(" | "));
    push("---");
  }

// ---- Subsystems + FF + FM collections ----
type FMRow = { sub: any; ff: any; fm: any; rpn: number; score: number };

// Always-accurate counts (compact, budget-safe)
const ffCountsBySubsystem = (project.subsystems || []).map(s => ({
  name: s.name || "(unnamed)",
  ffCount: (s.failures || []).length
}));


  const subs: any[] = [];
  const ffs: Array<{ sub: any; ff: any; score: number }> = [];
  const fms: FMRow[] = [];

  (project.subsystems || []).forEach(sub => {
    if (!subsystemOk(sub.name || "")) return;
    subs.push(sub);

    (sub.failures || []).forEach((ff: any) => {
      const ffText = `${sub.name} ${ff.desc} ${sub.func} ${sub.specs}`;
      const ffScore = termScore(ffText);
      ffs.push({ sub, ff, score: ffScore });

      (ff.modes || []).forEach((fm: any) => {
        const s = Number(fm?.rpn?.s) || 1;
        const o = Number(fm?.rpn?.o) || 1;
        const d = Number(fm?.rpn?.d) || 1;
        const rpn = s * o * d;

        if (typeof rpnMin === "number" && rpn < rpnMin) return;

        const fmText = `${sub.name} ${ff.desc} ${fm.mode} ${fm.cause} ${fm.effect} ${fm.mitigation} RPN ${rpn}`;
        const score = termScore(fmText);


        // Only filter by terms if planner explicitly requested it
        if (enforceTermFilter && terms.length > 0 && score === 0) return;


        fms.push({ sub, ff, fm, rpn, score });
      });
    });
  });

  // Sort modes: term score then RPN (good default)
  fms.sort((a, b) => (b.score - a.score) || (b.rpn - a.rpn));


  // ---- Render helpers by level+fields ----
  const fmtSubsystem = (sub: any, fields: string[]) => {
    const parts: string[] = [];
    if (fields.includes("name")) parts.push(`Subsystem="${safe(sub.name, "(unnamed)")}"`);
    if (fields.includes("func")) parts.push(`Function="${safe(sub.func)}"`);
    if (fields.includes("specs")) parts.push(`Specs="${safe(sub.specs)}"`);
    return parts.join(" | ");
  };

  const fmtFF = (sub: any, ff: any, fields: string[]) => {
    const parts: string[] = [];
    if (fields.includes("subsystem")) parts.push(`Sub="${safe(sub.name, "(unnamed)")}"`);
    if (fields.includes("desc")) parts.push(`FF="${safe(ff.desc)}"`);
    return parts.join(" | ");
  };

  const fmtFM = (sub: any, ff: any, fm: any, fields: string[]) => {
    const s = Number(fm?.rpn?.s) || 1;
    const o = Number(fm?.rpn?.o) || 1;
    const d = Number(fm?.rpn?.d) || 1;
    const total = s * o * d;

    const parts: string[] = [];
    if (fields.includes("subsystem")) parts.push(`Sub="${safe(sub.name, "(unnamed)")}"`);
    if (fields.includes("functional_failure")) parts.push(`FF="${safe(ff.desc)}"`);
    if (fields.includes("mode")) parts.push(`Mode="${safe(fm.mode)}"`);
    if (fields.includes("effect")) parts.push(`Effect="${safe(fm.effect)}"`);
    if (fields.includes("cause")) parts.push(`Cause="${safe(fm.cause)}"`);
    if (fields.includes("mitigation")) parts.push(`Mitigation="${safe(fm.mitigation)}"`);
    if (fields.includes("rpn")) parts.push(`RPN=${total} (S${s} O${o} D${d})`);
    return parts.join(" | ");
  };

  // ---- Output by include[] ----
  const subInc = inc("subsystem");
  if (subInc) {
    push("SUBSYSTEMS:");
    (subs || []).forEach(sub => push(fmtSubsystem(sub, subInc.fields || ["name"])));
    push("---");
  }

const ffInc = inc("functional_failure");
if (ffInc) {
  // Budget-safe summary so counting is always correct even if the list truncates
  push("FUNCTIONAL FAILURES COUNT BY SUBSYSTEM:");
  ffCountsBySubsystem.forEach(x => push(`- ${x.name}: ${x.ffCount}`));
  push("---");

  push("FUNCTIONAL FAILURES:");
  }

  const fmInc = inc("failure_mode");
  if (fmInc) {
    const fields = fmInc.fields || ["subsystem", "functional_failure", "mode", "rpn"];

    if (strategyMode === "full_index") {
      push("FAILURE MODES (FULL INDEX):");
      fms.slice(0, topK).forEach(x => push(fmtFM(x.sub, x.ff, x.fm, fields)));
    } else if (strategyMode === "index_then_expand") {
      push("FAILURE MODES (INDEX):");
      fms.slice(0, topK).forEach(x => push(fmtFM(x.sub, x.ff, x.fm, fields)));

      const wantsDetails = fields.some(f => f === "cause" || f === "effect" || f === "mitigation");
      if (wantsDetails) {
        push("---");
        push(`FAILURE MODES (EXPANDED TOP ${expandK}):`);
        fms.slice(0, expandK).forEach(x => push(fmtFM(x.sub, x.ff, x.fm, fields)));
      }
    } else {
      push("FAILURE MODES (TOPK):");
      fms.slice(0, 10).forEach(x => push(fmtFM(x.sub, x.ff, x.fm, fields)));
    }
  }

  return lines.join("\n").trim();
},


    /**
     * Converts the project structure into text chunks for retrieval.
     */
    chunkProject(project: Project): Chunk[] {
        const chunks: Chunk[] = [];

        // 1. Project Level Context
        chunks.push({
            id: 'proj-header',
            text: `System Name: ${project.name}. Description: ${project.desc || 'N/A'}. Last Updated: ${project.updated}.`,
            source: 'Project Header',
            keywords: [project.name, 'system', 'context'],
            type: 'project-header'
        });

        // 2. Subsystem Level Context
        project.subsystems.forEach(sub => {
            const subText = `Subsystem: ${sub.name}. Specs: ${sub.specs || 'N/A'}. Function: ${sub.func || 'N/A'}.`;
            chunks.push({
                id: `sub-${sub.id}`,
                text: subText,
                source: `Subsystem: ${sub.name}`,
                keywords: [sub.name, 'specs', 'function'],
                type: 'subsystem'
            });

            // 3. Functional Failure Level
            sub.failures.forEach(fail => {
                const failText = `Subsystem: ${sub.name}. Functional Failure: ${fail.desc}. Function: ${sub.func || 'N/A'}.`;
                chunks.push({
                    id: `fail-${fail.id}`,
                    text: failText,
                    source: `Functional Failure in ${sub.name}`,
                    keywords: [sub.name, fail.desc, 'functional failure'],
                    type: 'functional-failure'
                });

                // 4. Failure Mode Level
                fail.modes.forEach(mode => {
                    const rpnVal = (Number(mode.rpn.s)||1)*(Number(mode.rpn.o)||1)*(Number(mode.rpn.d)||1);
                    const modeText = `Subsystem: ${sub.name}. Functional Failure: ${fail.desc}. Failure Mode: ${mode.mode}. Effect: ${mode.effect || 'N/A'}. Cause: ${mode.cause || 'N/A'}. Mitigation/Control: ${mode.mitigation || 'N/A'}. RPN: S=${mode.rpn.s}, O=${mode.rpn.o}, D=${mode.rpn.d}, Total=${rpnVal}.`;
                    
                    chunks.push({
                        id: `mode-${mode.id}`,
                        text: modeText,
                        source: `Failure Mode in ${sub.name}`,
                        keywords: [sub.name, fail.desc, mode.mode, mode.cause, mode.effect, mode.mitigation, 'failure mode', 'rpn', 'risk'],
                        type: 'failure-mode'
                    });
                });
            });
        });

        return chunks;
    },

    /**
     * Retrieves the most relevant context strings for a given query.
     */
    retrieveContext(query: string, project: Project | null, limit: number = 5): string {
        if (!project) return "";
        
        let chunks = this.chunkProject(project);
        const queryTerms = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        const queryLower = query.toLowerCase();

        if (queryTerms.length === 0) return chunks.slice(0, 3).map(c => c.text).join("\n");

        // DETECT FUNCTIONAL FAILURE LIST QUERY
        // Logic: Query asks for "functional failure" but NOT specific mode/cause/effect details.
        const detailKeywords = ['mode', 'cause', 'root', 'effect', 'consequence', 'mitigation', 'action', 'control', 'task', 'rpn', 'risk', 'severity', 'occurrence', 'detection', 's=', 'o=', 'd='];
        const isFFQuery = queryLower.includes('functional') && 
                          queryLower.includes('failure') && 
                          !detailKeywords.some(k => queryLower.includes(k));

        if (isFFQuery) {
            // Strictly filter to functional-failure chunks to prevent duplicates/mode-noise
            chunks = chunks.filter(c => c.type === 'functional-failure');
            // Increase limit to capture complete list (default 5 might be too small for a list)
            limit = Math.max(limit, 15);
        }

        // Simple scoring based on keyword overlap
        const scored = chunks.map(chunk => {
            const textLower = chunk.text.toLowerCase();
            let score = 0;
            
            // Base score: keyword frequency
            queryTerms.forEach(term => {
                if (textLower.includes(term)) score += 1;
            });

            // Contextual boosting
            if (score > 0) {
                // Boost Functional Failure chunks if explicitly asked
                if (queryLower.includes('functional failure') && textLower.includes('functional failure:')) score += 3;
                
                // Boost Mode chunks if explicitly asked
                if ((queryLower.includes('failure mode') || queryLower.includes('mode')) && textLower.includes('failure mode:')) score += 3;

                // Boost Cause chunks
                if (queryLower.includes('cause') && textLower.includes('cause:')) score += 3;

                // Boost Effect chunks
                if (queryLower.includes('effect') && textLower.includes('effect:')) score += 3;

                // Boost Mitigation/Control chunks
                if ((queryLower.includes('mitigation') || queryLower.includes('control')) && 
                    (textLower.includes('mitigation') || textLower.includes('control'))) score += 3;
                
                // Boost RPN/Detection chunks
                if ((queryLower.includes('rpn') || queryLower.includes('severity') || queryLower.includes('occurrence') || queryLower.includes('detection')) && 
                    (textLower.includes('rpn:') || textLower.includes('d='))) score += 3;
            }

            return { ...chunk, score };
        });

        // Sort by score desc, take top N
        scored.sort((a, b) => b.score - a.score);
        
        const topChunks = scored.filter(c => c.score > 0).slice(0, limit);
        
        // If no matches found, return generic project info
        if (topChunks.length === 0) {
            return this.chunkProject(project).find(c => c.id === 'proj-header')?.text || "";
        }

        return topChunks.map(c => `[Source: ${c.source}]\n${c.text}`).join("\n\n");
    }
};