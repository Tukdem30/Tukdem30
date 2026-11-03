import { describe, expect, it } from "vitest";
import { rankHelpers, scoreHelperForTask, type HelperProfile, type TaskProfile } from "../src/matching.js";

const task: TaskProfile = {
  requesterId: "req",
  zip: "80903",
  city: "Colorado Springs",
  requiredSkills: ["plumbing"],
  toolsNeeded: ["ladder"],
};

const helper = (over: Partial<HelperProfile>): HelperProfile => ({
  id: "h",
  roleMode: "can_help",
  verified: true,
  zip: "80903",
  city: "Colorado Springs",
  skills: [],
  tools: [],
  ...over,
});

describe("matching", () => {
  it("never suggests the requester to themselves", () => {
    expect(scoreHelperForTask(task, helper({ id: "req" })).eligible).toBe(false);
  });

  it("excludes people who only need help", () => {
    expect(scoreHelperForTask(task, helper({ roleMode: "need_help" })).eligible).toBe(false);
  });

  it("ranks skill and tool matches above location alone", () => {
    const skilled = helper({ id: "a", skills: ["Plumbing"], tools: ["Ladder"], zip: "00000", city: "Elsewhere" });
    const nearby = helper({ id: "b" });
    const ranked = rankHelpers(task, [nearby, skilled]);
    expect(ranked[0].helper.id).toBe("a");
    expect(ranked[0].reasons).toContain("Skills: plumbing");
  });

  it("keeps every eligible helper, so users are never limited to the top match", () => {
    const people = [helper({ id: "a" }), helper({ id: "b", zip: "99999", city: "X" }), helper({ id: "c", roleMode: "need_help" })];
    expect(rankHelpers(task, people)).toHaveLength(2);
  });
});
