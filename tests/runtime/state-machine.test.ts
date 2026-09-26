import { describe, it, expect } from 'vitest';
import { StateMachine } from '../../src/runtime/state-machine.js';
import {
  ProjectState,
  PhaseState,
  TaskState,
} from '../../src/runtime/states.js';
import {
  PROJECT_TRANSITIONS,
  PHASE_TRANSITIONS,
  TASK_TRANSITIONS,
} from '../../src/runtime/transitions.js';

describe('StateMachine — project', () => {
  const sm = new StateMachine<ProjectState>('project', PROJECT_TRANSITIONS);

  it('allows CREATED → ANALYZING', () => {
    expect(sm.canTransition(ProjectState.CREATED, ProjectState.ANALYZING)).toBe(true);
  });

  it('allows RUNNING → COMPLETED', () => {
    expect(sm.canTransition(ProjectState.RUNNING, ProjectState.COMPLETED)).toBe(true);
  });

  it('allows FAILED → RUNNING', () => {
    expect(sm.canTransition(ProjectState.FAILED, ProjectState.RUNNING)).toBe(true);
  });

  it('allows RUNNING → FAILED', () => {
    expect(sm.canTransition(ProjectState.RUNNING, ProjectState.FAILED)).toBe(true);
  });

  it('allows ANALYZING → PLANNING', () => {
    expect(sm.canTransition(ProjectState.ANALYZING, ProjectState.PLANNING)).toBe(true);
  });

  it('disallows COMPLETED → anything', () => {
    for (const state of Object.values(ProjectState)) {
      if (state === ProjectState.COMPLETED) continue;
      expect(sm.canTransition(ProjectState.COMPLETED, state)).toBe(false);
    }
  });

  it('disallows CANCELLED → anything', () => {
    for (const state of Object.values(ProjectState)) {
      if (state === ProjectState.CANCELLED) continue;
      expect(sm.canTransition(ProjectState.CANCELLED, state)).toBe(false);
    }
  });

  it('throws on invalid transition', () => {
    expect(() => sm.validateTransition(ProjectState.COMPLETED, ProjectState.RUNNING)).toThrow();
    expect(() => sm.validateTransition(ProjectState.CREATED, ProjectState.COMPLETED)).toThrow();
  });

  it('returns allowed transitions', () => {
    const allowed = sm.allowedFrom(ProjectState.CREATED);
    expect(allowed).toContain(ProjectState.ANALYZING);
    expect(allowed).toContain(ProjectState.CANCELLED);
    expect(allowed.length).toBe(2);
  });
});

describe('StateMachine — phase', () => {
  const sm = new StateMachine<PhaseState>('phase', PHASE_TRANSITIONS);

  it('allows PENDING → READY', () => {
    expect(sm.canTransition(PhaseState.PENDING, PhaseState.READY)).toBe(true);
  });

  it('allows RUNNING → VERIFYING', () => {
    expect(sm.canTransition(PhaseState.RUNNING, PhaseState.VERIFYING)).toBe(true);
  });

  it('disallows RUNNING → PASSED (must go through VERIFYING)', () => {
    expect(sm.canTransition(PhaseState.RUNNING, PhaseState.PASSED)).toBe(false);
  });

  it('disallows PENDING → PASSED', () => {
    expect(sm.canTransition(PhaseState.PENDING, PhaseState.PASSED)).toBe(false);
  });

  it('disallows FAILED → PASSED without going through RECOVERING', () => {
    expect(sm.canTransition(PhaseState.FAILED, PhaseState.PASSED)).toBe(false);
  });

  it('allows FAILED → RECOVERING', () => {
    expect(sm.canTransition(PhaseState.FAILED, PhaseState.RECOVERING)).toBe(true);
  });

  it('allows RECOVERING → READY', () => {
    expect(sm.canTransition(PhaseState.RECOVERING, PhaseState.READY)).toBe(true);
  });

  it('allows VERIFYING → PASSED', () => {
    expect(sm.canTransition(PhaseState.VERIFYING, PhaseState.PASSED)).toBe(true);
  });

  it('disallows PASSED → anything', () => {
    for (const state of Object.values(PhaseState)) {
      if (state === PhaseState.PASSED) continue;
      expect(sm.canTransition(PhaseState.PASSED, state)).toBe(false);
    }
  });

  it('disallows CANCELLED → anything', () => {
    for (const state of Object.values(PhaseState)) {
      if (state === PhaseState.CANCELLED) continue;
      expect(sm.canTransition(PhaseState.CANCELLED, state)).toBe(false);
    }
  });

  it('disallows SKIPPED → anything', () => {
    for (const state of Object.values(PhaseState)) {
      if (state === PhaseState.SKIPPED) continue;
      expect(sm.canTransition(PhaseState.SKIPPED, state)).toBe(false);
    }
  });

  it('throws on invalid transition', () => {
    expect(() => sm.validateTransition(PhaseState.RUNNING, PhaseState.PASSED)).toThrow();
    expect(() => sm.validateTransition(PhaseState.PENDING, PhaseState.RUNNING)).toThrow();
    expect(() => sm.validateTransition(PhaseState.FAILED, PhaseState.PASSED)).toThrow();
  });
});

