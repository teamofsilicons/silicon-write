# Writings design adaptation

Date: 2026-10-17

final result: passed

## Reference and implementation

Reference: https://writings.teamofsilicons.com/p/mv2o9xtfokwzjv6f, inspected in the existing signed-in Chrome session. The reference supplied composition and interaction direction; its private article content was not copied into Write.

Write now uses the reference's warm paper, quiet 56px header, 700px reading column, large Hedvig title, and compact contextual controls. The library uses horizontal navigation and a narrow editorial list. Existing sharing, history, modes, and formatting remain available.

Comments extend that visual language with flat margin threads, hairlines, blue quoted passages, small author details, compact replies, and ink actions. Below the wide-screen breakpoint the panel overlays the page; phones use a bottom sheet.

## Visual evidence

Local, ignored evidence under `.dev/design-reference/`:

- `01-writings-editor.png`, `02-writings-history.png`, `03-writings-timeline.png`: reference captures.
- `04-write-editor.png`, `05-write-comments.png`, `09-write-library.png`: implementation captures.
- `06-write-mobile.png`, `07-write-mobile-comments.png`, `08-write-mobile-composer.png`: phone layout and composer.
- `comparison-desktop.png`: combined reference and implementation, aligned at the same 1728px width and cropped to the common 940px viewport height for comparison.

The combined comparison confirms the reading-column alignment, type hierarchy, whitespace, and header treatment. Different document text and Write-specific actions are intentional. No outstanding high- or medium-severity visual issues were found.

## Browser verification

Used the user's Chrome profile through the computer-use tools and a private synthetic local document. Verified title editing, typing, reload persistence, selected-text and section comments, reply, resolve, resolved-tab lookup, reopen, mention picker, quote formatting, reading mode, history, library navigation, and search. Suggesting produced a visible review badge and proposal; rejecting restored the original draft.

At 390×844 the document has no horizontal overflow. The measured comment composer stays within the viewport at 390×844 and 390×500 (bottom 484.25px in the latter). Viewport overrides were reset after testing. This is responsive Chrome verification, not a physical-phone keyboard test.

The browser pass exposed two defects, both repaired: composer coordinates could reset on a render; section comments could become orphaned after quote formatting. The original section comment now reconnects after a fresh thread read. The backend repair uses causal history and refuses unrelated copies and ambiguous splits.

## Validation

- `pnpm lint`, `pnpm typecheck`, `pnpm build`: passed.
- Web unit tests: 55 passed.
- `cargo test --workspace --locked`: passed.
- API strict clippy: passed.
- Focused real API regression tests: 3 passed, including section wrap/unwrap and unrelated-copy rejection.
- Deployment unit tests: 12 passed.

Existing browser-suite selectors were adapted to the new menus, collapsed formatting, and header sync state. The standalone Playwright suite was not rerun; browser interaction checks used the requested Chrome session.
