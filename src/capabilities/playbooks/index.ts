import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { err, ok, type ToolDef } from "agent-runtime";
import { listPlaybooks, PLAYBOOK_NAME } from "../../agent/playbooks.ts";
import { defineCapability } from "../types.ts";

/**
 * Playbooks: `read_playbook`, which reads one of `home/playbooks/<name>.md` in full. The index of them is
 * not this capability's section: it is a fixed slot of the system prompt (agent/prompt.ts, rendered from
 * agent/playbooks.ts) after every capability section, shown while this capability is on. Playbooks are
 * written with memory's `edit_home`.
 *
 *   SHUVI_PLAYBOOKS   "off" disables this capability, and with it the index (default on)
 */

export const playbooks = defineCapability<true>({
  id: "playbooks",
  enable: (env) => (env.SHUVI_PLAYBOOKS === "off" ? null : true),
  tools({ home }) {
    const read: ToolDef<{ name: string }> = {
      name: "read_playbook",
      description: "Read one of your playbooks in full, by the name the Playbooks list gives.",
      inputSchema: { name: z.string().describe("The playbook's name, without .md") },
      async handler({ name }) {
        const n = name.replace(/\.md$/, "");
        const book = PLAYBOOK_NAME.test(n) ? listPlaybooks(home).find((b) => b.name === n) : undefined;
        if (!book) {
          const names = listPlaybooks(home).map((b) => b.name);
          return err(`There is no playbook "${name}". ${names.length ? `There are: ${names.join(", ")}.` : "There are none yet."}`);
        }
        return ok(readFileSync(join(home, "playbooks", `${n}.md`), "utf8"));
      },
    };
    return [{ serverName: "shuvi", tools: [read] as ToolDef[] }];
  },
});
