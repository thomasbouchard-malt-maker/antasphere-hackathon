# Docs the guide absorbs

Every `.md` / `.txt` file in this folder (except this README) is loaded into the
system prompt at server start, sorted by name, and prompt-cached for an hour.

- Paste the target software's **official** help pages here (one file per topic works well).
- Task-oriented pages ("How to create an invoice") help far more than reference pages.
- Restart the server after changing files.
- A few hundred pages is fine (1M-token context); the first request pays to cache them,
  later requests read from cache.
