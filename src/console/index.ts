import type { Db } from "../store/db.ts";
import { parseConsoleListen, serveConsole, type ConsoleDeps } from "./server.ts";

/**
 * The console: a private web view of every turn as the model saw it (the turn transcripts that
 * agent/transcript.ts records), of the chats, and of each chat's timeline; read-only but for its Settings
 * page, which manages the model catalog. A framework surface for the
 * owner, like the control bot, started by the server (server/main.ts); a runner child never loads it.
 *
 *   server.ts   who may look (loopback, Host, the tailnet login, the token fallback), and the routes
 *   pages.ts    the pages; queries.ts what they read; html.ts the components; style.css, console.js
 *   settings.ts the Settings page; settings-write.ts its writes, the console's only ones
 *
 * Its configuration is the framework's (src/env.ts `ConsoleConfig`): SHUVI_CONSOLE_LISTEN, _USERS, _TOKEN,
 * _URL. It is served only when SHUVI_CONSOLE_USERS or SHUVI_CONSOLE_TOKEN is set. See docs/console.md.
 */

export interface ConsoleSettings {
  listen: string;
  users?: readonly string[];
  token?: string;
  url?: string;
}

/** Whether the console is to be served at all. */
export const consoleOn = (c: ConsoleSettings) => !!(c.users?.length || c.token);

/**
 * Check the settings at startup: a listen address that is not loopback is refused here, before the server
 * does anything else. Throws with the reason.
 */
export function checkConsole(c: ConsoleSettings): void {
  parseConsoleListen(c.listen);
  if (c.url) {
    try {
      new URL(c.url);
    } catch {
      throw new Error(`SHUVI_CONSOLE_URL must be a URL, not "${c.url}"`);
    }
  }
}

/** The Hosts a request may name: the public URL's, and the loopback names of the bound port. */
export function allowedHosts(c: ConsoleSettings, port: number): Set<string> {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (c.url) hosts.add(new URL(c.url).host.toLowerCase());
  return hosts;
}

/**
 * The Origins a write may come from (server.ts): the public URL's, and `http://` the loopback names of the bound
 * port (where the console is opened over an ssh tunnel).
 */
export function allowedOrigins(c: ConsoleSettings, port: number): Set<string> {
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]);
  if (c.url) origins.add(new URL(c.url).origin.toLowerCase());
  return origins;
}

/** Serve the console until `signal` aborts. */
export function startConsole(c: ConsoleSettings, base: { db: Db; timeZone: string; dataDir: string; ownerId: number; transcriptDays?: number }, signal: AbortSignal): ReturnType<typeof serveConsole> {
  const deps: Omit<ConsoleDeps, "allowedHosts"> = {
    ...base,
    ...(c.users?.length ? { users: new Set(c.users) } : c.token ? { token: c.token } : {}),
  };
  return serveConsole(deps, c.listen, (port) => ({ hosts: allowedHosts(c, port), origins: allowedOrigins(c, port) }), signal);
}
