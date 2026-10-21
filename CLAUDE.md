# Task Agent

Autonomous coding agent that picks up tasks from a local task queue, implements them with Claude Code CLI, and opens PRs on GitHub. Controlled via Telegram bot.

## Architecture

```
Telegram bot (grammy) <- user commands (/task, /ask, /newproject, etc.)
        |
   daemon.ts -- poller.ts -- polls local task store every 30s
        |
local-pipeline.ts -- clones repo -> spawns Claude Code CLI -> pushes branch -> opens PR -> polls CI -> auto-merges
        |
Notifications sent back to Telegram
```

- **`src/daemon.ts`** -- Entry point. Loads project registry, starts poller + Telegram bot, handles graceful shutdown.
- **`src/lib/telegram.ts`** -- Telegram bot commands: `/task`, `/ask`, `/status`, `/project`, `/newproject`, `/url`, `/seturl`, `/help`. Handles media attachments (photos, docs, audio, video) as task cards.
- **`src/lib/poller.ts`** -- Polls each project's task store for "todo" and "in_progress" tasks on an interval.
- **`src/lib/local-pipeline.ts`** -- Full pipeline: clone repo -> create branch -> resolve attachments -> build prompt -> run Claude -> push -> create PR -> poll CI -> merge -> move task to Done.
- **`src/lib/claude.ts`** -- Two functions: `runClaude()` (stream-json, --dangerously-skip-permissions, 1h timeout) for task execution, `askClaude()` (text output, read-only, 2min timeout) for `/ask`.
- **`src/lib/task-store.ts`** -- Local JSON-backed task storage. Tasks stored at `~/.task-agent/data/<project>/tasks.json`. Atomic writes, in-memory cache with mtime invalidation.
- **`src/lib/github.ts`** -- GitHub API via Octokit (repos, PRs, CI checks).
- **`src/lib/projects.ts`** -- Project registry backed by `~/.task-agent/projects.json`.
- **`src/lib/session.ts`** -- Per-chat active project tracking.
- **`src/lib/structure-card.ts`** -- AI-powered task title/description structuring.
- **`src/types.ts`** -- Shared TypeScript types.

## Tech stack

- TypeScript, Node 22, ESM (`"type": "module"`)
- grammy (Telegram bot framework)
- Octokit (GitHub API)
- Vitest for tests
- Docker (production), tsx (local dev)

## Commands

```bash
npm run start      # Local dev with tsx
npm run build      # Compile TypeScript
npm run typecheck   # tsc --noEmit
npm test           # vitest run
```

## Deployment

Configure your own isolated host and credentials. No hosted service is provided.
See README.md for setup and the existing pipeline's automatic execution/merge behavior.
Do not deploy as part of repository inspection or tests.

## Docker setup

- Multi-stage build: compiles TypeScript in build stage, runs from slim Node 22 image
- Installs: git, curl, Vercel CLI, Supabase CLI, GitHub CLI, pnpm, Claude Code CLI, bun
- Runs as non-root `agent` user (Claude CLI requires this for --dangerously-skip-permissions)
- Volumes: `workspace` (cloned repos), `claude-config` (Claude CLI state), `task-data` (task JSON files), `projects.json` (project registry)
- `.env` file on the server contains all secrets (not synced by rsync)

### Environment variables

See `.env.example` for the full list. Required: `GITHUB_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ANTHROPIC_API_KEY`. Optional: `VERCEL_TOKEN`, `SUPABASE_ACCESS_TOKEN`.

## Data storage

Tasks are stored as JSON files on disk:
```
~/.task-agent/data/<project-name>/tasks.json          # TaskStore (all tasks for project)
~/.task-agent/data/<project-name>/attachments/<id>/    # Downloaded attachment files
```

Task statuses: `todo` -> `in_progress` -> `done` | `failed`

## Key patterns

- **Pending input**: Telegram commands that need follow-up text (e.g., `/task` with no args) store state in `pendingInput` map, handled by the `message:text` listener.
- **Pipeline retries**: Tasks retry up to 10 times. Failed tasks move to "failed" status. Each attempt gets a comment.
- **Git auth**: Uses `GIT_ASKPASS` + `GIT_CONFIG` env vars to inject `GITHUB_TOKEN` without exposing it in process args.
- **Shared git helpers**: `getWorkspaceDir()`, `getRepoHttpUrl()`, `cloneOrPullRepo()` are exported from `local-pipeline.ts` and reused by `/ask` handler.
- **Atomic writes**: Task store uses write-to-tmp-then-rename pattern to prevent corruption.
- **Attachment handling**: Files downloaded once from Telegram to local disk. Pipeline resolves paths directly (no re-download on retry).
