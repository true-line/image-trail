---
'image-trail': patch
---

Private pins now stay private. Pinning an image that is already a private pin while encryption is locked no longer creates a second, unencrypted copy. Backups now record which pins were private, and restoring them saves them encrypted or, if encryption is locked, leaves them out and tells you to unlock and restore again.
