/**
 * Listen addresses that must be loopback (the console's SHUVI_CONSOLE_LISTEN, the health and metrics
 * endpoint's SHUVI_METRICS_LISTEN). Kept apart from both so the config (src/env.ts) can check an address at
 * startup without loading either server.
 */

/** A hostname a socket bound to it can only be reached from this machine (or this network namespace). */
export function isLoopback(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

/** `host:port` (or `[v6]:port`) → Bun.serve's options; throws, naming `variable`, unless it is loopback. */
export function parseLoopbackListen(variable: string, listen: string, example: string, hint = ""): { hostname: string; port: number } {
  const m = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(listen.trim());
  if (!m) throw new Error(`${variable} must be host:port on a loopback address (e.g. ${example}), not "${listen}"`);
  const hostname = m[1] ?? m[2]!;
  if (!isLoopback(hostname)) throw new Error(`${variable} must be a loopback address (127.0.0.1, ::1 or localhost), not "${hostname}"${hint}`);
  return { hostname, port: Number(m[3]) };
}
