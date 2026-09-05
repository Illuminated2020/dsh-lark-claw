# Release maintenance

[Back to README](../README.md) · [中文](releasing.zh.md)

This project is published as the `dsh-lark-claw` npm package. Its `dsh.bundle.patch` manifest points to `cordis.patch.yml`, so a published release can be installed directly into a dsh profile:

```sh
dsh plugin --profile feishu add dsh-lark-claw
```

## Pre-release checks

Run the complete local gate:

```sh
pnpm install --frozen-lockfile
pnpm run release:check
```

`release:check` runs type checking, tests, lint, build, bundle metadata validation, tarball content validation, and a temporary dsh profile installation that verifies composition and module loading. The smoke test downloads or reuses pnpm's cached `@deepseek-ai/dsh@0.1.2-rc.1` and profile dependencies. It neither reads nor changes your existing `$DSH_HOME`.

To inspect the package manually:

```sh
npm pack --dry-run
```

## First publication

At the time this release infrastructure was added, `dsh-lark-claw` did not exist on npm. A package owner must first authenticate and confirm that the name remains available:

```sh
npm login
npm whoami
npm view dsh-lark-claw
pnpm run release:check
npm publish --ignore-scripts --access public
```

Before the first publication, `npm view` should return 404. If the name has been claimed, change the package name and every `dsh-lark-claw/*` module reference before publishing. Do not publish under a name you do not control.

After the first publication, add a Trusted Publisher in the npm package settings:

- Provider: GitHub Actions
- Organization or user: `Illuminated2020`
- Repository: `dsh-lark-claw`
- Workflow filename: `publish.yml`
- Environment: `npm`
- Allowed action: `npm publish`

The repository workflow uses OIDC and needs no long-lived `NPM_TOKEN`. npm Trusted Publishing requires a GitHub-hosted runner, Node.js `22.14.0` or later, and npm CLI `11.5.1` or later. The workflow installs npm `11.19.1`.

## Subsequent releases

1. Update the package version with `pnpm version`, then synchronize the plugin manifest.
2. Run `pnpm run release:check`.
3. Commit and push the changes.
4. Create and push a tag that exactly matches the version, such as `v0.1.1`.

Pushing the tag triggers `publish.yml`. The workflow confirms that the commit is on `main`, verifies the tag and package version, reruns the complete gate, publishes through OIDC, and creates the GitHub Release. A stable version publishes under `latest`; a SemVer prerelease publishes under `next` and creates a prerelease.

For example:

```sh
pnpm version patch --no-git-tag-version
pnpm run version:sync
pnpm run release:check
git add package.json dsh.plugin.json
git commit -m "chore(release): v0.1.1"
git tag v0.1.1
git push origin main v0.1.1
```

No manual GitHub Release step remains after the tag push. The workflow checks npm first: it skips a version that already exists while still creating a missing GitHub Release, making reruns safe. npm versions remain immutable.

## Workflow responsibilities

`.github/workflows/ci.yml` runs for pull requests, updates to `main`, and manual dispatch. It covers Node.js `22.19.0` and Node.js 24. The Node.js 24 job also validates the tarball and performs the dsh installation smoke test.

`.github/workflows/publish.yml` runs after a tag matching `v*.*.*` is pushed. It uses `id-token: write` for short-lived OIDC credentials and does not use a long-lived npm token; after publishing npm, it creates a GitHub Release with generated notes. Configure required reviewers on the `npm` GitHub Environment if you want a manual production-release gate.

If publishing fails with `ENEEDAUTH`, first verify that the repository, workflow filename, and Environment in npm Trusted Publisher exactly match the values above.

## References

- [Official dsh package and install guide](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish)
- [dsh-desktop](https://github.com/anywhere-labs/dsh-desktop)
- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
