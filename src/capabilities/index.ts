import { jobs } from "./jobs/index.ts";
import { schedules } from "./schedules/index.ts";
import { speech } from "./speech/index.ts";
import { enableCapabilities, type Capability, type EnabledCapability, type Env } from "./types.ts";
import { vision } from "./vision/index.ts";
import { web } from "./web/index.ts";
import { workstream } from "./workstream/index.ts";

/**
 * The registry: every capability, in order. The order is part of the prompt-cache prefix, so append new
 * capabilities at the end rather than in the middle. Speech stays first. It decides:
 *   - the order of the capability sections of the system prompt (docs/design.md §6): registry order;
 *   - the order of the turn's tools (types.ts `capabilityTools`): grouped by MCP server, servers in the
 *     order each first appears here, and within a server, tools in registry order.
 *
 * Adding a capability is a folder `src/capabilities/<id>/` and one line here (see AGENTS.md).
 */
export const CAPABILITIES: readonly Capability<any>[] = [
  speech,
  web,
  vision,
  jobs,
  schedules,
  workstream,
];

/** The capabilities enabled in this process, in registry order. */
export function enabledCapabilities(env: Env = process.env): EnabledCapability[] {
  return enableCapabilities(CAPABILITIES, env);
}
