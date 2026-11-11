import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Playbooks: how to do one particular thing, in full, in `home/playbooks/<name>.md` (docs/design.md §6,
 * layer 5). The system prompt carries only an index (agent/prompt.ts renders it in its fixed slot, after
 * every capability section and before private memory): one line per playbook, its name and the file's
 * first line, which says when to use it. The playbooks capability's `read_playbook` reads one in full.
 */

/** A playbook's name: its file name without `.md`. */
export const PLAYBOOK_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface Playbook {
  name: string;
  /** The file's first line, without a heading's #s: when to use it. */
  when: string;
}

/** The playbooks in `home/playbooks/`, by name. Empty files and other names are not playbooks. */
export function listPlaybooks(home: string): Playbook[] {
  const dir = join(home, "playbooks");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && PLAYBOOK_NAME.test(f.slice(0, -3)))
    .sort()
    .flatMap((f) => {
      const text = readFileSync(join(dir, f), "utf8");
      if (!text.trim()) return [];
      const first = text.split("\n").find((l) => l.trim())!.replace(/^#+\s*/, "").trim();
      return [{ name: f.slice(0, -3), when: first.length > 200 ? `${first.slice(0, 199)}…` : first }];
    });
}

/** The prompt's playbook index, or null when there are none (an empty or missing folder adds nothing). */
export function playbookIndex(home: string): string | null {
  const books = listPlaybooks(home);
  if (!books.length) return null;
  return `## Playbooks

How-tos you have written down. When what you are about to do matches one, read it with \`read_playbook\` first and follow it.

${books.map((b) => `- \`${b.name}\`: ${b.when}`).join("\n")}`;
}
