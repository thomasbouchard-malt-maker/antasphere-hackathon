# Guide: voice + cursor helper for business software

A Chrome extension that helps people use software they don't know (older users,
busy business owners) by **talking them through it** and **pointing at what to
click next**. The agent has absorbed the software's documentation.

```
 Chrome extension (on the software's page)            Guide server (Node)
 ┌───────────────────────────────────────────┐        ┌─────────────────────────────┐
 │ 🎤 Web Speech → text      🔊 speechSynthesis │  ───►  │ Claude (claude-opus-5-5)     │
 │ numbered list of clickable elements (DOM)  │        │  system = docs (cached 1h)   │
 │ screenshot (captureVisibleTab)             │  ◄───  │  JSON: say, target_id, step… │
 │ animated cursor + highlight ring + bubble  │        │  per-task conversation       │
 └───────────────────────────────────────────┘        └─────────────────────────────┘
```

**Step loop:** you ask → the extension sends the screen → Claude picks ONE step and the
element id → the cursor flies there and the step is read aloud → *you* click → the
extension notices the click, waits for the page to settle and asks for the next step,
until the task is done. It survives full page reloads.

## Run it

```bash
# 1. Server
cd server
npm install
cp .env.example .env           # put your ANTHROPIC_API_KEY in .env
npm run dev                    # http://localhost:8787
# no key yet? `npm run mock` points at the first button on the page, no Claude calls

# 2. Extension
# chrome://extensions → Developer mode → Load unpacked → select the extension/ folder
```

3. Put the target software's docs in `docs/` (see `docs/README.md`), restart the server.
4. Open the software, click the extension icon (or press **Alt+G**), press 🎤 and say
   what you want to do. You can also type. Say or press **Repeat**, **Next**, **Stop**.

The microphone needs the page to be on `https://` or `localhost`. Voice uses the
browser's language (`navigator.language`).

## Layout

| Path | What |
|---|---|
| `extension/content.js` | Element map, overlay (cursor, ring, bubble, panel), voice, step loop |
| `extension/background.js` | Screenshot, calls the server, per-tab task state |
| `server/src/index.ts` | Claude call: cached docs, JSON-schema output, session history |
| `docs/` | Documentation the guide absorbs |

## Notes

- Claude never clicks: it only points. The user stays in control.
- Effort is `low` to keep voice turns quick; raise it in `server/src/index.ts` if steps are wrong.
- `fallbacks: "default"` is on: if a safety classifier declines, the API retries on a recommended model.
- Sessions live in memory; restarting the server forgets in-progress tasks.
