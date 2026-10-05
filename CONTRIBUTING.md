# Contributing

Bug reports and focused pull requests are welcome at
https://github.com/j-koester/pi-durable-postgres.

## Local checks

Use Node >=22.19.0 and the pnpm version in package.json:

```bash
corepack enable
pnpm install --frozen-lockfile
docker compose up -d --wait
pnpm lint:types
pnpm test
pnpm test:package
```

Tests create isolated temporary schemas. Use a disposable database; override its
URL with PI_DURABLE_POSTGRES_TEST_URL. Keep credentials out of reports.

For each bug fix, add a regression test that fails without the fix. Source and
tests must both type-check. Keep public examples compilable and update docs when
changing ownership, shutdown, migration or deletion behavior.

## Design constraints

- Preserve the upstream Storage semantics; run the full conformance suite.
- Keep Node/pg-specific code in the adapter, not the core.
- Never mutate process-global parsers or silently reconnect an owning storage.
- Do not access private Harness internals to implement live deletion.
- Append schema migrations rather than editing migrations already released.
- Keep SQL values parameterized. Schema names are host-provisioned configuration.
- Retain attribution for code adapted from the upstream MIT implementation.

Tests for a new adapter must cover the contract in docs/adapters.md in addition
to conformance. Benchmark network round trips before claiming performance gains.

## Reporting bugs

Include package/peer versions, Node and PostgreSQL versions, the operation,
expected/actual behavior, and a minimal redacted reproduction. For security or
data-exposure issues, follow SECURITY.md instead of posting sensitive details.
