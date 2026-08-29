# Playwright critical browser flows

| Flow | Expected | Result |
| --- | --- | --- |
| Pairing approval | Browser submits user code and shows Device approved | PASS |
| Hosted billing | Dashboard shows Current subscription: active | PASS |
| Device status | Unsynced device stays NEVER_SYNCED; reporter without apply stays BEHIND | PASS |
| Self-hosted billing | Dashboard states Cloud is free and has no billing portal | PASS |
