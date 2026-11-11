-- Custom migration (drizzle-kit cannot express an FTS5 table): full-text search over what was said, for
-- `search_chats` (src/capabilities/retrieval/). On a rebase that renumbers it (AGENTS.md, "Migrations on
-- parallel branches"), regenerate it with `bunx drizzle-kit generate --custom --name chat_events_fts` and
-- paste this SQL back in.
--
-- One row per searchable event, rowid = chat_events.seq: a person's message as it is recorded, and the
-- assistant's message once it is delivered (one that never went out was never said). The trigram
-- tokenizer matches substrings, so Chinese and Japanese, which have no spaces between words, are
-- searchable too.
CREATE VIRTUAL TABLE `chat_events_fts` USING fts5(`text`, tokenize = 'trigram');
--> statement-breakpoint
CREATE TRIGGER `chat_events_fts_message` AFTER INSERT ON `chat_events`
WHEN new.`kind` = 'message' AND json_extract(new.`payload`, '$.text') IS NOT NULL
BEGIN
  INSERT INTO `chat_events_fts` (rowid, `text`) VALUES (new.`seq`, json_extract(new.`payload`, '$.text'));
END;
--> statement-breakpoint
CREATE TRIGGER `chat_events_fts_delivered` AFTER UPDATE OF `status` ON `chat_events`
WHEN new.`kind` = 'bot_message' AND new.`status` = 'sent' AND old.`status` IS NOT 'sent'
BEGIN
  INSERT OR REPLACE INTO `chat_events_fts` (rowid, `text`) VALUES (new.`seq`, json_extract(new.`payload`, '$.text'));
END;
--> statement-breakpoint
INSERT INTO `chat_events_fts` (rowid, `text`)
SELECT `seq`, json_extract(`payload`, '$.text') FROM `chat_events`
WHERE json_extract(`payload`, '$.text') IS NOT NULL
  AND (`kind` = 'message' OR (`kind` = 'bot_message' AND `status` = 'sent'));
