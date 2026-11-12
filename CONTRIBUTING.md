# Contributing

Read [AGENTS.md](AGENTS.md) and [docs/design.md](docs/design.md) before changing code. Use Bun and the
locked dependencies:

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun scripts/e2e-fake.ts
bun scripts/e2e-openai-compat.ts
bun scripts/e2e-control.ts
bun scripts/e2e-jobs.ts
bun scripts/e2e-computer.ts
bun scripts/e2e-groups.ts
bun scripts/e2e-media.ts
```

Unit tests use fresh in-memory databases. Integration checks run the server and detached runner children
against local fake services. The Claude checks use the installed Claude Code CLI with a fake Anthropic
API. The OpenAI-compatible check uses the production agent-runtime adapter with a local Chat Completions
endpoint; it exercises tool calls, policy refusal, persisted context, backend switching and cancellation.
Run these with an isolated environment, without production capability settings or credentials.

After changing the database schema, generate and commit its migration:

```bash
bun run db:generate
```

To inspect the console using made-up data:

```bash
bun scripts/console-fixture.ts
```

The project runs TypeScript directly with Bun and has no separate build or configured lint command.
Keep runtime data, credentials and personal information out of commits.
