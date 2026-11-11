#!/usr/bin/env bun
/**
 * The console over fixture data (test/console-fixture.ts, made-up names only, the `rich` set), for looking
 * at it and for screenshots: builds the fixture in a temporary data dir and serves the console on
 * 127.0.0.1:<port>, as the tailnet user `owner@example.com` (the header `tailscale serve` would set is added
 * here, since there is no tailscale in front of it).
 *
 *   bun scripts/console-fixture.ts [port]     # default 8787; prints the pages to open
 */
import { allowedHosts } from "../src/console/index.ts";
import { handleConsole, LOGIN_HEADER } from "../src/console/server.ts";
import { buildConsoleFixture } from "../test/console-fixture.ts";
import { OWNER } from "../test/helpers.ts";

const port = Number(process.argv[2] ?? 8787);
const f = await buildConsoleFixture({ pauses: true, rich: true });
const users = new Set(["owner@example.com"]);
const hosts = allowedHosts({ listen: `127.0.0.1:${port}` }, port);
Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(req) {
    const headers = new Headers(req.headers);
    headers.set(LOGIN_HEADER, "owner@example.com");
    return handleConsole({ db: f.db, timeZone: "Asia/Taipei", dataDir: f.dataDir, ownerId: OWNER, users, allowedHosts: hosts }, new Request(req, { headers }));
  },
});
const base = `http://127.0.0.1:${port}`;
const ids = (f.db.$client.query("select id from turns order by id").all() as { id: number }[]).map((r) => r.id);
console.log(`console fixture on ${base} (data in ${f.dataDir})`);
for (const p of ["/chats", "/chats/1", "/chats/2", "/turns", ...ids.map((id) => `/turns/${id}`)]) console.log(`  ${base}${p}`);
