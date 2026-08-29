# Git ↔ Cloud migration

v0.1 can copy desired state in both directions. Skill id, source, ref, lock revision, hash, and targets are preserved. The canonical local store is not rewritten by migrate.

You must already be initialized (`toolmirror init`) and, for any Cloud side, logged in (`toolmirror login`).

`--strategy` is required. Destination state is never replaced or merged implicitly.

| Strategy | Behavior |
| --- | --- |
| `replace` | Write source desired state over the destination |
| `merge` | Union independent skill identities. Conflicting skills refuse the migration and leave both providers unchanged |
| `cancel` | No writes |

```bash
toolmirror migrate cloud --strategy replace
toolmirror migrate cloud --strategy merge --origin https://cloud.example.com
toolmirror migrate git git@github.com:example/toolmirror-state.git --strategy replace
toolmirror migrate git git@github.com:example/toolmirror-state.git --strategy cancel
```

`PENDING_PUSH` on Git blocks migration. Empty desired state cannot be migrated.

After a successful migrate, local `mode` becomes `cloud` or `git`. Git destination also stores `gitRepository`.
