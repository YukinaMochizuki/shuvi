import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { commitHomeEdit } from "../capabilities/memory/home.ts";
import { requestApproval } from "../control/approvals.ts";
import { raiseAlert } from "../store/control.ts";
import type { Db } from "../store/db.ts";
import { kvGet, kvSet } from "../store/events.ts";
import { approvals } from "../store/schema.ts";
import { POLICY_FILE, readPolicyText } from "./load.ts";
import { DM_DEFAULT, entryToDoc, parsePolicy } from "./policy.ts";

/**
 * Changing `home/policy.yaml`: ONLY through the owner's approval (docs/design.md §8). Nothing else in
 * shuvi writes it; memory's `edit_home` cannot reach it (capabilities/memory/home.ts).
 *
 *   requestPolicyChange   computes the file as it would be with one chat's entry replaced (or removed),
 *                         and puts it to the owner as a card in the control bot (control/approvals.ts,
 *                         kind `policy`): the diff of the whole file, or all of it when the change creates
 *                         the file. Two callers: `propose_policy` (capabilities/groups/), which names the
 *                         chat that asked so the answer wakes it, and the poller, for a group nobody listed
 *                         yet (server/poller.ts). A change that would leave the file broken, or a file
 *                         that is already broken, is refused here, before anyone is asked.
 *   applyPolicyApprovals  run by a server loop: every `policy` approval the owner APPROVED and that was not
 *                         applied yet is written and committed in home/ (as shuvi, like every edit there),
 *                         once (`policy_applied:<id>` in kv, set after the commit; a repeat after a crash
 *                         finds the file already says it, and only records that).
 *
 * WHAT THE OWNER APPROVES IS WHAT IS WRITTEN. The card carries the hash of the file it was computed from;
 * if the file changed in between (the owner edited it, another change was approved first), nothing is
 * written and the owner is told to have it proposed again. The file is written back from its parsed form,
 * so comments in it do not survive a change made this way (the diff shows that too).
 */

export const POLICY_KIND = "policy";
export const APPLIED_PREFIX = "policy_applied:";

export interface PolicyChange {
  /** `dm`, or the group's Telegram chat id. */
  chat: string;
  /** The entry as it should be written (already checked), or null to remove the chat. */
  entry: Record<string, unknown> | null;
}

const hash = (s: string | null) => createHash("sha256").update(s ?? "\u0000none").digest("hex").slice(0, 16);

/** A line diff (longest common subsequence): ` ` kept, `-` removed, `+` added. */
export function lineDiff(before: string[], after: string[]): string[] {
  const n = before.length;
  const m = after.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = before[i] === after[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      out.push(`  ${before[i++]}`);
      j++;
    } else if (j < m && (i >= n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) out.push(`+ ${after[j++]}`);
    else out.push(`- ${before[i++]}`);
  }
  return out;
}

/** The diff of the whole file, unchanged stretches longer than `context` lines around a change folded. */
export function fileDiff(before: string | null, after: string, context = 3): string {
  const lines = (s: string) => s.replace(/\n$/, "").split("\n");
  if (before === null) return lines(after).map((l) => `+ ${l}`).join("\n");
  const d = lineDiff(lines(before), lines(after));
  const changed = d.map((l) => !l.startsWith("  "));
  const keep = d.map((_, i) => changed.slice(Math.max(0, i - context), i + context + 1).some(Boolean));
  const out: string[] = [];
  d.forEach((l, i) => {
    if (keep[i]) out.push(l);
    else if (keep[i - 1] !== false || i === 0) out.push("  …");
  });
  return out.join("\n");
}

