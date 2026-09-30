# Repository versioning

Every change, including documentation and configuration, must bump the repository version in the same commit. Use one bump per logical change set, following Semantic Versioning (https://semver.org/):

- PATCH: backward-compatible fixes, documentation, and configuration changes.
- MINOR: backward-compatible features; reset PATCH to zero.
- MAJOR: incompatible public API changes; reset MINOR and PATCH to zero. While on 0.x, use a MINOR bump for incompatible changes.

Keep the root, CLI, and docs package versions, `CLI_VERSION`, the default Cloud device version, and `scripts/verify-cli.sh` in sync. Run relevant checks before committing. When tagging a release, use an annotated `v<version>` tag on the version-bump commit.
