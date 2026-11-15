import { webTools, type WebToolsConfig } from "agent-runtime/tools/web";
import { porchkitConfig } from "../../porchkit/client.ts";
import type { ChatPolicy } from "../../policy/policy.ts";
import { defineCapability, policyEnables } from "../types.ts";

/**
 * Web: agent-runtime's shared web tools (`web_search`, `web_fetch`), configured here, never copied
 * (docs/design.md §14).
 *
 * WHERE PORCHKIT READS LINKS (it is configured, and the chat's policy enables media): `web_fetch` is not
 * offered there, and this section says to read every link with media's `read_link`, which goes out through
 * porchkit (one way out: its egress rules, anonymity, cache and per-site budgets). It is filtered out of
 * agent-runtime's bundle here, not changed there. Elsewhere `web_fetch` stays as it was.
 *
 *   SHUVI_WEB              "off" disables the web capability (default on: web_fetch, and web_search when
 *                          SHUVI_TAVILY_API_KEY is set)
 *   SHUVI_TAVILY_API_KEY   enables web_search
 *   SHUVI_PORCHKIT_URL / SHUVI_PORCHKIT_TOKEN   read only to know whether porchkit is there (src/porchkit/)
 */

export interface WebConfig {
  tools: WebToolsConfig;
  /** porchkit is configured: in a chat with media, read_link reads links instead of web_fetch. */
  reader: boolean;
}

/** When to reach for the web tools. */
export const WEB = `## Looking things up

You can reach the web. Use \`web_search\` to find pages, and \`web_fetch\` to read one you have a URL for (it returns the raw response, so it works best on text, JSON and simple pages). Look things up rather than guess whenever a question depends on recent events, prices or facts you are unsure of, and say where an answer came from when it matters. A lookup that takes several steps is worth a short \`say\` first.`;

/** The same where read_link reads links; `search`: web_search is there. */
export function webReaderSection(search: boolean): string {
  return `## Looking things up

You can reach the web. ${search ? "Use `web_search` to find pages, and `read_link` to read any URL" : "Use `read_link` to read any URL"}: a page, a social post, a video's page, JSON. Look things up rather than guess whenever a question depends on recent events, prices or facts you are unsure of, and say where an answer came from when it matters. A lookup that takes several steps is worth a short \`say\` first.`;
}

/** Does read_link stand in for web_fetch in this chat? */
const reads = (cfg: WebConfig, chatPolicy: ChatPolicy | undefined) => cfg.reader && policyEnables(chatPolicy, "media");

export const web = defineCapability<WebConfig>({
  id: "web",
  label: "web lookups",
  gives: "web_search when a search key is set, and web_fetch to read a page (where links are not read through the home relay's read_link).",
  enable: (env) => (env.SHUVI_WEB === "off" ? null : { tools: { ...(env.SHUVI_TAVILY_API_KEY ? { tavilyApiKey: env.SHUVI_TAVILY_API_KEY } : {}) }, reader: porchkitConfig(env) !== null }),
  tools: ({ chatPolicy }, config) => {
    const bundle = webTools(config.tools);
    if (!reads(config, chatPolicy)) return [bundle];
    const tools = bundle.tools.filter((t) => t.name !== "web_fetch");
    return tools.length ? [{ ...bundle, tools }] : [];
  },
  section: ({ chatPolicy }, config) => (reads(config, chatPolicy) ? webReaderSection(!!config.tools.tavilyApiKey) : WEB),
});
