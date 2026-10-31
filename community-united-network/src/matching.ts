/**
 * Ranks people and tasks against each other. Results are suggestions only:
 * callers should always return the full eligible list so users can browse,
 * search, and filter past the top matches.
 */

export interface HelperProfile {
  id: string;
  roleMode: "need_help" | "can_help" | "both";
  verified: boolean;
  zip: string;
  city: string;
  skills: string[];
  tools: string[];
}

export interface TaskProfile {
  requesterId: string;
  zip: string;
  city: string;
  requiredSkills: string[];
  toolsNeeded: string[];
}

export interface MatchResult {
  score: number;
  reasons: string[];
  eligible: boolean;
}

const overlap = (a: string[], b: string[]) => {
  const set = new Set(a.map((s) => s.toLowerCase()));
  return b.filter((x) => set.has(x.toLowerCase()));
};

export function scoreHelperForTask(task: TaskProfile, helper: HelperProfile): MatchResult {
  const reasons: string[] = [];

  if (helper.id === task.requesterId) return { score: 0, reasons: ["Requester"], eligible: false };
  if (helper.roleMode === "need_help") {
    return { score: 0, reasons: ["Not signed up to help"], eligible: false };
  }

  let score = 0;

  const skillHits = overlap(helper.skills, task.requiredSkills);
  if (skillHits.length) {
    score += skillHits.length * 3;
    reasons.push(`Skills: ${skillHits.join(", ")}`);
  }

  const toolHits = overlap(helper.tools, task.toolsNeeded);
  if (toolHits.length) {
    score += toolHits.length * 2;
    reasons.push(`Has tools: ${toolHits.join(", ")}`);
  }

  if (helper.zip && helper.zip === task.zip) {
    score += 3;
    reasons.push("Same ZIP code");
  } else if (helper.city && helper.city.toLowerCase() === task.city.toLowerCase()) {
    score += 2;
    reasons.push("Same city");
  }

  if (helper.verified) {
    score += 1;
    reasons.push("Identity verified");
  }

  return { score, reasons, eligible: true };
}

/** Sorts results best-first. Ineligible entries are dropped. */
export function rankHelpers(
  task: TaskProfile,
  helpers: HelperProfile[],
): Array<{ helper: HelperProfile } & MatchResult> {
  return helpers
    .map((helper) => ({ helper, ...scoreHelperForTask(task, helper) }))
    .filter((r) => r.eligible)
    .sort((a, b) => b.score - a.score);
}
