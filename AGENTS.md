# Repository versioning

Every change, including documentation and configuration, must bump the repository version in the same commit. Use one bump per logical change set, following Semantic Versioning (https://semver.org/):

- PATCH: backward-compatible fixes, documentation, and configuration changes.
- MINOR: backward-compatible features; reset PATCH to zero.
- MAJOR: incompatible public API changes; reset MINOR and PATCH to zero. While on 0.x, use a MINOR bump for incompatible changes.

The root version tracks repository changes. CLI and docs versions are independent: bump `apps/cli/package.json` for CLI changes and `apps/docs/package.json` for docs changes. CLI binaries, Cloud device metadata, and release scripts read the CLI package version. Run relevant checks before committing. Release the CLI with an annotated `cli-v<version>` tag matching `apps/cli/package.json`; website-only changes do not release the CLI.
