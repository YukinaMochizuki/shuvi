import { join, resolve } from "node:path";

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
 *   SHUVI_TELEGRAM_API_ROOT   the Bot API base URL (default Telegram's; a fake one in tests)
 *   SHUVI_CONTROL_BOT_TOKEN   the control bot's token (src/control/bot.ts), the framework's own channel to
 *                             the owner: status, stop, alerts, approvals. Unset: no control bot; alerts
 *                             still queue in the store (and go to the log) and are delivered once it is set.
 *   SHUVI_CONTROL_API_ROOT    the control bot's Bot API base URL (default: SHUVI_TELEGRAM_API_ROOT)
 *   SHUVI_TURN_MAX_MINUTES    a turn's wall-clock limit; past it the turn is stopped (default 15)
 *   SHUVI_ALERT_OUTBOUND_MINUTES  alert when an outbound message is still pending after this long (default 10)
 *   SHUVI_COMMIT              the deployed commit /status shows (default: `git describe` of the checkout)
 *
 * These are the framework's own variables. A capability reads its own (e.g. SHUVI_WEB,
 * SHUVI_TAVILY_API_KEY) in its own module, src/capabilities/<id>/, which lists them in its header.
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
  controlBotToken?: string;
  controlApiRoot?: string;
  turnMaxMs: number;
  outboundAlertMs: number;
}

function minutes(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback * 60_000;
  const n = Number(v);
  if (!(n > 0)) throw new Error(`${name} must be a positive number of minutes`);
  return Math.round(n * 60_000);
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/** The data dir (`SHUVI_DATA_DIR`, default ./data), absolute. Exported for a capability that keeps files there. */
export function dataDirFrom(env: Record<string, string | undefined>): string {
  return resolve(env.SHUVI_DATA_DIR ?? "data");
}

export function loadConfig(opts: { needToken?: boolean } = {}): Config {
  const dataDir = dataDirFrom(process.env);
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
    ...(process.env.SHUVI_CONTROL_BOT_TOKEN ? { controlBotToken: process.env.SHUVI_CONTROL_BOT_TOKEN } : {}),
    ...(process.env.SHUVI_CONTROL_API_ROOT || process.env.SHUVI_TELEGRAM_API_ROOT
      ? { controlApiRoot: (process.env.SHUVI_CONTROL_API_ROOT || process.env.SHUVI_TELEGRAM_API_ROOT)! }
      : {}),
    turnMaxMs: minutes("SHUVI_TURN_MAX_MINUTES", 15),
    outboundAlertMs: minutes("SHUVI_ALERT_OUTBOUND_MINUTES", 10),
  };
}