describe('StateMachine — task', () => {
  const sm = new StateMachine<TaskState>('task', TASK_TRANSITIONS);

  it('allows PENDING → READY', () => {
    expect(sm.canTransition(TaskState.PENDING, TaskState.READY)).toBe(true);
  });

  it('allows READY → RUNNING', () => {
    expect(sm.canTransition(TaskState.READY, TaskState.RUNNING)).toBe(true);
  });

  it('allows RUNNING → DONE', () => {
    expect(sm.canTransition(TaskState.RUNNING, TaskState.DONE)).toBe(true);
  });

  it('disallows PENDING → RUNNING (must go through READY)', () => {
    expect(sm.canTransition(TaskState.PENDING, TaskState.RUNNING)).toBe(false);
  });

  it('disallows DONE → anything', () => {
    for (const state of Object.values(TaskState)) {
      if (state === TaskState.DONE) continue;
      expect(sm.canTransition(TaskState.DONE, state)).toBe(false);
    }
  });

  it('disallows CANCELLED → anything', () => {
    for (const state of Object.values(TaskState)) {
      if (state === TaskState.CANCELLED) continue;
      expect(sm.canTransition(TaskState.CANCELLED, state)).toBe(false);
    }
  });

  it('allows FAILED → READY (retry)', () => {
    expect(sm.canTransition(TaskState.FAILED, TaskState.READY)).toBe(true);
  });

  it('throws on invalid transition', () => {
    expect(() => sm.validateTransition(TaskState.PENDING, TaskState.RUNNING)).toThrow();
    expect(() => sm.validateTransition(TaskState.DONE, TaskState.RUNNING)).toThrow();
  });
});

describe('StateMachine — complete graph coverage', () => {
  function checkAllStates(
    sm: StateMachine<string>,
    states: string[],
    _kind: string,
  ): void {
    for (const from of states) {
      const allowed = sm.allowedFrom(from as never);
      for (const to of states) {
        const can = sm.canTransition(from as never, to as never);
        if (allowed.includes(to as never)) {
          expect(can).toBe(true);
        } else {
          expect(can).toBe(false);
        }
      }
    }
  }

  it('covers all project states', () => {
    const sm = new StateMachine<ProjectState>('project', PROJECT_TRANSITIONS);
    checkAllStates(sm, Object.values(ProjectState), 'project');
  });

  it('covers all phase states', () => {
    const sm = new StateMachine<PhaseState>('phase', PHASE_TRANSITIONS);
    checkAllStates(sm, Object.values(PhaseState), 'phase');
  });

  it('covers all task states', () => {
    const sm = new StateMachine<TaskState>('task', TASK_TRANSITIONS);
    checkAllStates(sm, Object.values(TaskState), 'task');
  });
});
