import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * The sealing of secret profiles kept in the store (`secret_profiles`, src/secrets/source.ts): AES-256-GCM
 * under SHUVI_SECRETS_KEY, the profile's name as additional data, so a sealed value moved to another profile's
 * row does not open.
 *
 *   SEALED   one byte of version (1), 12 bytes of IV (random per seal), 16 bytes of GCM tag, the ciphertext of
 *            the profile's variables as JSON ({ "NAME": "value" }). The additional data is the version byte and
 *            the name, so neither can be changed without the tag failing.
 *
 * A PERSONAL-INFO profile (kind `info`, src/secrets/info.ts) is sealed with `info:<name>` as its name: a profile's name
 * never holds a `:`, so a sealed value moved between a secret's row and an info row does not open either, and a
 * profile changing kind is sealed anew.
 *
 * The key is 32 bytes, given as base64 (`openssl rand -base64 32`). It lives in the environment only, never in
 * the store, so a copy of shuvi.db (litestream's replica, a backup before a migration) holds no readable value.
 */

export const KEY_BYTES = 32;
const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** SHUVI_SECRETS_KEY as bytes, or why it cannot be used. Unset: no key (and no error). */
export function parseKey(raw: string | undefined): { key: Uint8Array | null; error?: string } {
  const s = raw?.trim();
  if (!s) return { key: null };
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return { key: null, error: "SHUVI_SECRETS_KEY is not base64" };
  const key = Buffer.from(s, "base64");
  if (key.length !== KEY_BYTES) return { key: null, error: `SHUVI_SECRETS_KEY is ${key.length} bytes, not ${KEY_BYTES} (make one with \`openssl rand -base64 32\`)` };
  return { key: new Uint8Array(key) };
}

/** What a profile of `kind` is sealed as. */
export type SealKind = "secret" | "info";

const aad = (name: string, kind: SealKind) => Buffer.concat([Buffer.from([VERSION]), Buffer.from(kind === "info" ? `info:${name}` : name, "utf8")]);

/** Seal `vars` for the profile `name` (of `kind`, a secret by default). */
export function seal(key: Uint8Array, name: string, vars: Record<string, string>, kind: SealKind = "secret"): Buffer {
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(aad(name, kind));
  const ct = Buffer.concat([c.update(JSON.stringify(vars), "utf8"), c.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, c.getAuthTag(), ct]);
}

/** Open what `seal` made for `name` (of `kind`). Throws when the key, the name, the kind or the bytes do not match. */
export function open(key: Uint8Array, name: string, sealed: Uint8Array, kind: SealKind = "secret"): Record<string, string> {
  const b = Buffer.from(sealed);
  if (b.length < 1 + IV_BYTES + TAG_BYTES || b[0] !== VERSION) throw new Error("not a sealed profile");
  const d = createDecipheriv("aes-256-gcm", key, b.subarray(1, 1 + IV_BYTES));
  d.setAAD(aad(name, kind));
  d.setAuthTag(b.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES));
  let text: string;
  try {
    text = Buffer.concat([d.update(b.subarray(1 + IV_BYTES + TAG_BYTES)), d.final()]).toString("utf8");
  } catch {
    throw new Error("it does not open with this key");
  }
  const doc = JSON.parse(text) as unknown;
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("not a sealed profile");
  return Object.fromEntries(Object.entries(doc as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
}
