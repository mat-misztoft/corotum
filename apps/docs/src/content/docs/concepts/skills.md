---
title: Skills storage and v2 contracts
---

Managed skills live in a named shared root. Desired-state files use the Corotum v2 names `corotum.yaml`, `corotum.lock`, and `corotum.transitions.json`. Sync installs the exact locked revision. It never substitutes upstream `HEAD`.

v0.5 binaries are unsigned. Official installers are the only supported installation path. There is no daemon and no remote forced sync.

## Named storage

Canonical managed installations are:

```text
~/.agents/skills/<normalized-name>/
```

The stable skill ID (`sk_…`) stays in desired-state metadata. It is not a directory name. Agent targets are symlinks to that named directory when the filesystem allows it, otherwise ordinary copies.

Config, credentials, Git cache, and operational state stay in the Corotum platform roots:

| Platform | Config | Git cache / data |
| --- | --- | --- |
| macOS | `~/Library/Application Support/Corotum/` | same tree (`git/`, `state/`) |
| Linux | `$XDG_CONFIG_HOME/corotum/` (default `~/.config/corotum/`) | `$XDG_DATA_HOME/corotum/` |
| Windows | `%APPDATA%\Corotum\` | `%LOCALAPPDATA%\Corotum\` |

`config.json` `skillsStoragePath` may relocate the named store after a verified migration. Default remains `~/.agents/skills`.

## Provenance at init

Init enumerates `~/.agents/skills/*/`. Missing `~/.agents/skills` is valid. Discovery does not depend on detected or enabled agents. Init does not import those directories until you select them.

It also reads `~/.agents/.skill-lock.json`. A record is source-known when the lock **key** matches the local folder name and `source`, `sourceType`, `sourceUrl`, `skillPath`, and `skillFolderHash` are non-empty strings. `skillPath` is the path in the upstream Git repo; if it ends with `SKILL.md`, Corotum uses the parent directory. The lock is a hint only. It does not prove an immutable commit, repository access, or that local files still match upstream.

Agent-local copies are scanned only to explain collisions. They are not a second canonical store.

## Source-backed versus artifact-backed

A **source-backed** skill has Git provenance and an immutable lock (`repository`, `path`, `ref`, commit SHA, content hash). Later `update` follows the manifest `ref` and writes a new exact SHA. Sync then installs that SHA, never `HEAD`.

An **artifact-backed** skill stores sanitized exact files (Git `artifacts/` tree or Cloud R2 archive) plus hashes. Sync installs those bytes. It does not clone upstream to refresh an artifact lock.

`source: null` is valid on an artifact lock: the skill stays synchronizable, but `update` / `update --check` report `SOURCE_UNAVAILABLE`. A skill may also keep source metadata for a future update while the current materialization is artifact-backed (keep-local during init).

Private sources use system Git on that device only. Credentials are never stored in desired state, operational state, logs, or artifacts. Auth success follows the source-backed path. `AUTH_REQUIRED` preserves local files and is reported distinctly from `SOURCE_UNAVAILABLE`.

## Artifact privacy consent

Git commits that publish local artifact files require consent.

Interactive: Corotum asks before the commit. Cancel leaves Git unchanged.

Non-interactive (no TTY or `--non-interactive`): the write fails unless `--allow-artifacts` is set. `--json` then returns `outcome` `CONFIRMATION_REQUIRED` and message `Git artifact publishing requires explicit consent before local content is committed.`

Cloud artifact uploads use the same sanitized bytes. They still fail the denylist/ignore scan instead of prompting for Git consent.

## Denylist and ignore

Artifact creation scans a real directory of regular files. Symbolic links, absolute paths, and archive escapes are rejected.

`.corotumignore` is configuration, never payload. Rules apply in file order; the last match wins; `!pattern` re-includes. The denylist is evaluated first, so an ignore rule cannot hide a potential secret.

Denied names include `.env`, `.env.*`, `.npmrc`, `.netrc`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.secret`, `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, `credentials`, `credentials.*`, `secrets`, and `secrets.*`. A match is `DENYLISTED_PATH`. Scan errors name paths and rules, never file contents.

## Typed errors

Domain and CLI outcomes stay named. Common codes:

| Code | Meaning |
| --- | --- |
| `AUTH_REQUIRED` | This device cannot access a private Git source |
| `SOURCE_UNAVAILABLE` | Upstream or source lock cannot be used; local unmanaged files stay |
| `ARTIFACT_UNAVAILABLE` | Artifact bytes/tree cannot be fetched or extracted |
| `CONTENT_HASH_MISMATCH` | Bytes do not match the locked hash |
| `DENYLISTED_PATH` | Artifact scan hit the secret denylist |
| `LOCAL_CONFLICT` | Unmanaged or unproven content is in the way; ordinary sync does not overwrite it. Interactive init **Replace** overwrites that named folder in `~/.agents/skills` |
| `DRIFTED` | A managed copy changed; ordinary sync does not clobber it |
| `PENDING_PUSH` | A previous Git desired-state push is still pending |
| `CONFIRMATION_REQUIRED` | Non-interactive Git artifact write without `--allow-artifacts` |
| `VALIDATION_ERROR` | Manifest, lock, or config failed validation |
| `NETWORK_ERROR` | Transport failed |
| `CONFLICT` | Identity or destination conflict; both sides unchanged where applicable |

JSON envelopes always include `schemaVersion` `1`. `--json --help` and `--json --version` still return `{ "schemaVersion": 1, "outcome": "SUCCESS" }`.

## Non-interactive choices

No TTY and `--non-interactive` never wait for a prompt.

Init applies only exact `--replace`, `--keep`, and `--adopt-artifact` names. It never enables undetected or unconfigured agents. Zero agents is valid. Unknown-provenance skills stay unmanaged unless listed in `--adopt-artifact`. Missing required choices fail safely and leave local files in place.

`add` / `adopt` in non-interactive mode require an unambiguous `--skill` when more than one candidate exists. `adopt` uses `--source` for that one local name; init has no global source flag.

## Cloud artifact retention

D1 stores metadata and references, not archive bytes. R2 stores artifact-backed payloads only.

Retention keeps the current artifact and one immediately preceding artifact per skill. Garbage collection deletes an object only when it is absent from both references, then deletes unreferenced metadata. Failed or ambiguous GC deletes nothing. Revision metadata remains.

## Legacy names

Current writes use Corotum roots and `corotum.*` files. Old ToolMirror paths and `toolmirror.*` files are a recoverable import source only. See [migration.md](/guides/migration/).
