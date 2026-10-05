# Releasing

The source repository is **github.com/j-koester/pi-durable-postgres**.
The public npm package is **@netzlabor/pi-durable-postgres**. These identities
intentionally differ.

## One-time GitHub/npm setup

1. Ensure the npm publisher has permission to publish in the `@netzlabor` scope.
2. In the GitHub repository, create an `npm` environment. Configure approval rules
   and permitted release tags as appropriate.
3. Add the environment secret `NPM_TOKEN`: a valid granular npm automation token
   authorized for this package, compatible with the organization's 2FA policy.
   Never commit a token or place one in this documentation.
4. Protect release tags and review changes to the publish workflow. A pushed
   matching version tag can publish after CI and environment approval.

The workflow configures npm's registry authentication through setup-node. It does
not currently use trusted publishing/OIDC or claim npm provenance. Migrating to
OIDC requires configuring the matching repository/environment publisher in npm.

## Release checklist

- Update package version and CHANGELOG.md.
- Run `pnpm install --frozen-lockfile`, `pnpm lint:types`, `pnpm test` and
  `pnpm test:package`.
- Check the README compatibility table against actually tested peer versions.
  Pi Durable is experimental: do not widen peer ranges on assumption alone.
- Review `npm pack --dry-run` output: JS, declarations, source-map sources,
  documentation and license must be included, but no secrets or test data.
- Confirm live-deletion limitations and any changed adapter contracts are accurate.
- Commit and push the reviewed changes, then deliberately create/push a tag
  matching package.json, e.g. `v0.1.0`.

Branch pushes and PRs run tests but do not publish. A `v*` tag push runs the same
matrix, then the release job verifies the package identity and exact tag/version
match before calling `npm publish --access public`. If npm already contains this
version with the exact same `gitHead`, the upload is skipped. A different or unknown
commit is rejected instead of treating it as a successful release. Publishing runs
`prepack` to build dist. CI uses the packageManager-pinned pnpm version.

For the initial release, a maintainer may publish locally from the clean, committed
release checkout using their existing npm login, then push the matching version
tag. Explicitly override any private registry configured for the scope:

```bash
npm publish --access public --registry=https://registry.npmjs.org --@netzlabor:registry=https://registry.npmjs.org
```

A scoped registry can take precedence over the general registry setting. Check a
`--dry-run` first; its target must be registry.npmjs.org. This per-command override
does not change global npm configuration or transfer local credentials to GitHub.
Subsequent automatic publishes of new versions still require the environment
secret described above.

The consumer smoke test creates an isolated temporary project, installs the real
tarball, type-checks without skipLibCheck, and imports the compiled package. It
does not contact a model provider or modify a database.

Never reuse an already published npm version. Correct a bad release with a new
version and an explicit changelog entry.
