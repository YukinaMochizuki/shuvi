import { speech } from "./speech/index.ts";
import { enableCapabilities, type Capability, type EnabledCapability, type Env } from "./types.ts";
import { vision } from "./vision/index.ts";
import { web } from "./web/index.ts";

/**
 * The registry: every capability, in order. The order is the order of the turn's tools and of the
 * capability sections of the system prompt (docs/design.md §6), so it is part of the prompt-cache prefix:
 * append new capabilities at the end rather than in the middle. Speech stays first.
 *
 * Adding a capability is a folder `src/capabilities/<id>/` and one line here (see AGENTS.md).
 */
export const CAPABILITIES: readonly Capability<any>[] = [
  speech,
  web,
  vision,
];

/** The capabilities enabled in this process, in registry order. */
export function enabledCapabilities(env: Env = process.env): EnabledCapability[] {
  return enableCapabilities(CAPABILITIES, env);
}
