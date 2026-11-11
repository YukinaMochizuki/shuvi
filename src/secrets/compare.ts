import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Comparing a secret someone presented (a hook's bearer token, the console's token, a session cookie) with the
 * one expected. Core, so every caller shares the one constant-time comparison.
 */

/** Constant-time equality of two secrets, by their sha256 (so differing lengths leak nothing either). */
export function sameSecret(a: string, b: string): boolean {
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(a), h(b));
}
