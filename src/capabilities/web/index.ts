import { webTools, type WebToolsConfig } from "agent-runtime/tools/web";
import { defineCapability } from "../types.ts";

/**
 * Web: agent-runtime's shared web tools (`web_search`, `web_fetch`), configured here, never copied
 * (docs/design.md §14).
 *
 *   SHUVI_WEB              "off" disables the web capability (default on: web_fetch, and web_search when
 *                          SHUVI_TAVILY_API_KEY is set)
 *   SHUVI_TAVILY_API_KEY   enables web_search
 */

/** When to reach for the web tools. */
export const WEB = `## Looking things up

You can reach the web. Use \`web_search\` to find pages, and \`web_fetch\` to read one you have a URL for (it returns the raw response, so it works best on text, JSON and simple pages). Look things up rather than guess whenever a question depends on recent events, prices or facts you are unsure of, and say where an answer came from when it matters. A lookup that takes several steps is worth a short \`say\` first.`;

export const web = defineCapability<WebToolsConfig>({
  id: "web",
  label: "web lookups",
  gives: "web_fetch to read a page, and web_search when a search key is set.",
  enable: (env) => (env.SHUVI_WEB === "off" ? null : { ...(env.SHUVI_TAVILY_API_KEY ? { tavilyApiKey: env.SHUVI_TAVILY_API_KEY } : {}) }),
  tools: (_ctx, config) => [webTools(config)],
  section: () => WEB,
});
