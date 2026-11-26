import { html, raw, type Raw } from "./html.ts";

/**
 * The KEY / VALUE TABLE of the Secrets page's forms: one component for a new secret, a secret's Replace values, new
 * personal info and editing personal info (secrets.ts, info.ts). A row is one line on a wide screen, key |
 * description | value | ✕, under one row of column headers; under the phone breakpoint a row stacks (key and
 * description above, the value below) and the headers go. The form around it (`.sform`) is the one framed area.
 *
 * Its fields, as secrets-write.ts reads them:
 *   an existing key   its key is text, not editable; `a_<KEY>` its description (the note's `- KEY: what it is`
 *                     line; emptied: the line goes), `v_<KEY>` its value, `del_<KEY>` = 1 to remove it
 *   a new key         `nn_<i>` its key, `na_<i>` its description, `nv_<i>` its value
 *
 * A SECRET's value is never drawn: its box is empty, "unchanged" until something is typed. A PERSONAL-INFO value is
 * drawn into its box, masked (`.imasked`) until its profile's Show values is on (info.ts), or its own eye is pressed.
 *
 * New rows: the form starts with ONE empty row; "+ Add a row" (console.js) clones the table's `<template>`, numbers
 * its fields with the next index (`data-next`) and focuses its key; each new row's ✕ takes it out of the page. There
 * is no fixed number of rows: the server reads whatever indices were posted (up to `KV_MAX_NEW`).
 */

/** At most this many new rows in one write: bounds a request, far above anything typed by hand. */
export const KV_MAX_NEW = 100;

/** An existing key as the table draws it. `value`: personal info only (a secret's is never drawn). */
export interface KvKey {
  key: string;
  about?: string;
  value?: string;
}

/** Inputs for a key or a value: never remembered or corrected by the browser. */
const plain = raw(` autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"`);

/** An eye: the toggle at the end of a masked value's box. */
const EYE = raw(
  `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path class="slash" d="M4 4l16 16"/></svg>`,
);

/**
 * A personal-info value's box: one line, or a box of several lines for a value written on several; masked, with its
 * own eye (`.kveye`, console.js) to show this one value while editing, apart from the profile's Show values.
 */
function infoValue(key: string, value: string): Raw {
  const name = `v_${key}`;
  const box = value.includes("\n")
    ? html`<textarea name="${name}" class="imasked" rows="${String(Math.min(6, value.split("\n").length))}" aria-label="value of ${key}"${plain}>${value}</textarea>`
    : html`<input type="text" name="${name}" class="imasked" value="${value}" aria-label="value of ${key}"${plain}>`;
  return html`<span class="kvv kvvw">${box}<button type="button" class="kveye" aria-pressed="false" aria-label="show the value of ${key}" title="Show this value">${EYE}</button></span>`;
}

function existingRow(k: KvKey, kind: "secret" | "info"): Raw {
  const value =
    kind === "secret"
      ? html`<input type="text" name="v_${k.key}" class="kvv mono" placeholder="unchanged" aria-label="new value of ${k.key}"${plain}>`
      : infoValue(k.key, k.value ?? "");
  return html`<div class="kvr"><span class="kvk mono">${k.key}</span><input type="text" name="a_${k.key}" class="kvd" maxlength="120" value="${k.about ?? ""}" placeholder="What it is" aria-label="what ${k.key} is">${value}<label class="kvx" title="Remove ${k.key}"><input type="checkbox" name="del_${k.key}" value="1" aria-label="remove ${k.key}"><span aria-hidden="true">✕</span></label></div>`;
}

/** A new row, its fields numbered `i` (the template's: a placeholder console.js replaces). */
function newRow(i: string, kind: "secret" | "info"): Raw {
  return html`<div class="kvr kvnew"><input type="text" name="nn_${i}" class="kvk mono" maxlength="64" pattern="[A-Za-z_][A-Za-z0-9_]*" placeholder="KEY" aria-label="new key"${plain}><input type="text" name="na_${i}" class="kvd" maxlength="120" placeholder="What it is" aria-label="what it is (optional)"><input type="text" name="nv_${i}" class="kvv${kind === "secret" ? " mono" : ""}" placeholder="Value" aria-label="value"${plain}><button type="button" class="kvx kvdrop" title="Remove this row" aria-label="remove this row">✕</button></div>`;
}

/** The table: its existing keys, one empty new row, the template for more, and "+ Add a row". */
export function kvTable(kind: "secret" | "info", keys: readonly KvKey[] = []): Raw {
  return html`<div class="kvtab" data-next="1"><div class="kvh" aria-hidden="true"><span>Key</span><span>Description</span><span>Value</span><span></span></div>
${keys.map((k) => existingRow(k, kind))}${newRow("0", kind)}<template class="kvt">${newRow("__i__", kind)}</template></div>
<button type="button" class="kvadd">+ Add a row</button>`;
}