/** Write one change into `text` (null: no file yet). Returns the new text, or why it cannot. */
export function applyChange(text: string | null, change: PolicyChange, ownerId: number): { text: string } | { error: string } {
  let doc: Record<string, unknown>;
  if (text === null || !text.trim()) doc = { owner: ownerId, chats: { dm: entryToDoc(DM_DEFAULT) }, unknown_chat: "ignore" };
  else {
    try {
      doc = (Bun.YAML.parse(text) ?? {}) as Record<string, unknown>;
    } catch (e) {
      return { error: `${POLICY_FILE} does not parse (${e instanceof Error ? e.message : String(e)})` };
    }
    if (typeof doc !== "object" || Array.isArray(doc)) return { error: `${POLICY_FILE} is not a mapping` };
  }
  const chats = { ...((doc.chats as Record<string, unknown> | null | undefined) ?? {}) };
  if (change.entry === null) delete chats[change.chat];
  else chats[change.chat] = change.entry;
  const next = `${Bun.YAML.stringify({ ...doc, chats }, null, 2).trimEnd()}\n`;
  const check = parsePolicy(next, ownerId);
  if ("error" in check) return { error: `the result would be broken: ${check.error}` };
  return { text: next };
}

/**
 * Ask the owner to approve a change to one chat's entry. Returns the approval's id, or why the change
 * cannot be proposed (nobody is asked then). `home` undefined: as if there were no file yet.
 */
export function requestPolicyChange(
  db: Db,
  home: string | undefined,
  ownerId: number,
  change: PolicyChange,
  opts: { title: string; why: string; originChatId?: number; approveLabel?: string; rejectLabel?: string },
): { id: number } | { error: string } {
  const before = home === undefined ? null : readPolicyText(home);
  const r = applyChange(before, change, ownerId);
  if ("error" in r) return r;
  const what = before === null ? `home/${POLICY_FILE} does not exist yet; it would be created as:` : `home/${POLICY_FILE}, as it would change:`;
  const id = requestApproval(db, {
    kind: POLICY_KIND,
    title: opts.title,
    body: `${opts.why}\n\n${what}\n${fileDiff(before, r.text)}`,
    options: [
      { id: "approve", label: opts.approveLabel ?? "Approve" },
      { id: "reject", label: opts.rejectLabel ?? "Reject" },
    ],
    ...(opts.originChatId !== undefined ? { originChatId: opts.originChatId } : {}),
    data: { chat: change.chat, entry: change.entry, base: hash(before) },
  });
  return { id };
}

/** Apply every approved, not yet applied policy change. Returns how many were written. */
export function applyPolicyApprovals(db: Db, home: string, ownerId: number): number {
  const approved = db
    .select()
    .from(approvals)
    .where(and(eq(approvals.kind, POLICY_KIND), eq(approvals.status, "answered"), eq(approvals.answer, "approve")))
    .all()
    .filter((a) => !kvGet(db, `${APPLIED_PREFIX}${a.id}`));
  let written = 0;
  for (const a of approved) {
    const change = a.data as unknown as (PolicyChange & { base?: string }) | null;
    const message = `Policy: ${a.title.replace(/\?$/, "")} (approval #${a.id})`;
    const text = readPolicyText(home);
    let outcome: string;
    if (!change || typeof change.chat !== "string") outcome = "failed: the approval carries no change";
    else {
      const r = applyChange(text, change, ownerId);
      if ("error" in r) outcome = `failed: ${r.error}`;
      else if (text === r.text) outcome = "already applied";
      else if (change.base !== hash(text)) outcome = `failed: home/${POLICY_FILE} changed after the card was made, so what you approved is no longer what would be written. Ask for it to be proposed again`;
      else {
        try {
          outcome = `committed ${commitHomeEdit(home, POLICY_FILE, r.text, message)}`;
          written++;
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e);
          // Committed before a crash, and found again: the file already says it.
          outcome = /already says exactly that/.test(why) ? "already applied" : `failed: ${why}`;
        }
      }
    }
    if (outcome.startsWith("failed")) {
      raiseAlert(db, { key: `policy-apply:${a.id}`, text: `Approval #${a.id} ("${a.title}") was approved, but home/${POLICY_FILE} was not changed: ${outcome.slice("failed: ".length)}.` });
    }
    kvSet(db, `${APPLIED_PREFIX}${a.id}`, outcome);
  }
  return written;
}
