/**
 * The emoji Telegram accepts as a reaction (Bot API `ReactionTypeEmoji`). Checked before a reaction is
 * queued, so a wrong one is an error the model reads and corrects in the same turn, rather than a 400 the
 * sender meets after the turn is over.
 */
export const REACTION_EMOJI = [
  "❤", "👍", "👎", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉", "🤩", "🤮", "💩", "🙏",
  "👌", "🕊", "🤡", "🥱", "🥴", "😍", "🐳", "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨",
  "😐", "🍓", "🍾", "💋", "🖕", "😈", "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈", "😇", "😨", "🤝",
  "✍", "🤗", "🫡", "🎅", "🎄", "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄", "😘", "💊", "🙊", "😎",
  "👾", "🤷‍♂", "🤷", "🤷‍♀", "😡",
] as const;

const SET = new Set<string>(REACTION_EMOJI);

/** The canonical form of `emoji` if Telegram accepts it as a reaction (the variation selector stripped), else null. */
export function normalizeReaction(emoji: string): string | null {
  const bare = emoji.trim().replace(/️/g, "");
  return SET.has(bare) ? bare : null;
}
