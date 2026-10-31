import { describe, expect, it } from "vitest";
import {
  assertAllowed,
  cancellationCompensationPct,
  isWithinDisputeWindow,
  platformFee,
  splitPayout,
  TransitionError,
} from "../src/domain.js";

describe("fees", () => {
  it("takes 10% and pays the rest to the helper, matching the spec example", () => {
    expect(platformFee(2500)).toBe(250);
    expect(splitPayout(2500)).toEqual({ fee: 250, net: 2250 });
  });

  it("rounds to the nearest cent without losing money", () => {
    const { fee, net } = splitPayout(1005);
    expect(fee + net).toBe(1005);
    expect(fee).toBe(101);
  });
});

describe("cancellation compensation", () => {
  const base = { helperArrived: false, hoursNotice: 48, exception: false };
  it("pays nothing with more than 24 hours notice", () => {
    expect(cancellationCompensationPct(base)).toBe(0);
  });
  it("pays 25% between 4 and 24 hours", () => {
    expect(cancellationCompensationPct({ ...base, hoursNotice: 10 })).toBe(0.25);
  });
  it("pays 50% under 4 hours", () => {
    expect(cancellationCompensationPct({ ...base, hoursNotice: 1 })).toBe(0.5);
  });
  it("pays in full once the helper has arrived", () => {
    expect(cancellationCompensationPct({ ...base, helperArrived: true, hoursNotice: 100 })).toBe(1);
  });
  it("pays nothing when there is no scheduled time and no arrival", () => {
    expect(cancellationCompensationPct({ ...base, hoursNotice: null })).toBe(0);
  });
  it("waives compensation for a genuine emergency, even after arrival", () => {
    expect(cancellationCompensationPct({ helperArrived: true, hoursNotice: 0, exception: true })).toBe(0);
  });
});

describe("task state machine", () => {
  it("allows finishing only while in progress", () => {
    expect(() => assertAllowed("finish", "in_progress")).not.toThrow();
    expect(() => assertAllowed("finish", "open")).toThrow(TransitionError);
  });
  it("blocks cancelling a completed task", () => {
    expect(() => assertAllowed("cancel", "completed")).toThrow(TransitionError);
  });
  it("lets a replacement helper join a paused task", () => {
    expect(() => assertAllowed("accept", "continue_later")).not.toThrow();
  });
});

describe("dispute window", () => {
  const now = new Date("2026-10-31T12:00:00Z");
  it("allows disputes within 7 days", () => {
    expect(isWithinDisputeWindow(new Date("2026-10-27T12:00:00Z"), now)).toBe(true);
  });
  it("closes after 7 days", () => {
    expect(isWithinDisputeWindow(new Date("2026-10-20T12:00:00Z"), now)).toBe(false);
  });
});
