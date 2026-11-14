import { layersOf, PLAYBOOK_NAME, type HomeLayers } from "../capabilities/memory/layers.ts";

/**
 * Playbooks: how to do one particular thing, in full, in `home/playbooks/<name>.md` (docs/design.md §6,
 * layer 5). The system prompt carries only an index (agent/prompt.ts renders it in its fixed slot, after
 * every capability section and before private memory): one line per playbook, its name and the file's
 * first line, which says when to use it. The playbooks capability's `read_playbook` reads one in full.
 *
 * Which playbooks there are is the chat's layers' (capabilities/memory/layers.ts): the base's, minus those its
 * profile hides, with the profile's own replacing or adding to them.
 */

/** A playbook's name: its file name without `.md`. */
export { PLAYBOOK_NAME };

export interface Playbook {
  name: string;
  /** The file's first line, without a heading's #s: when to use it. */
  when: string;
  /** Whose copy is in effect (for the console; never shown to her). */
  from: "base" | "profile";
}

/** The playbooks in effect, by name. Empty files and other names are not playbooks. */
export function listPlaybooks(home: string | HomeLayers): Playbook[] {
  const layers = layersOf(home);
  return layers.playbookFiles().flatMap((f) => {
    const text = layers.read(f.logical) ?? "";
    if (!text.trim()) return [];
    const first = text.split("\n").find((l) => l.trim())!.replace(/^#+\s*/, "").trim();
    return [{ name: f.logical.slice("playbooks/".length, -3), when: first.length > 200 ? `${first.slice(0, 199)}…` : first, from: f.from }];
  });
}

/** The prompt's playbook index, or null when there are none (an empty or missing folder adds nothing). */
export function playbookIndex(home: string | HomeLayers): string | null {
  const books = listPlaybooks(home);
  if (!books.length) return null;
  return `## Playbooks

How-tos you have written down. When what you are about to do matches one, read it with \`read_playbook\` first and follow it.

${books.map((b) => `- \`${b.name}\`: ${b.when}`).join("\n")}`;
}
