# Vendored files

## activation-code.js

OrbitOne activation codes: reads and checks the code a buyer pastes into the Activate dialog, offline, with the
public key built into the file. Shared with KineticLane and the Code Maker that signs the codes.

|          |                                                                                       |
| -------- | ------------------------------------------------------------------------------------- |
| Source   | KineticLane repository, `tools/activation/activation-code.js` (commit `93ae6ec`)      |
| Copied   | 2026-10-24, unchanged                                                                 |
| SHA-256  | `ec391849405ae32c8463545e89eab263cefadaac901b3854c07b10b3428c101e`                    |
| Contract | `tools/activation/README.md` in the KineticLane repository (code format, `checkCode`) |
| Used by  | `electron/activation.ts` (main process only); `activation-code.d.ts` types its global |

Do not edit it here. When the source changes (a new public key, a new code version), copy it again unchanged and
update the commit and checksum above. It is excluded from Prettier so the copy stays byte-identical.
