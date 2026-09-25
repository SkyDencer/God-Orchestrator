export class StateMachine<T extends string> {
  private readonly transitions: Map<T, T[]>;

  constructor(
    private readonly kind: string,
    transitions: ReadonlyMap<T, T[]>,
  ) {
    this.transitions = new Map(transitions);
  }

  /**
   * Check whether a transition from `from` to `to` is allowed.
   */
  canTransition(from: T, to: T): boolean {
    const allowed = this.allowedFrom(from);
    return allowed.includes(to);
  }

  /**
   * Validate a transition. Throws if the transition is not allowed.
   */
  validateTransition(from: T, to: T): void {
    if (!this.canTransition(from, to)) {
      throw new Error(
        `Invalid transition from ${from} to ${to} (kind: ${this.kind})`,
      );
    }
  }

  /**
   * Get all states that can be reached from `from`.
   */
  allowedFrom(from: T): T[] {
    return this.transitions.get(from) ?? [];
  }

  /**
   * Perform a transition: validate then return `to`.
   */
  transition(from: T, to: T): T {
    this.validateTransition(from, to);
    return to;
  }
}
