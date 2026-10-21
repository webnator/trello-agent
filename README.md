# Task Agent

A personal coding-agent runner controlled through Telegram. Give it a task, follow its progress, and inspect the resulting GitHub pull request. Built with TypeScript, Claude Code, grammY, and Octokit.

The repository retains its original name, `trello-agent`, but the current implementation uses a local task queue, not Trello.

## What it does

- Keeps a registry of projects and a persistent JSON task queue.
- Accepts task descriptions and attachments through Telegram.
- Clones a project, creates a branch, and runs Claude Code against the task.
- Pushes changes, opens a pull request, polls CI, and can merge through its existing pipeline.
- Reports progress through Telegram and a small dashboard.

This is a personal automation tool, not a hosted service or a sandbox for untrusted users. The implementation invokes Claude with permission prompts bypassed and includes automatic merging. Inspect `src/lib/claude.ts` and `src/lib/local-pipeline.ts` before connecting repositories. Run it in an isolated environment with access limited to disposable development repositories first. The dashboard has no authentication and should stay on a private network.

## Check the code without credentials

Requires Node.js 22 or newer and npm.

```sh
npm ci
npm run typecheck
npm test
npm run build
```

The unit tests mock external interactions. They do not start the daemon or prove a live Claude/GitHub/Telegram workflow.

## Run your own instance

You will need Git, the Claude Code CLI, a GitHub token with access to the repositories you intend to use, and a Telegram bot. Claude authentication must be configured for the runtime user.

```sh
cp .env.example .env
```

Set `GITHUB_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and the Claude authentication appropriate for your setup. Optional Vercel and Supabase integrations have separate credentials. Never commit `.env`.

Create `~/.task-agent/projects.json`:

```json
{
  "projects": {
    "demo": {
      "name": "demo",
      "githubOwner": "your-github-user",
      "githubRepo": "your-test-repository",
      "createdAt": "2026-01-01T00:00:00.000Z"
    }
  }
}
```

Then run `npm start`. This starts the task poller, Telegram bot, and dashboard. Use `/help` in Telegram to see commands. Do not start it with production credentials just to try the interface.

## Code map

| File | Responsibility |
| --- | --- |
| `src/daemon.ts` | Startup and shutdown |
| `src/lib/task-store.ts` | Task persistence |
| `src/lib/poller.ts` | Scheduling and retries |
| `src/lib/local-pipeline.ts` | Repository, agent, PR, and CI workflow |
| `src/lib/claude.ts` | Claude subprocess lifecycle |
| `src/lib/telegram.ts` | Bot commands and notifications |
| `src/lib/dashboard.ts` | Local monitoring interface |

## Status

An experimental tool extracted from my own workflow. It is useful as a concrete example of agent orchestration, but requires reviewing execution permissions, network exposure, retries, and merge behavior for your environment. No production reliability claims or live integration verification are implied by the unit test suite.

## License

MIT. See [LICENSE](LICENSE).
