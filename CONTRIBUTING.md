# Contributing to Florin

## Commits: Conventional Commits (required)
Commit messages must follow [Conventional Commits](https://www.conventionalcommits.org/). This is enforced locally (husky `commit-msg` hook) and in CI (commitlint on PRs), and it drives the automated release.

Common types:
- `feat:` a new feature (bumps the minor version)
- `fix:` a bug fix (bumps the patch version)
- `chore:`, `docs:`, `refactor:`, `test:`, `ci:` (no version bump)

Breaking change: add `!` (e.g. `feat!:`) or a `BREAKING CHANGE:` footer (bumps major).

## Release: automated (do not hand-cut versions)
- Push conventional commits to `main`.
- `release-please` opens/updates a **Release PR** that bumps `package.json` + writes `CHANGELOG.md`.
- Merging that PR tags `vX.Y.Z`, creates a GitHub Release, and the `release` workflow packages the `.vsix`, attaches it, and publishes to the VS Code Marketplace + Open VSX.
- We are on the `0.x` pre-1.0 line. Graduate to `1.0.0` with a `Release-As: 1.0.0` commit footer.

## Develop
```bash
npm install
npm run compile   # or: press F5 in VS Code
npm run package   # builds florin.vsix locally
```
