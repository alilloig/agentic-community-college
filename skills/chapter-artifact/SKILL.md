---
name: chapter-artifact
description: ACC-owned conventions and templates for the HTML artifacts generated at runtime, one page per chapter plus one lesson summary. The course-conductor reads references/conventions.md (its absolute path arrives as artifact_conventions_path in the nextChapter envelope) before it writes each artifact. Use when writing, reviewing, or fixing an ACC chapter artifact or summary artifact, or when the user asks "what does an ACC artifact look like", "check this artifact against the conventions", or "regenerate the summary page".
---

# Chapter Artifact Skill

ACC never pre-authors artifacts. The conductor generates them at runtime, in the learner's workspace, from the code it just wrote. This skill holds the rules and the templates so every artifact looks and reads the same across courses.

Files:

- `references/conventions.md`: the rules. File rules, visual tokens, fixed section order for the chapter page and the summary page, content rules, and a checklist.
- `templates/chapter.html.tmpl`: skeleton for one chapter page.
- `templates/summary.html.tmpl`: skeleton for the lesson summary page.

## Who uses this and when

**The course-conductor, at runtime.** After a chapter's verification command passes, the conductor:

1. Reads `artifact_conventions_path` (the absolute path of `references/conventions.md`, returned by `nextChapter`).
2. Copies the shape of `templates/chapter.html.tmpl`, fills every `{{ placeholder }}`, and removes the template comments.
3. Writes the result to `artifact_path` (`<workspace>/artifacts/NN-<id>.html`).
4. Calls `verifyChapter`. The MCP records the artifact path in state when the file exists.

After the e2e gate, the conductor does the same with `templates/summary.html.tmpl` and writes `summary_artifact_path` (`<workspace>/artifacts/summary.html`).

**Lesson authors, at validation time.** Open a generated artifact next to the conventions and check the "Checklist" part. A page that fails the checklist means the chapter brief or the tests need work, not the template.

**Anyone reviewing an artifact.** Run the checklist. The most common defects: snippets rewritten instead of copied, a generic diagram instead of this chapter's flow, test names invented instead of read from the test files.

## Rules in one screen

- One self-contained HTML file. No `<script src>`, no `<link href>`, no `@import`, no web fonts, no images from URLs. Inline SVG only.
- System font stack, dark theme with the ACC tokens, max-width 1100px, mobile responsive.
- Chapter page, in order: header (lesson title, "Chapter N of M", chapter title, key idea), What was built, How it works (inline SVG, at most 8 boxes, drawn for this chapter), The code (2 to 4 verbatim snippets with a why-caption), Tests that prove it, Next, footer navigation.
- Summary page, in order: header (lesson title, completed date, e2e status), What you built (paragraph + final architecture SVG), chapter cards linking `NN-<id>.html`, Most important learnings (5 to 8 bullets), Where to go next.
- Prose stays short. The diagram and the snippets carry the explanation.

The full text is in `references/conventions.md`. Read it before you write or judge a page.
