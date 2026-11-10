---
'image-trail': patch
---

Encrypted storage setup now saves the new key before unlocking and refuses to replace an existing key, restoring a backup keeps originals that are already stored instead of overwriting them, and orphan cleanup deletes nothing while any bookmark record is unreadable.
