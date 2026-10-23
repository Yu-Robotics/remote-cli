import type { ExecutorGoal, ExecutorGoalRunRequest, ExecutorGoalStatus } from '../IExecutor';

const STATUSES: ExecutorGoalStatus[] = ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'];

export function validateGoalRequest(request: ExecutorGoalRunRequest): void {
  if (request.objective !== undefined && (typeof request.objective !== 'string'
    || !request.objective.trim() || Array.from(request.objective).length > 4000)) {
    throw new Error('A native goal objective must contain 1 to 4000 Unicode characters.');
  }
  if (request.tokenBudget !== undefined && (!Number.isSafeInteger(request.tokenBudget) || request.tokenBudget <= 0)) {
    throw new Error('A native goal token budget must be a positive safe integer.');
  }
}

export function parseNativeGoal(value: unknown, threadId: string): ExecutorGoal | null {
  if (value === null) return null;
  const goal = value as ExecutorGoal | undefined;
  if (!goal || goal.threadId !== threadId || typeof goal.objective !== 'string' || !goal.objective.trim()
    || !STATUSES.includes(goal.status)
    || !(goal.tokenBudget === null || (Number.isSafeInteger(goal.tokenBudget) && goal.tokenBudget >= 0))
    || !['tokensUsed', 'timeUsedSeconds', 'createdAt', 'updatedAt'].every(key => {
      const number = goal[key as keyof ExecutorGoal];
      return typeof number === 'number' && Number.isFinite(number) && number >= 0;
    })) throw new Error('Codex returned an invalid native goal state.');
  return { threadId: goal.threadId, objective: goal.objective, status: goal.status, tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed, timeUsedSeconds: goal.timeUsedSeconds, createdAt: goal.createdAt, updatedAt: goal.updatedAt };
}

export function assertNativeGoalsVersion(version: string | null | undefined): void {
  if (!version) return; // Older transports can prove support through the actual RPC response.
  const parsed = /^(\d+)\.(\d+)\.(\d+)([-+].*)?$/.exec(version);
  if (!parsed || Number(parsed[1]) === 0 && Number(parsed[2]) < 163
    || version.startsWith('0.163.0-')) {
    throw new Error('Native goals require a supported Codex build (0.163.0 or newer). Upgrade Codex first.');
  }
}

export function nativeGoalError(error: unknown): string {
  const value = error as { code?: number; message?: string } | null;
  const text = typeof value?.message === 'string' ? value.message : String(error);
  if (value?.code === -32601 || /method not found|goals?.*(?:disabled|not enabled)|(?:disabled|not enabled).*goals?/i.test(text)) {
    return 'Native Codex goals are unavailable. Upgrade Codex and enable its goals feature; no goal was simulated.';
  }
  return text;
}
