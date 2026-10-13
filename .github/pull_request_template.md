## What and why

<!-- What does this change, and why? Link the issue it addresses. -->

## How it was tested

<!-- Unit tests, smoke test (which runtime), deck checks (presenter / viewer / static, light / dark), phone page. -->

## Checklist

- [ ] CI passes.
- [ ] If `src/deck/` or `src/shared/` changed: rebuilt and committed `_extensions/live-questions/live-questions.js` (`bun run build:deck`).
- [ ] Behavior changes are reflected in README.md and/or SPEC.md.
- [ ] Protocol changes update `src/shared/protocol.ts` and SPEC.md together, with a `PROTOCOL_VERSION` decision (see CONTRIBUTING.md).
- [ ] CHANGELOG.md has an entry under "Unreleased".
- [ ] Screenshots attached for visible changes.
