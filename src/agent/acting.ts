/**
 * Who an owner-only call acts for (design §8), as tools read it: the owner, or one of a group's OPERATORS
 * for a tool its policy delegates (policy.ts `operators`, `delegate`). The turn's boundary decides it
 * (agent/turn.ts `callAuthority`) and hands it to the turn's tools through `TurnState.acting`; a tool reads
 * it with `actingFor` when what it does depends on whom it acts for (the secrets a command gets) or when it
 * starts lasting work, whose row records who authorised it (`authorisation`).
 *
 * No imports: capabilities import this without importing the turn.
 */

export type Acting = { by: "owner" } | { by: "operator"; userId: number };

/** The part of a turn's state this reads (agent/turn.ts `TurnState.acting`). */
export interface ActingSource {
  acting?: (tool: string) => Acting | null;
}

/** Who a call of `tool` acts for now; null when it may not run. Outside a turn (a test calling a tool): the owner. */
export function actingFor(s: ActingSource, tool: string): Acting | null {
  return s.acting ? s.acting(tool) : { by: "owner" };
}

/**
 * The fields recording who authorised lasting work a call starts (a job's or a schedule's row): the owner, an
 * operator, or nobody (a call that was not allowed, which does not get this far).
 */
export function authorisation(acting: Acting | null): { ownerAuthorised: boolean; authorisedBy?: number } {
  if (acting?.by === "owner") return { ownerAuthorised: true };
  if (acting?.by === "operator") return { ownerAuthorised: false, authorisedBy: acting.userId };
  return { ownerAuthorised: false };
}
