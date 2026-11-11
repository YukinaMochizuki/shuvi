import { join, resolve } from "node:path";
import type { WebToolsConfig } from "agent-runtime/tools/web";

/**
 * Configuration, all from the environment, read in one place. The server and the runner child read the
 * same variables (the child inherits the server's environment), so they always agree on where the data is.
 *
 *   SHUVI_BOT_TOKEN           the bot's token (server only: a child never talks to Telegram)
 *   SHUVI_OWNER_ID            the owner's Telegram user id
 *   SHUVI_OWNER_LANGUAGE      the language the owner speaks, which the assistant replies in by default,
 *                             e.g. "Traditional Chinese (Taiwan)". Everything in this codebase, the
 *                             prompts included, is English; this is the one place the owner's language
 *                             is named. Unset: the assistant answers in whatever language it is written to.
 *   SHUVI_DATA_DIR            where shuvi.db and home/ live (default ./data). Private; outside the repo.
 *   SHUVI_MODEL               the model turns run on (default: the driver's)
 *   SHUVI_TZ                  the time zone messages are shown to the model in (default: the host's)
 *   SHUVI_CLAUDE_CONFIG_DIR   which Claude login turns run on (default: the process user's)
 *   SHUVI_WEB                 "off" disables the web capability (default on: web_fetch, and
 *                             web_search when SHUVI_TAVILY_API_KEY is set)
 *   SHUVI_TAVILY_API_KEY      enables web_search
 *   SHUVI_TELEGRAM_API_ROOT   the Bot API base URL (default Telegram's; a fake one in tests)
 */

export interface Config {
  botToken: string;
  ownerId: number;
  ownerLanguage?: string;
  dataDir: string;
  dbPath: string;
  home: string;
  model?: string;
  timeZone: string;
  claudeConfigDir?: string;
  telegramApiRoot?: string;
  /** Absent when the web capability is off. */
  web?: WebToolsConfig;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export function loadConfig(opts: { needToken?: boolean } = {}): Config {
  const dataDir = resolve(process.env.SHUVI_DATA_DIR ?? "data");
  const ownerId = Number(required("SHUVI_OWNER_ID"));
  if (!Number.isSafeInteger(ownerId)) throw new Error("SHUVI_OWNER_ID must be a Telegram user id");
  return {
    botToken: opts.needToken === false ? (process.env.SHUVI_BOT_TOKEN ?? "") : required("SHUVI_BOT_TOKEN"),
    ownerId,
    ...(process.env.SHUVI_OWNER_LANGUAGE ? { ownerLanguage: process.env.SHUVI_OWNER_LANGUAGE } : {}),
    dataDir,
    dbPath: join(dataDir, "shuvi.db"),
    home: join(dataDir, "home"),
    ...(process.env.SHUVI_MODEL ? { model: process.env.SHUVI_MODEL } : {}),
    timeZone: process.env.SHUVI_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(process.env.SHUVI_CLAUDE_CONFIG_DIR ? { claudeConfigDir: process.env.SHUVI_CLAUDE_CONFIG_DIR } : {}),
    ...(process.env.SHUVI_TELEGRAM_API_ROOT ? { telegramApiRoot: process.env.SHUVI_TELEGRAM_API_ROOT } : {}),
    ...(process.env.SHUVI_WEB === "off"
      ? {}
      : {
          web: {
            ...(process.env.SHUVI_TAVILY_API_KEY ? { tavilyApiKey: process.env.SHUVI_TAVILY_API_KEY } : {}),
          },
        }),
  };
}
