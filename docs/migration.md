# Migration

v0.1 copies desired state between Git Sync and Cloud, and can import recoverable ToolMirror files into Corotum v2. Skill id, source, ref, lock revision, hash, materialization, and targets are preserved. The named local store is not rewritten by Git ↔ Cloud migrate.

You must already be initialized (`corotum init`) and, for any Cloud side, logged in (`corotum login`) before Git ↔ Cloud migrate.

`--strategy` is required for Git ↔ Cloud. Destination state is never replaced or merged implicitly.

| Strategy | Behavior |
| --- | --- |
| `replace` | Write source desired state over the destination |
| `merge` | Union independent skill identities. Conflicting skills refuse the migration and leave both providers unchanged |
| `cancel` | No writes |

```bash
corotum migrate cloud --strategy replace
corotum migrate cloud --strategy merge --origin https://cloud.example.com
corotum migrate git git@github.com:example/corotum-state.git --strategy replace
corotum migrate git git@github.com:example/corotum-state.git --strategy cancel
```

`PENDING_PUSH` on Git blocks migration. Empty desired state cannot be migrated.

Git → Cloud archives each artifact-backed tree to R2, then writes D1 references atomically. Cloud → Git extracts verified R2 objects into `artifacts/` and commits equivalent v2 metadata. Source-backed skills stay metadata-only.

After a successful migrate, local `mode` becomes `cloud` or `git`. Git destination also stores `gitRepository`.

## Upgrade from ToolMirror

Old ToolMirror config/state roots, `toolmirror.yaml`, `toolmirror.lock`, the previous transition file, and `sk_*` canonical directories remain readable as a backup. New writes use Corotum roots, `~/.agents/skills/<name>`, `corotum.yaml`, `corotum.lock`, and `corotum.transitions.json`.

```bash
corotum migrate legacy
```

Import copies validated files, records a recovery marker, and leaves the originals in place. Name collisions are reported as `LOCAL_CONFLICT` and are non-destructive.

```bash
corotum migrate legacy-cleanup
```

Cleanup runs only after the v2 state, named canonical hashes, and recorded targets verify. It refuses on missing, corrupt, or ambiguous recovery evidence. Interrupted cleanup is safe to retry. Do not delete ToolMirror backups by hand.
