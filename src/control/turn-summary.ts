import { formatTime } from "../agent/render.ts";
import { consoleTurnUrl } from "../store/control.ts";
import type { Db } from "../store/db.ts";
import { getChat } from "../store/events.ts";
import { getTranscript, stepsOf } from "../store/transcripts.ts";
import { chatLabel, getTurn } from "../store/turns.ts";

/**
 * What the control bot's `/turn <id>` answers: one paragraph on the turn, from `turns` and its transcript
 * (agent/transcript.ts), and the link to it in the console when SHUVI_CONSOLE_URL is set.
 */
export function turnSummary(db: Db, turnId: number, timeZone: string): string {
  const t = getTurn(db, turnId);
  if (!t) return `No turn ${turnId}.`;
  const chat = getChat(db, t.chatId);
  const where = chat ? chatLabel(chat) : `chat ${t.chatId}`;
  const wallS = t.endedAt ? (Date.parse(t.endedAt) - Date.parse(t.startedAt)) / 1000 : null;
  const steps = stepsOf(db, turnId);
  const tools = steps.filter((s) => s.kind === "tool");
  const names = [...new Set(tools.map((s) => s.name ?? "?"))];
  const refused = tools.filter((s) => s.status === "refused").length;
  const failed = tools.filter((s) => s.status === "error" || s.status === "threw").length;
  const texts = steps.filter((s) => s.kind === "text");
  const sent = texts.filter((s) => s.sent).length;
  const transcript = getTranscript(db, turnId);
  const model = transcript?.model;

  const parts = [
    `Turn ${t.id} in ${where}, started ${formatTime(t.startedAt, timeZone)}: ${t.status}${wallS !== null ? ` after ${wallS.toFixed(1)}s` : t.status === "running" ? " (still running)" : ""}.`,
  ];
  if (t.error) parts.push(`Error: ${t.error.length > 300 ? `${t.error.slice(0, 299)}…` : t.error}.`);
  if (steps.length) {
    parts.push(
      tools.length
        ? `${tools.length} tool call${tools.length === 1 ? "" : "s"} (${names.join(", ")})${refused || failed ? `, ${[refused ? `${refused} refused` : "", failed ? `${failed} failed` : ""].filter(Boolean).join(", ")}` : ""}.`
        : "No tool calls.",
    );
    parts.push(`${texts.length} text block${texts.length === 1 ? "" : "s"}, ${sent} sent.`);
  } else parts.push(transcript ? "Nothing in its timeline: no thinking, text or tool call was recorded." : "No transcript (pruned, or the turn never reached the model).");
  if (t.inputTokens !== null || t.costMicroUsd !== null) {
    const n = (v: number | null) => (v ?? 0).toLocaleString("en-US");
    parts.push(
      `Tokens: ${n(t.inputTokens)} in, ${n(t.outputTokens)} out, ${n(t.cacheReadTokens)} cache read, ${n(t.cacheCreationTokens)} cache write; $${((t.costMicroUsd ?? 0) / 1e6).toFixed(4)}${model ? ` on ${model}` : ""}.`,
    );
  }
  const link = consoleTurnUrl(turnId);
  return link ? `${parts.join(" ")}\n${link}` : parts.join(" ");
}
