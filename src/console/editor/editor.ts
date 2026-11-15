/**
 * The Home page's editor (DESIGN.md "Home"), bundled on demand by the console (editor/bundle.ts) and served at
 * `/editor.js`, loaded only on that page. Everything here is an UPGRADE: the page works without it, as a plain
 * textarea in a form that posts to `/home/save`.
 *
 *   textarea[data-editor]   (with `data-readonly`: a read-only view of the text, an inherited file in a profile)
 *                           becomes a CodeMirror editor (markdown or yaml, by `data-lang`), the textarea kept
 *                           hidden and in step so the form posts what the editor holds. Lines that differ from
 *                           `data-saved` (the file as last saved) are marked in the gutter, and removed lines
 *                           shown inline, read-only (@codemirror/merge's unified view against the saved text);
 *                           `[data-dirty]` says "Unsaved +n −m". Ctrl+S / ⌘S submits the form. Leaving with
 *                           unsaved changes asks first.
 *   [data-merge]            the conflict view: two texts side by side (`data-a`, `data-b`, ids of <template>s),
 *                           the right one editable and written back into the textarea `data-resolve` names. (A
 *                           history entry's diff is not drawn here: the server draws it, GitHub-style, ghdiff.ts.)
 *
 *   #first-change           a history diff shows the whole file: its first changed line is brought into view.
 *
 * A boosted navigation swaps the body, not the document: everything here outlives the page it was made for. So the
 * page-wide listeners (the leave guards, the viewport's resize) are added ONCE, below, and ask `live`, the editors on
 * the page now; an editor a swap took away is destroyed (`prune`), so CodeMirror's own window and document listeners
 * go with it. Only navigations ask before leaving: the page's own background requests (the watch, every 5 s) never.
 *
 * On a phone, the on-screen keyboard shrinks the page (html.ts `page`, `interactive-widget=resizes-content`; the
 * pane's height in style.css is in `dvh`): the editor shrinks with it, and the line with the caret is brought back
 * into view.
 *
 * Colours are GitHub's dark diff colours, the same as ghdiff.ts's in style.css.
 *
 * It never changes the text by itself: no formatting, no trimming, no line-ending rewrite. What is saved is
 * byte for byte what was typed.
 */
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, LanguageSupport, syntaxHighlighting } from "@codemirror/language";
import { getChunks, MergeView, unifiedMergeView } from "@codemirror/merge";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

const highlight = HighlightStyle.define([
  { tag: t.heading, color: "#eceae7", fontWeight: "600" },
  { tag: [t.strong], fontWeight: "600" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.list, t.quote, t.meta, t.processingInstruction], color: "#87827b" },
  { tag: [t.monospace, t.string], color: "#c3d6a0" },
  { tag: [t.link, t.url], color: "#7aa2f7" },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: "#7aa2f7" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#ead084" },
  { tag: t.comment, color: "#87827b", fontStyle: "italic" },
]);

/** The console's palette (style.css :root), so the editor reads as part of the page. */
const theme = EditorView.theme(
  {
    "&": { color: "var(--ink)", backgroundColor: "var(--surface)", fontSize: "14px", height: "100%" },
    ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.6" },
    ".cm-content": { caretColor: "var(--accent)", padding: "var(--s3) 0" },
    ".cm-line": { padding: "0 var(--s4) 0 var(--s2)" },
    "&.cm-focused": { outline: "none" },
    ".cm-gutters": { backgroundColor: "var(--surface)", color: "var(--ink-faint)", border: "none" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--ink-dim)" },
    ".cm-activeLine": { backgroundColor: "rgb(255 255 255 / 0.025)" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "rgb(122 162 247 / 0.28)" },
    ".cm-cursor": { borderLeftColor: "var(--accent)" },
    ".cm-searchMatch": { backgroundColor: "rgb(234 208 132 / 0.25)" },
    ".cm-panels": { backgroundColor: "var(--surface-2)", color: "var(--ink)" },
    ".cm-panels input, .cm-panels button": { font: "inherit", fontSize: "13px" },
    // Unsaved changes (the unified view against the saved text) and the conflict view, in GitHub's colours.
    // @codemirror/merge's base theme underlines a changed word with `&dark.cm-merge-b .cm-changedText` (four
    // classes once scoped); `.cm-editor` and `.cm-content` make these more specific, so they win. (`&dark` itself
    // is refused outside a base theme.)
    "&.cm-editor.cm-merge-b .cm-content .cm-changedLine, & .cm-content .cm-inlineChangedLine": { backgroundColor: "rgb(46 160 67 / 0.15)" },
    "&.cm-editor.cm-merge-b .cm-content .cm-changedText": { background: "rgb(46 160 67 / 0.4)", borderRadius: "2px" },
    "&.cm-editor.cm-merge-a .cm-content .cm-changedLine, & .cm-content .cm-deletedChunk": { backgroundColor: "rgb(248 81 73 / 0.1)" },
    "&.cm-editor.cm-merge-a .cm-content .cm-changedText, &.cm-editor .cm-content .cm-deletedChunk .cm-deletedText": { background: "rgb(248 81 73 / 0.4)", borderRadius: "2px" },
    "&.cm-editor.cm-merge-b .cm-content .cm-deletedText": { background: "rgb(248 81 73 / 0.4)" },
    ".cm-changeGutter": { width: "3px", paddingLeft: "0" },
    "&.cm-editor.cm-merge-b .cm-gutters .cm-changedLineGutter": { background: "#3fb950" },
    "&.cm-editor.cm-merge-a .cm-gutters .cm-changedLineGutter, &.cm-editor .cm-gutters .cm-deletedLineGutter": { background: "#f85149" },
    ".cm-collapsedLines": { backgroundColor: "var(--surface-2)", color: "var(--ink-faint)", fontFamily: "var(--sans)", fontSize: "12px" },
  },
  { dark: true },
);

