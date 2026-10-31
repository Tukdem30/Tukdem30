import { config } from "./config.js";

export const TASK_STATUSES = [
  "open",
  "accepted",
  "in_progress",
  "awaiting_confirmation",
  "continue_later",
  "paused_safety",
  "completed",
  "partially_completed",
  "cancelled",
  "disputed",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TERMINAL_STATUSES: readonly TaskStatus[] = ["completed", "partially_completed", "cancelled"];

export type TaskAction =
  | "accept"
  | "withdraw"
  | "start"
  | "finish"
  | "confirm"
  | "cancel"
  | "report_safety"
  | "dispute"
  | "resolve";

/** Which statuses each action is allowed from. Enforced in the services layer. */
export const ACTION_FROM: Record<TaskAction, readonly TaskStatus[]> = {
  accept: ["open", "continue_later"],
  withdraw: ["accepted", "in_progress", "continue_later"],
  start: ["accepted", "continue_later"],
  finish: ["in_progress"],
  confirm: ["awaiting_confirmation"],
  cancel: ["open", "accepted", "in_progress", "continue_later"],
  report_safety: ["accepted", "in_progress", "continue_later", "awaiting_confirmation"],
  dispute: ["awaiting_confirmation", "completed", "partially_completed"],
  resolve: ["paused_safety", "disputed"],
};

export function assertAllowed(action: TaskAction, status: TaskStatus): void {
  if (!ACTION_FROM[action].includes(status)) {
    throw new TransitionError(`Cannot ${action} a task that is ${status}`);
  }
}

export class TransitionError extends Error {}

export const OUTCOMES = ["completed", "partially_completed", "continue_later"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Terminal outcome a resolver (admin) can force on a paused or disputed task. */
export const RESOLVE_OUTCOMES = ["completed", "partially_completed", "cancelled", "in_progress"] as const;

/** Platform fee on a gross amount, rounded to the nearest cent. */
export function platformFee(grossCents: number): number {
  return Math.round((grossCents * config.platformFeeBps) / 10_000);
}

export function splitPayout(grossCents: number): { fee: number; net: number } {
  const fee = platformFee(grossCents);
  return { fee, net: grossCents - fee };
}

/**
 * Share of a helper's agreed rate owed when the requester cancels.
 * - Helper already arrived: full pay.
 * - Under 4 hours' notice: 50%.
 * - 4 to 24 hours' notice: 25%.
 * - More than 24 hours' notice, or no scheduled time: nothing.
 * - Genuine emergency, safety issue, or severe weather exception: nothing.
 */
export function cancellationCompensationPct(input: {
  helperArrived: boolean;
  hoursNotice: number | null;
  exception: boolean;
}): number {
  if (input.exception) return 0;
  if (input.helperArrived) return 1;
  if (input.hoursNotice === null) return 0;
  if (input.hoursNotice < 4) return 0.5;
  if (input.hoursNotice < 24) return 0.25;
  return 0;
}

/** Splits an earned total equally between helpers, rounding down to whole cents. */
export function evenShares(totalCents: number, helperCount: number): number {
  if (helperCount <= 0) return 0;
  return Math.floor(totalCents / helperCount);
}

export function isWithinDisputeWindow(completedAt: Date, now: Date = new Date()): boolean {
  const ms = now.getTime() - completedAt.getTime();
  return ms >= 0 && ms <= config.disputeWindowDays * 24 * 60 * 60 * 1000;
}
