## No Such Thing as "Flaky Tests"

Intermittently failing tests must always be root-caused and addressed as a product defect (code) or a production-line defect (test). We do not acknowledge the existence of such a thing as "flaky tests".

## Red/Green Discipline

All bug fixes must have a test that reproduces the defect before modifying code. Red/Green—always.

## Fix the Failure Mode, Don't Just Squash the Bug

Whenever we detect an issue, reason broadly about the defect class and write a test guard for the defect class. Prefer securing surfaces — including suggesting an architectural refactor to eliminate the failure mode categorically — over squashing individual bugs.

## Feature Test Coverage

When adding new features, ensure test coverage over the new surface to prevent undetected regressions.

## Derivation Over Duplication: No Drift Surfaces

Identify and eliminate drift surfaces — duplicate sources of truth. Ensure that everything that can be derived is derived from a single source of truth and has a single canonical implementation. Do not introduce duplication.

## Zero Tolerance for Warnings, Errors, and Test Failures

We do not tolerate warnings, errors, or test failures in this project.

There are no pre-existing failures or warnings, and you will not allow any to enter the codebase. Thank you.

## BPMN Models need DI

All BPMN Models need DI for rendering for humans.

## No `as T` Type Assertions

Type assertions (`as T`) bypass the type system and are banned across the authored TypeScript source. This is enforced in CI by a Biome GritQL plugin (`plugins/no-unsafe-type-assertion.grit`, wired via `biome.json`; run `npm run lint`). Use a type guard, declaration-site annotation, narrowing, or `satisfies` instead. Exceptions: `as const` and `import`/`export` renames are allowed. If a cast is genuinely unavoidable (e.g. an untyped host/runtime boundary), add a `// biome-ignore lint/plugin: <reason>` comment with a concrete justification.
