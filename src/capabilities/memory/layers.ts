import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readHomeFile } from "./home.ts";

/**
 * PROFILES: per-chat overlays of her files in home/ (docs/design.md §3). The one resolver every reader and writer
 * of an A-layer file goes through (a test holds them to it: test/layers.test.ts).
 *
 * A profile is a folder `home/profiles/<name>/` holding only the files it REPLACES, at their usual paths
 * (`profiles/work/directives.md` replaces `directives.md`), and `profile.yaml`:
 *
 *   label: Work hours          # optional, what the owner calls it
 *   hides: [trip-planning]     # optional, base playbooks chats on this profile do not see
 *   hidden_packs: [ExamplePack] # optional, sticker packs chats on this profile are not offered
 *
 * Every other file comes from the BASE (home/ as it is). Each chat uses one profile or none (`chats.profile`),
 * from its next turn. A-layer files, the ones a profile may overlay: persona/public.md, persona/private.md,
 * directives.md, memory/private.md, chats/<id>.md, playbooks/<name>.md, stickers/preferences.md,
 * stickers/<pack>.yaml. Never policy.yaml or inbound.yaml.
 *
 * A LOGICAL path is what she, her tools and the allow-list see (`directives.md`); the PHYSICAL path is where its
 * text is (`profiles/work/directives.md`, or the logical path itself for the base). The rules:
 *
 *   read    the profile's own copy if it has one, else the base's; a base playbook the profile hides reads as
 *           absent.
 *   write   to the copy in effect (the profile's own copy if it has one, else the base); a NEW file goes to the
 *           base, except a playbook whose name the profile hides, which goes to the profile (so it shows again,
 *           as the profile's own).
 *   lists   the playbooks and sticker packs in effect: the base's, minus hidden playbooks, with the profile's
 *           own replacing or adding to them.
 *
 * SHE NEVER KNOWS profiles exist: callers speak in logical paths, and nothing here reaches her prompt, a tool's
 * description or its result. Privacy rules (memory/home.ts `refusal`) apply to the logical path.
 */

/** A playbook's name: its file name without `.md` (re-exported by agent/playbooks.ts). */
export const PLAYBOOK_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** A profile's name: its folder's. */
export const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const PROFILES_DIR = "profiles";
export const PROFILE_FILE = "profile.yaml";
export const profileDir = (name: string) => `${PROFILES_DIR}/${name}`;
export const profileFile = (name: string) => `${profileDir(name)}/${PROFILE_FILE}`;

export interface ProfileMeta {
  name: string;
  label?: string;
  /** Base playbooks (by name) chats on this profile do not see. */
  hides: string[];
  /**
   * Sticker packs (by pack name) chats on this profile are not offered: hidden from the console, or taken out by
   * her `remove_sticker_pack` in a chat on the profile (stickers/index.ts), Base untouched for other chats.
   */
  hidePacks?: string[];
}

/** A sticker set name (stickers/library.ts `PACK_NAME`). */
const PACK = /^[A-Za-z0-9_]{1,64}$/;

/** profile.yaml's text for `meta`. */
export function profileYaml(meta: Omit<ProfileMeta, "name">): string {
  const lines = [];
  if (meta.label) lines.push(`label: ${JSON.stringify(meta.label)}`);
  lines.push(`hides: [${[...new Set(meta.hides)].sort().map((h) => JSON.stringify(h)).join(", ")}]`);
  if (meta.hidePacks?.length) lines.push(`hidden_packs: [${[...new Set(meta.hidePacks)].sort().map((h) => JSON.stringify(h)).join(", ")}]`);
  return `${lines.join("\n")}\n`;
}

/** A profile as its profile.yaml says (a broken file reads as no label and no hides), or null when it does not exist. */
export function readProfile(home: string, name: string): ProfileMeta | null {
  if (!PROFILE_NAME.test(name)) return null;
  const text = readHomeFile(home, profileFile(name));
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(text);
  } catch {
    raw = null;
  }
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const label = typeof o.label === "string" && o.label.trim() ? o.label.trim() : undefined;
  const hides = Array.isArray(o.hides) ? o.hides.filter((h): h is string => typeof h === "string" && PLAYBOOK_NAME.test(h)) : [];
  const hidePacks = Array.isArray(o.hidden_packs) ? o.hidden_packs.filter((h): h is string => typeof h === "string" && PACK.test(h)) : [];
  return { name, ...(label ? { label } : {}), hides, ...(hidePacks.length ? { hidePacks } : {}) };
}

/** Every profile, by name. */
export function listProfiles(home: string): ProfileMeta[] {
  const dir = join(home, PROFILES_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => PROFILE_NAME.test(n))
    .sort()
    .flatMap((n) => {
      const p = readProfile(home, n);
      return p ? [p] : [];
    });
}

/** The A-layer files by logical path: what a profile may overlay. */
export function isLayered(logical: string): boolean {
  if (["persona/public.md", "persona/private.md", "directives.md", "memory/private.md", "stickers/preferences.md"].includes(logical)) return true;
  if (/^chats\/-?\d{1,20}\.md$/.test(logical)) return true;
  // Any pack file the sticker index reads (stickers/library.ts `packSources`): .yaml or .yml, whatever its name.
  if (/^stickers\/[^/]+\.ya?ml$/.test(logical)) return true;
  const pb = /^playbooks\/(.+)\.md$/.exec(logical);
  return !!pb && PLAYBOOK_NAME.test(pb[1]!);
}