/**
 * Markdown without `markdown()`'s extras: they embed the HTML, CSS and JavaScript grammars (for HTML blocks and
 * fenced code), which tripled the bundle for files that hold neither.
 */
function language(name: string | undefined): Extension {
  return name === "yaml" ? yaml() : new LanguageSupport(markdownLanguage);
}

function base(lang: string | undefined, editable: boolean): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    drawSelection(),
    EditorView.lineWrapping,
    syntaxHighlighting(highlight),
    language(lang),
    theme,
    EditorState.readOnly.of(!editable),
    EditorView.editable.of(editable),
    ...(editable ? [history(), highlightActiveLine(), search({ top: true }), highlightSelectionMatches(), keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab])] : []),
  ];
}

/** Lines added and removed between `a` and `b`, as the unsaved counter shows them. */
function counts(saved: string, now: string): { add: number; del: number } {
  const lines = (s: string) => (s === "" ? 0 : s.split("\n").length);
  let add = 0;
  let del = 0;
  const chunks = getChunksOf(saved, now);
  for (const c of chunks) {
    del += lines(saved.slice(c.fromA, c.toA).replace(/\n$/, ""));
    add += lines(now.slice(c.fromB, c.toB).replace(/\n$/, ""));
  }
  return { add, del };
}

function getChunksOf(a: string, b: string) {
  // getChunks needs an editor state with a merge view; a throwaway unified one is the cheapest way to ask.
  const state = EditorState.create({ doc: b, extensions: [unifiedMergeView({ original: a, mergeControls: false })] });
  return getChunks(state)?.chunks ?? [];
}

/**
 * An editor on the page: its view (or merge view) and the element it lives in; for an editable one, whether it holds
 * unsaved changes, the form that saves them, and how to forget them ("Discard your unsaved changes?" said yes).
 */
interface Live {
  el: Element;
  destroy(): void;
  view?: EditorView;
  unsaved?: () => boolean;
  discard?: () => void;
  form?: HTMLFormElement | null;
}
const live = new Set<Live>();

/** Destroy the editors a swap took off the page (their views' listeners on window and document go with them). */
function prune(): void {
  for (const l of live)
    if (!document.contains(l.el)) {
      l.destroy();
      live.delete(l);
    }
}

/** The editors on the page with unsaved changes, but for the one whose own form `elt` is (saving is not leaving). */
function unsaved(elt?: Element): Live[] {
  return [...live].filter((l) => l.unsaved?.() && document.contains(l.el) && !(elt && l.form && (elt === l.form || l.form.contains(elt))));
}

