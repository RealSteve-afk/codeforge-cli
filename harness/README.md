# Forge Harness

A self-hosted coding agent with **multiple users**, **multiple provider accounts per user**,
a **terminal UI** and a **web / desktop GUI**, all backed by one engine.

```
                ┌──────────────────────────── engine (background) ───────────────────────────┐
  harness tui ──┤  HTTP + SSE API  ─  users & logins  ─  encrypted provider profiles          │
  web browser ──┤  sessions (append-only history)  ─  agent loop  ─  tools + approvals        │
  desktop app ──┤  providers: Anthropic (Claude SDK) · OpenAI-compatible (OpenAI, Ollama, …)   │
                └────────────────────────────────────────────────────────────────────────────┘
```

- **Engine** (`src/core`, `src/server`): stores users, profiles and sessions under `~/.forge-harness`,
  runs the agent loop and streams events over Server-Sent Events. Listens on `127.0.0.1:7878`.
- **TUI** (`src/tui`): a terminal client. If no engine is running, it starts one in the background
  (in the same process), so the GUI can connect to it at the same time.
- **Web GUI** (`web/`): plain HTML/CSS/JS served by the engine. No build step.
- **Desktop** (`desktop/`): an Electron window that runs the engine inside the app.

## Quick start

```bash
cd harness
npm install
npm run build

node dist/cli.js            # TUI (first run creates the admin account)
node dist/cli.js gui        # engine + open the web GUI in your browser
node dist/cli.js serve      # engine + web GUI only, http://127.0.0.1:7878
```

Desktop app:

```bash
cd harness/desktop
npm install                 # downloads Electron
npm start
```

## Accounts and profiles

- **Users.** The first person to open the app creates the admin account. Admins add users in
  *Settings → Users* (GUI), with `/user add` (TUI), or with `harness user add <name> [--admin]`.
  Each user only sees their own profiles and sessions.
- **Provider profiles.** Each user can save any number of profiles, for example a work Claude key,
  a personal Claude key, an OpenAI key and a local Ollama model. API keys are encrypted at rest
  (AES-256-GCM, key in `~/.forge-harness/master.key` or `HARNESS_MASTER_KEY`) and are never sent
  back to any client. Each session is bound to one profile.
- The harness never rotates between accounts to get around a provider's rate limits. Use each
  account under its provider's terms.

Defaults for a Claude profile: model `claude-opus-5-5`, adaptive thinking with summarized thinking
shown in the UI, explicit effort (`high` by default; Opus 5.5's API default is `medium`), prompt
caching, and the Claude API's server-side refusal fallback (`fallbacks: "default"`), which you can
turn off per profile.

## Switching models

Every session has a **model button** in the header (TUI: `/model`). It lists each of your profiles
and the models that account can use (read live from the provider's Models API), plus a field for any
other model id. You can switch at any time, including between providers:

- Same account, different model: the native conversation history is kept.
- Another account or provider: the history is rebuilt from the transcript (messages and a tool log),
  because each provider's native format and the model's private reasoning can't be carried over.

## Web access

Each session has a **🌐 Web** toggle (TUI: `/web on|off`), on by default.

- **Claude profiles** use Anthropic's built-in `web_search` / `web_fetch` server tools (the dynamic
  filtering versions on current models). Anthropic bills web searches separately.
- **Other providers** get client-side `web_search` and `web_fetch` tools. Search needs a backend,
  which an admin sets in *Settings → Web search*: Brave Search API (key) or self-hosted SearXNG.
- `web_fetch` blocks private and local network addresses (checked at connect time) and only opens
  URLs that already appeared in the conversation (from you or from search results), which limits
  how far a malicious page can steer the agent into leaking data.

## Cards and progress

- **Question cards** (`ask_user`): the agent asks you a question with clickable options or free text.
- **Plan card** (`update_plan`): a live checklist with a progress bar, updated in place.
- **Web cards**: what was searched or read, with the result links.
- **Approval cards** for file changes and commands in Ask mode.
- **Status bar** while a turn runs: what the agent is doing right now, the elapsed time, steps,
  and plan progress. On Claude models that support it, the model's own short progress notes between
  steps are shown too (`thinking.display: "updates"`).
- **Notifications**: if the tab is in the background, the browser notifies you when approval or an
  answer is needed and when the task finishes. TUI: `/status` at any time, a terminal bell for
  approvals and questions, and the terminal title shows when a task is running.
- A one-line **summary** after each turn: time taken, steps and tokens.

## Tools and approvals

The agent has `read_file`, `list_dir`, `search`, `write_file`, `edit_file`, `run_command`,
`ask_user`, `update_plan`, and the web tools above.
File tools are confined to the session's workspace folder, and symlink escapes are blocked.
In **Ask** mode every file change and command waits for your approval. **Auto** mode runs them
without asking.

## Security notes

- `run_command` runs as the operating-system user that runs the engine. It is **not a sandbox**.
  On a shared machine, run the engine as a dedicated low-privilege user (or in a container),
  keep non-admin users in Ask mode, and give them workspace roots they own.
- Non-admin users can only open workspaces inside the folders an admin assigned to them.
- The engine binds to `127.0.0.1` by default and refuses cross-origin browser requests. If you
  serve it on a network (`--host 0.0.0.0`), put it behind HTTPS.

## Development

```bash
npm test          # builds, then runs node:test suites (fake Anthropic/OpenAI servers, no API cost)
npm run typecheck
```

Layout:

| Path | What it is |
|---|---|
| `src/core/store.ts` | users, login tokens, encrypted profiles, sessions (JSON files) |
| `src/core/agent.ts` | runs turns, approvals, cancel, history rollback to the last consistent point |
| `src/core/providers/` | `anthropic.ts` (official SDK, streaming tool loop), `openai.ts` (OpenAI-compatible) |
| `src/core/tools.ts` | tool definitions (zod schemas → JSON Schema) |
| `src/core/web.ts` | search backends, SSRF-safe page fetching, HTML → text |
| `src/core/providers/models.ts` | model capability checks and live model lists |
| `src/server/server.ts` | REST + SSE API and static GUI |
| `src/tui/tui.ts`, `src/client/api.ts` | terminal client |
| `web/` | browser GUI |
| `desktop/` | Electron wrapper |
