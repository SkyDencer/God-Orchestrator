import { ProjectState, PhaseState, TaskState } from './states.js';

type StateMachineKind = 'project' | 'phase' | 'task';

/**
 * Allowed transitions: Map<FromState, State[]>
 */
export const PROJECT_TRANSITIONS: Map<ProjectState, ProjectState[]> = new Map([
  [ProjectState.CREATED, [
    ProjectState.ANALYZING,
    ProjectState.CANCELLED,
  ]],
  [ProjectState.ANALYZING, [
    ProjectState.PLANNING,
    ProjectState.BLOCKED,
    ProjectState.FAILED,
    ProjectState.CANCELLED,
  ]],
  [ProjectState.PLANNING, [
    ProjectState.VALIDATING_PLAN,
    ProjectState.BLOCKED,
    ProjectState.FAILED,
    ProjectState.CANCELLED,
  ]],
  [ProjectState.VALIDATING_PLAN, [
    ProjectState.READY,
    ProjectState.PLANNING,
    ProjectState.BLOCKED,
    ProjectState.FAILED,
    ProjectState.CANCELLED,
  ]],
  [ProjectState.READY, [
    ProjectState.RUNNING,
    ProjectState.PAUSED,
    ProjectState.BLOCKED,
    ProjectState.CANCELLED,
  ]],
  [ProjectState.RUNNING, [
    ProjectState.PAUSED,
    ProjectState.BLOCKED,
    ProjectState.COMPLETED,
    ProjectState.FAILED,
    ProjectState.CANCELLED,
  ]],
  [ProjectState.PAUSED, [
    ProjectState.RUNNING,
    ProjectState.BLOCKED,
    ProjectState.FAILED,
    ProjectState.CANCELLED,
  ]],
  [ProjectState.BLOCKED, [
    ProjectState.PLANNING,
    ProjectState.ANALYZING,
    ProjectState.READY,
    ProjectState.FAILED,
    ProjectState.CANCELLED,
  ]],
  [ProjectState.COMPLETED, []],
  [ProjectState.FAILED, [
    ProjectState.ANALYZING,
    ProjectState.PLANNING,
    ProjectState.VALIDATING_PLAN,
    ProjectState.READY,
    ProjectState.RUNNING,
    ProjectState.CANCELLED,
  ]],
  [ProjectState.CANCELLED, []],
]);

export const PHASE_TRANSITIONS: Map<PhaseState, PhaseState[]> = new Map([
  [PhaseState.PENDING, [
    PhaseState.READY,
    PhaseState.SKIPPED,
    PhaseState.CANCELLED,
  ]],
  [PhaseState.READY, [
    PhaseState.RUNNING,
    PhaseState.SKIPPED,
    PhaseState.CANCELLED,
    PhaseState.BLOCKED,
  ]],
  [PhaseState.RUNNING, [
    PhaseState.VERIFYING,
    PhaseState.BLOCKED,
    PhaseState.FAILED,
    PhaseState.CANCELLED,
  ]],
  [PhaseState.VERIFYING, [
    PhaseState.PASSED,
    PhaseState.RUNNING,
    PhaseState.FAILED,
    PhaseState.CANCELLED,
  ]],
  [PhaseState.PASSED, []],
  [PhaseState.FAILED, [
    PhaseState.RECOVERING,
    PhaseState.CANCELLED,
  ]],
  [PhaseState.RECOVERING, [
    PhaseState.READY,
    PhaseState.PENDING,
    PhaseState.FAILED,
    PhaseState.SKIPPED,
    PhaseState.CANCELLED,
  ]],
  [PhaseState.WAITING_APPROVAL, [
    PhaseState.READY,
    PhaseState.BLOCKED,
    PhaseState.FAILED,
    PhaseState.CANCELLED,
  ]],
  [PhaseState.BLOCKED, [
    PhaseState.READY,
    PhaseState.PENDING,
    PhaseState.WAITING_APPROVAL,
    PhaseState.FAILED,
    PhaseState.SKIPPED,
    PhaseState.CANCELLED,
  ]],
  [PhaseState.SKIPPED, []],
  [PhaseState.CANCELLED, []],
]);

export const TASK_TRANSITIONS: Map<TaskState, TaskState[]> = new Map([
  [TaskState.PENDING, [
    TaskState.READY,
    TaskState.CANCELLED,
  ]],
  [TaskState.READY, [
    TaskState.RUNNING,
    TaskState.BLOCKED,
    TaskState.CANCELLED,
  ]],
  [TaskState.RUNNING, [
    TaskState.DONE,
    TaskState.FAILED,
    TaskState.BLOCKED,
    TaskState.CANCELLED,
  ]],
  [TaskState.DONE, []],
  [TaskState.FAILED, [
    TaskState.READY,
    TaskState.CANCELLED,
  ]],
  [TaskState.BLOCKED, [
    TaskState.READY,
    TaskState.CANCELLED,
  ]],
  [TaskState.CANCELLED, []],
]);

/**
 * Check if a transition is allowed.
 * Critical forbidden rules are enforced:
 * - RUNNING → PASSED is FORBIDDEN (must go through VERIFYING)
 * - PENDING → PASSED is FORBIDDEN
 * - FAILED → PASSED is FORBIDDEN without RECOVERING
 * - PENDING → RUNNING is FORBIDDEN (must go through READY)
 */
export function canTransition(
  from: string,
  to: string,
  kind: StateMachineKind,
): boolean {
  const transitions = getTransitions(kind);
  const allowed = transitions.get(from as never);
  if (!allowed) return false;
  return allowed.includes(to as never);
}

export function getAllowedTransitions(
  from: string,
  kind: StateMachineKind,
): string[] {
  const transitions = getTransitions(kind);
  return transitions.get(from as never) ?? [];
}

function getTransitions(kind: StateMachineKind): Map<string, string[]> {
  switch (kind) {
    case 'project':
      return PROJECT_TRANSITIONS as Map<string, string[]>;
    case 'phase':
      return PHASE_TRANSITIONS as Map<string, string[]>;
    case 'task':
      return TASK_TRANSITIONS as Map<string, string[]>;
  }
}