function upgradeEditor(area: HTMLTextAreaElement): void {
  const form = area.form;
  let saved = area.dataset.saved ?? area.value;
  const dirtyEl = document.querySelector<HTMLElement>("[data-dirty]");
  const showDirty = (now: string) => {
    if (!dirtyEl) return;
    if (now === saved) {
      dirtyEl.hidden = true;
      dirtyEl.textContent = "";
      return;
    }
    const c = counts(saved, now);
    dirtyEl.hidden = false;
    dirtyEl.innerHTML = `Unsaved <span class="c-done">+${c.add}</span> <span class="c-failed">−${c.del}</span>`;
  };
  const host = document.createElement("div");
  host.className = "cm-host";
  area.insertAdjacentElement("afterend", host);
  area.hidden = true;
  // A file a profile inherits from Base: shown, not edited (home.ts `layerBar`).
  if (area.hasAttribute("data-readonly")) {
    const ro = new EditorView({ parent: host, state: EditorState.create({ doc: area.value, extensions: base(area.dataset.lang, false) }) });
    live.add({ el: host, view: ro, destroy: () => ro.destroy() });
    return;
  }
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: area.value,
      extensions: [
        ...base(area.dataset.lang, true),
        unifiedMergeView({ original: saved, mergeControls: false, highlightChanges: true, gutter: true, syntaxHighlightDeletions: true }),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          const now = u.state.doc.toString();
          area.value = now;
          showDirty(now);
        }),
        keymap.of([{ key: "Mod-s", preventDefault: true, run: () => (form?.requestSubmit(), true) }]),
      ],
    }),
  });
  showDirty(view.state.doc.toString());
  if (area.autofocus) view.focus();
  // A save that went through: the form's answer replaces the page (htmx), and the new page's editor starts from
  // the new saved text. Until then, leaving asks first (the guards below).
  form?.addEventListener("submit", () => {
    saved = area.value;
  });
  live.add({ el: host, view, destroy: () => view.destroy(), unsaved: () => area.value !== saved, discard: () => (saved = area.value), form });
}

// Leaving with unsaved changes asks first: a load or a close (beforeunload)...
window.addEventListener("beforeunload", (e) => {
  if (unsaved().length) e.preventDefault();
});
// ...and an htmx navigation (a boosted link or form), which is not an unload. htmx asks `htmx:confirm` before EVERY
// request, the page's own too: an element with its own hx-get / hx-post (the watch's poll) is not leaving.
document.addEventListener("htmx:confirm", (e) => {
  const ev = e as CustomEvent<{ elt: Element; issueRequest: () => void }>;
  if (ev.detail.elt.matches("[hx-get], [hx-post]")) return;
  const dirty = unsaved(ev.detail.elt);
  if (!dirty.length) return;
  e.preventDefault();
  if (window.confirm("Discard your unsaved changes?")) {
    dirty.forEach((l) => l.discard?.());
    ev.detail.issueRequest();
  }
});
// The keyboard opening (or the window shrinking) keeps the caret's line in view in the editor being typed in.
(window.visualViewport ?? window).addEventListener("resize", () => {
  for (const l of live) {
    const v = l.view;
    if (v?.hasFocus) v.dispatch({ effects: EditorView.scrollIntoView(v.state.selection.main.head, { y: "nearest", yMargin: 24 }) });
  }
});

function text(id: string | undefined): string {
  const tpl = id ? document.getElementById(id) : null;
  return tpl instanceof HTMLTemplateElement ? (tpl.content.textContent ?? "") : "";
}

function upgradeMerge(el: HTMLElement): void {
  const resolve = el.dataset.resolve ? document.querySelector<HTMLTextAreaElement>(`textarea[name="${el.dataset.resolve}"]`) : null;
  const fallback = el.querySelector(".merge-fallback");
  if (fallback) (fallback as HTMLElement).hidden = true;
  const merge = new MergeView({
    parent: el,
    a: { doc: text(el.dataset.a), extensions: base(el.dataset.lang, false) },
    b: {
      doc: text(el.dataset.b),
      extensions: [
        ...base(el.dataset.lang, !!resolve),
        ...(resolve ? [EditorView.updateListener.of((u) => u.docChanged && (resolve.value = u.state.doc.toString()))] : []),
      ],
    },
    highlightChanges: true,
    gutter: true,
    collapseUnchanged: el.dataset.collapse === "0" ? undefined : { margin: 3, minSize: 6 },
    ...(resolve ? { revertControls: "a-to-b" as const } : {}),
  });
  if (resolve) resolve.value = merge.b.state.doc.toString();
  live.add({ el, view: merge.b, destroy: () => merge.destroy() });
}

function init(root: ParentNode): void {
  prune();
  root.querySelectorAll<HTMLTextAreaElement>("textarea[data-editor]:not([data-up])").forEach((a) => {
    a.dataset.up = "1";
    upgradeEditor(a);
  });
  root.querySelectorAll<HTMLElement>("[data-merge]:not([data-up])").forEach((m) => {
    m.dataset.up = "1";
    upgradeMerge(m);
  });
  const first = root instanceof Element && root.id === "first-change" ? root : root.querySelector("#first-change");
  first?.scrollIntoView({ block: "center" });
}

init(document);
// A boosted navigation swaps the body: upgrade what it brought.
document.addEventListener("htmx:load", (e) => init((e as CustomEvent<{ elt: Element }>).detail.elt));