const playbookOf = (logical: string) => /^playbooks\/(.+)\.md$/.exec(logical)?.[1];
/** A pack file's name without its extension: its pack, as packs are named (stickers/library.ts `packFileName`). */
export const packOfFile = (logical: string) => /^stickers\/([^/]+)\.ya?ml$/.exec(logical)?.[1];

export interface Resolved {
  logical: string;
  /** Where the text in effect is (or would be). */
  physical: string;
  /** Whose copy is in effect: the profile's own, or the base's. */
  from: "base" | "profile";
  /** A base playbook or sticker pack the profile hides: she does not see it. */
  hidden: boolean;
  /** The file in effect exists. */
  exists: boolean;
}

export interface LayerFile {
  logical: string;
  physical: string;
  from: "base" | "profile";
}

/**
 * home/ as one chat sees it: the base, overlaid by its profile (null: the base alone). Logical paths in, the
 * file in effect out.
 */
export class HomeLayers {
  constructor(
    readonly home: string,
    public profile: ProfileMeta | null = null,
  ) {}

  /**
   * Read the profile's profile.yaml again (its hides), after a write that changed it in this turn (stickers/index.ts
   * `remove_sticker_pack`). The profile itself stays the one the turn began with.
   */
  refresh(): void {
    if (this.profile) this.profile = readProfile(this.home, this.profile.name) ?? this.profile;
  }

  /** The base alone. */
  static base(home: string): HomeLayers {
    return new HomeLayers(home);
  }

  /** `name`'s layers; a profile that does not exist (or no name) gives the base. */
  static of(home: string, name: string | null | undefined): HomeLayers {
    return new HomeLayers(home, name ? readProfile(home, name) : null);
  }

  get name(): string | null {
    return this.profile?.name ?? null;
  }

  /** The profile's own path for `logical` (whether or not it exists). */
  ownPath(logical: string): string | null {
    return this.profile ? `${profileDir(this.profile.name)}/${logical}` : null;
  }

  /** Whether the profile has its own copy of `logical`. */
  hasOwn(logical: string): boolean {
    const own = this.ownPath(logical);
    return !!own && isLayered(logical) && existsSync(join(this.home, own));
  }

  /** The base playbook or pack `logical` is hidden by the profile (and the profile has no copy of its own). */
  isHidden(logical: string): boolean {
    if (!this.profile || this.hasOwn(logical)) return false;
    const pb = playbookOf(logical);
    if (pb) return this.profile.hides.includes(pb);
    const pack = packOfFile(logical);
    return !!pack && !!this.profile.hidePacks?.includes(pack);
  }

  /** The sticker pack (by name) the profile hides. */
  hidesPack(pack: string): boolean {
    return !!this.profile?.hidePacks?.includes(pack);
  }

  resolve(logical: string): Resolved {
    if (this.hasOwn(logical)) return { logical, physical: this.ownPath(logical)!, from: "profile", hidden: false, exists: true };
    const hidden = this.isHidden(logical);
    return { logical, physical: logical, from: "base", hidden, exists: !hidden && existsSync(join(this.home, logical)) };
  }

  /** The text in effect, or null (absent, or hidden). */
  read(logical: string): string | null {
    const r = this.resolve(logical);
    if (r.hidden) return null;
    return readHomeFile(this.home, r.physical);
  }

  /** Where a write of `logical` goes (see the header). */
  writePath(logical: string): string {
    if (this.hasOwn(logical)) return this.ownPath(logical)!;
    if (this.profile && this.isHidden(logical)) return this.ownPath(logical)!;
    return logical;
  }

  /** The files in effect in `dir` (playbooks/, stickers/) matching `ok`, by logical path, sorted. */
  private filesIn(dir: string, ok: (file: string) => boolean): LayerFile[] {
    const names = (abs: string) => (existsSync(abs) ? readdirSync(abs).filter(ok) : []);
    const out = new Map<string, LayerFile>();
    for (const f of names(join(this.home, dir))) {
      const logical = `${dir}/${f}`;
      if (!this.isHidden(logical)) out.set(logical, { logical, physical: logical, from: "base" });
    }
    const own = this.profile ? join(this.home, profileDir(this.profile.name), dir) : null;
    if (own) for (const f of names(own)) out.set(`${dir}/${f}`, { logical: `${dir}/${f}`, physical: `${profileDir(this.profile!.name)}/${dir}/${f}`, from: "profile" });
    return [...out.values()].sort((a, b) => a.logical.localeCompare(b.logical));
  }

  /** The playbooks in effect. */
  playbookFiles(): LayerFile[] {
    return this.filesIn("playbooks", (f) => f.endsWith(".md") && PLAYBOOK_NAME.test(f.slice(0, -3)));
  }

  /**
   * The sticker pack files in effect: exactly the files the sticker index reads (stickers/library.ts
   * `packSources`: .yaml or .yml, whatever the name), the profile's replacing the base's of the same name, those it
   * hides left out. A profile's file describing a base pack under another name is matched by pack in
   * stickers/library.ts `scopeKeys`.
   */
  packFiles(): LayerFile[] {
    return this.filesIn("stickers", (f) => /\.ya?ml$/.test(f));
  }
}

/** `home` as a string (the base) or layers: the layers. */
export const layersOf = (h: string | HomeLayers): HomeLayers => (typeof h === "string" ? HomeLayers.base(h) : h);
