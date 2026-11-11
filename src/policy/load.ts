import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { raiseAlert } from "../store/control.ts";
import type { Db } from "../store/db.ts";
import { kvGet, kvSet } from "../store/events.ts";
import { defaultPolicy, parsePolicy, type Policy } from "./policy.ts";

/**
 * Loading `home/policy.yaml` (./policy.ts says what it holds). The server loads it at start and again
 * whenever its text changes (`PolicyWatch`, polled by a server loop); every runner child loads it once,
 * at its start, with the same function, so the two read the same file the same way.
 *
 * A BROKEN file (it does not parse, or breaks a rule) never takes effect: the LAST GOOD policy stays, and
 * the owner is alerted once per broken version (the alert is keyed on the text's hash, so the server and
 * every child raising it count once). The last good policy is kept in `kv` (`policy_last_good`), so a
 * child started after the file broke, or a server restarted, still has it. With no last good one, the
 * default (the owner's DM only) applies. A MISSING file is not broken: it is the default policy.
 */

export const POLICY_FILE = "policy.yaml";
export const LAST_GOOD_KEY = "policy_last_good";

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

function lastGood(db: Db): Policy {
  const v = kvGet(db, LAST_GOOD_KEY);
  if (!v) return defaultPolicy();
  try {
    return JSON.parse(v) as Policy;
  } catch {
    return defaultPolicy();
  }
}

/** The policy in effect, given the file's text (null: no file). */
export function policyFromText(db: Db, text: string | null, ownerId?: number, now = Date.now()): Policy {
  if (text === null) return defaultPolicy();
  const r = parsePolicy(text, ownerId);
  if ("error" in r) {
    raiseAlert(
      db,
      { key: `policy-broken:${hash(text)}`, topic: "policy-broken", text: `home/${POLICY_FILE} is broken: ${r.error}. The last good policy stays in effect until it is fixed.` },
      now,
    );
    return lastGood(db);
  }
  const json = JSON.stringify(r.policy);
  if (kvGet(db, LAST_GOOD_KEY) !== json) kvSet(db, LAST_GOOD_KEY, json);
  return r.policy;
}

export function readPolicyText(home: string): string | null {
  const p = join(home, POLICY_FILE);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

/** Load the policy in effect now (a runner child does this once). */
export function loadPolicy(db: Db, home: string, ownerId?: number): Policy {
  return policyFromText(db, readPolicyText(home), ownerId);
}

/** The server's copy of the policy, reloaded when the file's text changes. */
export class PolicyWatch {
  private text: string | null | undefined = undefined;
  private policy: Policy = defaultPolicy();

  constructor(
    private readonly db: Db,
    private readonly home: string,
    private readonly ownerId?: number,
  ) {
    this.refresh();
  }

  /** Re-read the file; reload when it changed. Returns true when it did. */
  refresh(): boolean {
    const text = readPolicyText(this.home);
    if (text === this.text) return false;
    this.text = text;
    this.policy = policyFromText(this.db, text, this.ownerId);
    return true;
  }

  current(): Policy {
    return this.policy;
  }
}
