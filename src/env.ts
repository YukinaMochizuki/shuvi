import { join, resolve } from "node:path";
import { parseLoopbackListen } from "./listen.ts";

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
 *   SHUVI_MODEL               the Claude model a first start's catalog defaults to (default: the CLI's).
 *                             Which models turns run on is the model catalog (store/models.ts) from then on.
 *   SHUVI_TZ                  the time zone messages are shown to the model in (default: the host's)
 *   SHUVI_CLAUDE_CONFIG_DIR   the Claude login a first start's catalog puts its `claude` provider on
 *                             (default: the process user's)
 *   SHUVI_TELEGRAM_API_ROOT   the Bot API base URL (default Telegram's; a fake one in tests)
 *   SHUVI_CONTROL_BOT_TOKEN   the control bot's token (src/control/bot.ts), the framework's own channel to
 *                             the owner: status, stop, alerts, approvals. Unset: no control bot; alerts
 *                             still queue in the store (and go to the log) and are delivered once it is set.
 *   SHUVI_CONTROL_API_ROOT    the control bot's Bot API base URL (default: SHUVI_TELEGRAM_API_ROOT)
 *   SHUVI_TURN_MAX_MINUTES    a turn's wall-clock limit; past it the turn is stopped (default 15)
 *   SHUVI_ALERT_OUTBOUND_MINUTES  alert when an outbound message is still pending after this long (default 10)
 *   SHUVI_COMMIT              the deployed commit /status shows (default: `git describe` of the checkout)
 *   SHUVI_TRANSCRIPT_DAYS     transcript retention after a turn ends and conversation history after its
 *                             last write (default 30 days)
 *   SHUVI_SECRETS_FILE        the secret profiles (default /etc/shuvi.secrets.yaml): every value in it is
 *                             redacted from turn transcripts, and from a chat computer's output
 *   SHUVI_CONSOLE_LISTEN      where the console listens, LOOPBACK ONLY (default 127.0.0.1:8787); anything
 *                             else is refused at startup. Publish it with `tailscale serve` (docs/console.md)
 *   SHUVI_CONSOLE_USERS       the tailnet logins let into the console (comma-separated), by the
 *                             `Tailscale-User-Login` header `tailscale serve` sets
 *   SHUVI_CONSOLE_TOKEN       the console's fallback when SHUVI_CONSOLE_USERS is unset: a token exchanged at
 *                             /login for a session cookie. With neither set, the console is off
 *   SHUVI_CONSOLE_URL         the console as the owner opens it (https://<host>.<tailnet>.ts.net): links to a
 *                             turn in the control bot, and the one non-loopback Host the console answers
 *   SHUVI_DRAIN_SEC           on SIGTERM, how long running turns get to finish before they are stopped
 *                             (default 600; server/drain.ts). A container's stop timeout must exceed it
 *   SHUVI_DRAIN_GRACE_SEC     after the stop at the drain deadline, how long a turn has to close itself
 *                             before it is killed (default 15)
 *   SHUVI_METRICS_LISTEN      where /healthz and /metrics listen, LOOPBACK ONLY (default 127.0.0.1:8788;
 *                             server/health.ts); anything else is refused here, at startup
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
  transcriptDays: number;
  secretsFile: string;
  console: { listen: string; users?: string[]; token?: string; url?: string };
  drainMs: number;
  drainGraceMs: number;
  metricsListen: string;
}

export const DEFAULT_CONSOLE_LISTEN = "127.0.0.1:8787";
export const DEFAULT_SECRETS_FILE = "/etc/shuvi.secrets.yaml";
export const DEFAULT_DRAIN_SEC = 600;
export const DEFAULT_METRICS_LISTEN = "127.0.0.1:8788";
export const DEFAULT_DRAIN_GRACE_SEC = 15;

/** SHUVI_METRICS_LISTEN → Bun.serve's options; refuses anything that is not loopback. */
export function parseMetricsListen(listen: string): { hostname: string; port: number } {
  return parseLoopbackListen("SHUVI_METRICS_LISTEN", listen, DEFAULT_METRICS_LISTEN);
}

function seconds(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback * 1000;
  const n = Number(v);
  if (!(n >= 0)) throw new Error(`${name} must be a number of seconds, 0 or more`);
  return Math.round(n * 1000);
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
  const model = process.env.SHUVI_MODEL?.trim();
  const ownerId = Number(required("SHUVI_OWNER_ID"));
  if (!Number.isSafeInteger(ownerId)) throw new Error("SHUVI_OWNER_ID must be a Telegram user id");
  return {
    botToken: opts.needToken === false ? (process.env.SHUVI_BOT_TOKEN ?? "") : required("SHUVI_BOT_TOKEN"),
    ownerId,
    ...(process.env.SHUVI_OWNER_LANGUAGE ? { ownerLanguage: process.env.SHUVI_OWNER_LANGUAGE } : {}),
    dataDir,
    dbPath: join(dataDir, "shuvi.db"),
    home: join(dataDir, "home"),
    ...(model ? { model } : {}),
    timeZone: process.env.SHUVI_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(process.env.SHUVI_CLAUDE_CONFIG_DIR ? { claudeConfigDir: process.env.SHUVI_CLAUDE_CONFIG_DIR } : {}),
    ...(process.env.SHUVI_TELEGRAM_API_ROOT ? { telegramApiRoot: process.env.SHUVI_TELEGRAM_API_ROOT } : {}),
    ...(process.env.SHUVI_CONTROL_BOT_TOKEN ? { controlBotToken: process.env.SHUVI_CONTROL_BOT_TOKEN } : {}),
    ...(process.env.SHUVI_CONTROL_API_ROOT || process.env.SHUVI_TELEGRAM_API_ROOT
      ? { controlApiRoot: (process.env.SHUVI_CONTROL_API_ROOT || process.env.SHUVI_TELEGRAM_API_ROOT)! }
      : {}),
    turnMaxMs: minutes("SHUVI_TURN_MAX_MINUTES", 15),
    outboundAlertMs: minutes("SHUVI_ALERT_OUTBOUND_MINUTES", 10),
    transcriptDays: days("SHUVI_TRANSCRIPT_DAYS", 30),
    secretsFile: process.env.SHUVI_SECRETS_FILE || DEFAULT_SECRETS_FILE,
    console: consoleFromEnv(process.env),
    drainMs: seconds("SHUVI_DRAIN_SEC", DEFAULT_DRAIN_SEC),
    drainGraceMs: seconds("SHUVI_DRAIN_GRACE_SEC", DEFAULT_DRAIN_GRACE_SEC),
    metricsListen: metricsListenFrom(process.env),
  };
}

/** SHUVI_METRICS_LISTEN, checked: a non-loopback address throws, so the server refuses to start. */
export function metricsListenFrom(env: Record<string, string | undefined>): string {
  const listen = env.SHUVI_METRICS_LISTEN?.trim() || DEFAULT_METRICS_LISTEN;
  parseMetricsListen(listen);
  return listen;
}

function days(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!(n > 0)) throw new Error(`${name} must be a positive number of days`);
  return n;
}

/** The console's settings (src/console/), from the environment. Checked by the server at startup. */
export function consoleFromEnv(env: Record<string, string | undefined>): Config["console"] {
  const users = (env.SHUVI_CONSOLE_USERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    listen: env.SHUVI_CONSOLE_LISTEN?.trim() || DEFAULT_CONSOLE_LISTEN,
    ...(users.length ? { users } : {}),
    ...(env.SHUVI_CONSOLE_TOKEN ? { token: env.SHUVI_CONSOLE_TOKEN } : {}),
    ...(env.SHUVI_CONSOLE_URL?.trim() ? { url: env.SHUVI_CONSOLE_URL.trim() } : {}),
  };
}
