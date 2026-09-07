# ACC artifact conventions

Rules for every HTML artifact ACC produces at runtime: one page per chapter and one summary page per lesson. The conductor reads this file before it writes an artifact. Its absolute path arrives as `artifact_conventions_path` in the `nextChapter` envelope. Authors and reviewers use the same rules to judge a page.

## 1. File rules

- One self-contained HTML file per artifact. Chapter pages live at `<workspace>/artifacts/NN-<id>.html`; the summary lives at `<workspace>/artifacts/summary.html`. The MCP gives the exact paths as `artifact_path` and `summary_artifact_path`. Never choose your own.
- No external assets. No `<script src>`, no `<link href>`, no `@import`, no web fonts, no images loaded from a URL. Inline SVG is the only graphic format.
- No JavaScript is required. The page must render fully with scripts disabled. Prefer no `<script>` at all.
- Links between artifacts use relative filenames (`02-tools.html`, `summary.html`). Links to external documentation are allowed only as plain `<a href>` text links inside "Next" and "Where to go next". A link is not an asset; a loaded resource is.
- HTML-escape every code snippet: `&` becomes `&amp;`, `<` becomes `&lt;`, `>` becomes `&gt;`, `"` becomes `&quot;`.
- Start from the template in `templates/`. Fill every `{{ placeholder }}`. Remove the template comments.
- Encoding `utf-8`, `lang="en"` unless the lesson is in another language, `<meta name="viewport">` present.

## 2. Visual rules

- System font stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`. Code: `ui-monospace, "SF Mono", Menlo, monospace`.
- Dark theme. Declare these tokens in `:root` and use them everywhere:

```css
--bg:#0e1117; --panel:#161b22; --panel-2:#1f242d; --border:#2a313c;
--fg:#d5d9e0; --muted:#8b94a7; --accent:#79b8ff; --good:#6dd56d;
--warn:#e6c07b; --bad:#e08585; --code-bg:#0b0e13;
```

- `body` max-width 1100px, centered. One `@media (max-width: 720px)` block: single column, smaller padding, horizontally scrollable `<pre>`.
- Semantic HTML: `<header>`, one `<section>` per part with an `<h2>`, `<figure>` + `<figcaption>` for diagrams and snippets, `<footer>` for navigation.
- One accent color for emphasis (`--accent`). Green, amber, and red are reserved for status (`--good`, `--warn`, `--bad`).
- SVG styling goes through CSS classes defined in the page `<style>` (`.box`, `.box.hi`, `.lbl`, `.sub`, `.arrow`, `.edge`). Inline SVG in HTML can read the CSS tokens through those classes.

## 3. Chapter page structure (fixed order)

1. **Header.** Lesson title, "Chapter N of M", chapter title, key idea callout. The key idea is the `key_idea` from `chapters.json`, verbatim.
2. **What was built.** One paragraph. What the code does now that it did not do before this chapter.
3. **How it works.** One inline SVG diagram, boxes and arrows, of the data or control flow of THIS chapter's code. Draw it for this chapter; never reuse a generic architecture picture. At most 8 boxes. Label every arrow. Give the box that carries the key idea the `hi` class. One caption line under the figure.
4. **The code.** 2 to 4 snippets, taken verbatim from the files written in the workspace during this chapter. Each snippet is a `<figure class="snippet">` with a one-line caption that names the file and says why the snippet matters. Wrap the code in `<pre><code>`. 5 to 25 lines per snippet. Cut with `// ...` where needed. Never rewrite code for the page.
5. **Tests that prove it.** One list item per test in the chapter's test files: the test name in `<code>` plus one line on what it asserts. Read the names from the test files. Do not invent them.
6. **Next.** One line on what the next chapter adds. On the last chapter, say the e2e gate runs next.
7. **Footer navigation.** Relative links to the previous and next artifact files. The filenames come from `artifact_nav` in the `nextChapter` envelope: `prev` is absent on chapter 1, and `next` is `summary.html` on the last chapter.

## 4. Summary page structure (fixed order)

1. **Header.** Lesson title, completed date, e2e status: `passed`, `skipped for credentials`, or `failed`. Color the status with `--good`, `--warn`, or `--bad`. When the e2e was skipped, name the missing variable.
2. **What you built.** One paragraph plus one inline SVG of the final architecture: every chapter's contribution in one picture. At most 10 boxes.
3. **Chapters.** One card per entry of the `artifacts` map in the `nextChapter` done envelope, in chapter order, linking to `NN-<id>.html`. Each card shows the chapter number, the title, and the key idea.
4. **Most important learnings.** 5 to 8 bullets. Each bullet is one concrete takeaway the learner can restate without the page.
5. **Where to go next.** 3 to 5 pointers: docs sections not covered, features to add, ideas to extend the app.

## 5. Content rules

- The page explains the code that exists in the workspace. Nothing else. No history of the attempts, no chat transcript.
- Prose is short. The diagram and the snippets carry the explanation.
- Write for a learner who reads the page a week later with no chat context.
- Do not repeat the chapter brief. The brief says what to build; the page shows how it was built.
- Name files by their workspace-relative path (`src/agent.ts`).

## 6. Checklist before verifyChapter

- [ ] File exists at `artifact_path` (or `summary_artifact_path`).
- [ ] No `<script src`, `<link href`, `@import`, or `url(http` in the file.
- [ ] Token block present in `:root`.
- [ ] All sections present, in order. No `{{ placeholder }}` left.
- [ ] Snippets are verbatim from the workspace and HTML-escaped.
- [ ] Every listed test exists in the chapter's test files.
- [ ] Diagram has at most 8 boxes and every arrow has a label.
- [ ] Footer links point at real relative filenames.
