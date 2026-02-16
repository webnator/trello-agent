import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import type { TrelloCard, PipelineResult, ProjectConfig } from "../types.js";
import { moveCard, addComment, findListByName } from "./trello.js";
import {
  ensureRepoExists,
  createPullRequest,
  getCheckRuns,
  mergePullRequest,
  getFailedCheckDetails,
  getOpenPullRequests,
} from "./github.js";
import { runClaude } from "./claude.js";
import { notifySuccess, notifyFailure, notifyMaxRetries } from "./telegram.js";

const execFileAsync = promisify(execFile);

const MAX_RETRIES = 10;
const CI_POLL_INTERVAL_MS = 15_000;
const CI_POLL_TIMEOUT_MS = 5 * 60 * 1000;

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

function getWorkspaceDir(): string {
  const dir = process.env.WORKSPACE_DIR || "~/workspace/trello-agent-projects";
  return dir.replace(/^~/, process.env.HOME || "/root");
}

function getRepoHttpUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`;
}

function gitEnv(): Record<string, string> {
  // Pass the token via GIT_ASKPASS so it never appears in process args
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("Missing GITHUB_TOKEN");
  return {
    ...process.env as Record<string, string>,
    GIT_ASKPASS: "echo",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "url.https://x-access-token:" + token + "@github.com/.insteadOf",
    GIT_CONFIG_VALUE_0: "https://github.com/",
  };
}

function redactToken(text: string): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return text;
  return text.replaceAll(token, "***");
}

async function exec(cmd: string, cwd?: string, env?: Record<string, string>): Promise<string> {
  try {
    const { stdout } = await execFileAsync("sh", ["-c", cmd], {
      cwd,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      env,
    });
    return stdout.trim();
  } catch (err: unknown) {
    const e = err as Error & { stderr?: string };
    const message = redactToken(e.message || String(err));
    const redactedErr = new Error(message);
    if (e.stderr) {
      (redactedErr as Error & { stderr: string }).stderr = redactToken(e.stderr);
    }
    throw redactedErr;
  }
}

async function gitExec(cmd: string, cwd?: string): Promise<string> {
  return exec(cmd, cwd, gitEnv());
}

export function buildPrompt(card: TrelloCard, failureContext?: string, attachmentPaths?: string[]): string {
  const checklistText =
    card.checklists && card.checklists.length > 0
      ? card.checklists
          .map(
            (cl) =>
              `### ${cl.name}\n${cl.checkItems.map((i) => `- [${i.state === "complete" ? "x" : " "}] ${i.name}`).join("\n")}`
          )
          .join("\n\n")
      : "";

  let prompt = `You are working in a GitHub repo. Complete the task below. Read the existing code first to understand the project, then implement what's needed.

## Task: ${card.name}

## Description
${card.desc || "No description provided."}
`;

  if (attachmentPaths && attachmentPaths.length > 0) {
    prompt += `\n## Attachments\nThe following files are attached:\n`;
    for (const p of attachmentPaths) {
      prompt += `- ${p}\n`;
    }
    prompt += `\nIMPORTANT: Use the Read tool to view these files.\n`;
  }

  if (checklistText) {
    prompt += `\n## Requirements\n${checklistText}\n`;
  }

  prompt += `
Instructions:
- Implement the task described above
${attachmentPaths && attachmentPaths.length > 0 ? "- Review the attached files carefully\n" : ""}- If the project has a build or test step, make sure it passes before you're done
- Commit your changes when everything is working
`;

  if (failureContext) {
    prompt += `
## Previous attempt failed
${failureContext}

Fix the issues described above and make sure everything works.
`;
  }

  return prompt;
}

async function downloadAttachments(card: TrelloCard, repoDir: string): Promise<string[]> {
  if (!card.attachments || card.attachments.length === 0) {
    return [];
  }

  const attachmentsDir = path.join(repoDir, ".trello-attachments");
  if (!fs.existsSync(attachmentsDir)) {
    fs.mkdirSync(attachmentsDir, { recursive: true });
  }

  const downloadedPaths: string[] = [];

  for (const attachment of card.attachments) {
    try {
      const response = await fetch(attachment.url);
      if (!response.ok) continue;

      const buffer = await response.arrayBuffer();
      const filename = attachment.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filePath = path.join(attachmentsDir, filename);

      fs.writeFileSync(filePath, Buffer.from(buffer));
      downloadedPaths.push(filePath);
      console.log(`  Downloaded attachment: ${filename}`);
    } catch (err) {
      console.error(`  Failed to download attachment ${attachment.name}:`, err);
    }
  }

  return downloadedPaths;
}

async function cloneOrPullRepo(repoDir: string, repoUrl: string): Promise<void> {
  if (fs.existsSync(path.join(repoDir, ".git"))) {
    console.log(`  Pulling latest in ${repoDir}`);
    await gitExec("git fetch origin", repoDir);
    await gitExec("git checkout main", repoDir);
    await gitExec("git reset --hard origin/main", repoDir);
  } else {
    console.log(`  Cloning repo to ${repoDir}`);
    fs.mkdirSync(repoDir, { recursive: true });
    await gitExec(`git clone ${repoUrl} .`, repoDir);
  }
}

async function createOrCheckoutBranch(repoDir: string, branchName: string, isRetry: boolean): Promise<void> {
  if (isRetry) {
    // On retry, the branch may already exist locally or remotely
    try {
      await gitExec(`git checkout ${branchName}`, repoDir);
      // Pull latest if remote exists
      try {
        await gitExec(`git pull origin ${branchName}`, repoDir);
      } catch {
        // Remote branch may not exist yet
      }
      return;
    } catch {
      // Branch doesn't exist locally, try from remote
      try {
        await gitExec(`git checkout -b ${branchName} origin/${branchName}`, repoDir);
        return;
      } catch {
        // Doesn't exist remotely either, create fresh
      }
    }
  }

  // Create new branch from main
  await gitExec("git checkout main", repoDir);
  try {
    await gitExec(`git pull origin main`, repoDir);
  } catch {
    // May fail if remote is empty, ignore
  }
  try {
    await gitExec(`git branch -D ${branchName}`, repoDir);
  } catch {
    // Branch may not exist
  }
  await gitExec(`git checkout -b ${branchName}`, repoDir);
}

async function pollCI(
  owner: string,
  repo: string,
  branchName: string
): Promise<{ passed: boolean; details: string }> {
  const start = Date.now();

  // Wait a bit for CI to start
  await new Promise((r) => setTimeout(r, 10_000));

  while (Date.now() - start < CI_POLL_TIMEOUT_MS) {
    const result = await getCheckRuns(owner, repo, branchName);

    if (result.conclusion === "success") {
      return { passed: true, details: "All checks passed" };
    }

    if (result.conclusion === "failure") {
      const details = await getFailedCheckDetails(owner, repo, branchName);
      return { passed: false, details };
    }

    // Still pending
    console.log(`  CI still pending... (${Math.round((Date.now() - start) / 1000)}s elapsed)`);
    await new Promise((r) => setTimeout(r, CI_POLL_INTERVAL_MS));
  }

  return { passed: false, details: "CI timed out after 5 minutes" };
}

export async function runLocalPipeline(
  project: ProjectConfig,
  card: TrelloCard,
  attempt: number,
  failureContext?: string
): Promise<PipelineResult> {
  const { name: projectName, trelloBoardId: boardId, githubOwner: owner, githubRepo: repo } = project;

  // Branch naming includes project name to avoid collisions
  const branchName = `trello/${projectName}/${card.shortLink}-${slugify(card.name)}`;
  const workspaceDir = getWorkspaceDir();
  // Workspace directory includes owner/repo to avoid collisions
  const repoDir = path.join(workspaceDir, owner, repo, card.shortLink);
  const isRetry = attempt > 1;

  console.log(`\n[${"=".repeat(60)}]`);
  console.log(`Project: ${projectName}`);
  console.log(`Card: ${card.name}`);
  console.log(`Attempt: ${attempt}/${MAX_RETRIES}`);
  console.log(`Branch: ${branchName}`);

  try {
    // 1. Move card to "In Progress" (if not already)
    const inProgressList = await findListByName(boardId, "In Progress");
    if (inProgressList && card.idList !== inProgressList.id) {
      await moveCard(card.id, inProgressList.id);
      console.log("  Moved card to In Progress");
    }

    // 2. Ensure GitHub repo exists
    await ensureRepoExists(owner, repo);
    console.log("  Repo exists");

    // 3. Clone or pull repo locally
    const repoUrl = getRepoHttpUrl(owner, repo);
    await cloneOrPullRepo(repoDir, repoUrl);
    console.log("  Repo ready locally");

    // 4. Create or checkout feature branch
    await createOrCheckoutBranch(repoDir, branchName, isRetry);
    console.log(`  On branch ${branchName}`);

    // 5. Download attachments (reference images, etc.)
    const attachmentPaths = await downloadAttachments(card, repoDir);
    if (attachmentPaths.length > 0) {
      console.log(`  Downloaded ${attachmentPaths.length} attachment(s)`);
    }

    // 6. Build prompt
    const prompt = buildPrompt(card, failureContext, attachmentPaths);
    console.log("  Spawning Claude Code...");

    // 7. Run Claude Code CLI
    const claudeResult = await runClaude(repoDir, prompt);

    if (claudeResult.exitCode !== 0) {
      const errorMsg = `Claude exited with code ${claudeResult.exitCode}.\n\nOutput (last 2000 chars):\n${claudeResult.output.slice(-2000)}`;
      console.error(`  Claude failed (exit ${claudeResult.exitCode})`);

      if (attempt >= MAX_RETRIES) {
        return await handleMaxRetries(project, card, errorMsg);
      }

      await addComment(
        card.id,
        `Attempt ${attempt}/${MAX_RETRIES} failed (Claude error):\n\n\`\`\`\n${errorMsg.slice(0, 3000)}\n\`\`\``
      );
      await notifyFailure(projectName, card.name, errorMsg, attempt, MAX_RETRIES);
      return { success: false, error: errorMsg };
    }

    console.log("  Claude completed successfully");

    // 8. Rebase onto main before push
    try {
      await gitExec("git fetch origin main", repoDir);
      await gitExec("git rebase origin/main", repoDir);
    } catch {
      // Rebase conflict — abort and treat as failure
      try {
        await gitExec("git rebase --abort", repoDir);
      } catch {
        // rebase --abort may fail if no rebase in progress
      }
      const errorMsg = "Rebase onto origin/main failed due to conflicts.";
      console.error(`  ${errorMsg}`);

      if (attempt >= MAX_RETRIES) {
        return await handleMaxRetries(project, card, errorMsg);
      }

      await addComment(
        card.id,
        `Attempt ${attempt}/${MAX_RETRIES} failed (rebase conflict):\n\n${errorMsg}`
      );
      await notifyFailure(projectName, card.name, errorMsg, attempt, MAX_RETRIES);
      return { success: false, error: errorMsg };
    }

    // 9. Push branch
    try {
      await gitExec(`git push origin ${branchName} --force`, repoDir);
    } catch (pushErr) {
      // Check if there's actually anything to push
      const status = await gitExec("git status --porcelain", repoDir);
      if (status) {
        // There are uncommitted changes - Claude didn't commit
        await gitExec("git add -A", repoDir);
        await gitExec('git commit -m "feat: implement task from Trello card"', repoDir);
        await gitExec(`git push origin ${branchName} --force`, repoDir);
      } else {
        // No changes at all - check if branch has commits ahead of main
        try {
          const ahead = await gitExec(`git rev-list main..${branchName} --count`, repoDir);
          if (ahead === "0") {
            const errorMsg = "Claude completed but made no changes to the code.";
            console.error(`  ${errorMsg}`);
            if (attempt >= MAX_RETRIES) {
              return await handleMaxRetries(project, card, errorMsg);
            }
            await addComment(card.id, `Attempt ${attempt}/${MAX_RETRIES}: ${errorMsg}`);
            await notifyFailure(projectName, card.name, errorMsg, attempt, MAX_RETRIES);
            return { success: false, error: errorMsg };
          }
          // Has commits, push should work
          await gitExec(`git push origin ${branchName} --force`, repoDir);
        } catch {
          throw pushErr;
        }
      }
    }
    console.log("  Pushed branch to origin");

    // 10. Create PR (or it may already exist on retry)
    let prNumber: number;
    let prUrl: string;

    try {
      const prBody = [
        `## Trello Card`,
        `[${card.name}](${card.url})`,
        ``,
        `## Description`,
        card.desc || "_No description provided._",
        ``,
        `---`,
        `_Automated by Trello Agent (local daemon)_`,
        ``,
        `trello-project: ${projectName}`,
        `trello-card-id: ${card.id}`,
      ].join("\n");

      const pr = await createPullRequest(owner, repo, branchName, card.name, prBody);
      prNumber = pr.number;
      prUrl = pr.html_url;
      console.log(`  PR created: ${prUrl}`);
    } catch (prErr: unknown) {
      const msg = prErr instanceof Error ? prErr.message : String(prErr);
      if (msg.includes("A pull request already exists")) {
        // Find existing PR number from the error or by listing PRs
        const openPRs = await getOpenPullRequests(owner, repo);
        const existingPR = openPRs.find((p) => p.head.ref === branchName);
        if (!existingPR) throw prErr;
        prNumber = existingPR.number;
        prUrl = existingPR.html_url;
        console.log(`  Using existing PR: ${prUrl}`);
      } else {
        throw prErr;
      }
    }

    // 11. Poll CI
    console.log("  Waiting for CI...");
    const ci = await pollCI(owner, repo, branchName);

    if (!ci.passed) {
      const errorMsg = `CI failed:\n${ci.details}`;
      console.error(`  CI failed`);

      if (attempt >= MAX_RETRIES) {
        return await handleMaxRetries(project, card, errorMsg);
      }

      await addComment(
        card.id,
        `Attempt ${attempt}/${MAX_RETRIES} failed (CI):\n\n${ci.details}`
      );
      await notifyFailure(projectName, card.name, errorMsg, attempt, MAX_RETRIES);
      return { success: false, error: errorMsg };
    }

    console.log("  CI passed!");

    // 12. Auto-merge
    await mergePullRequest(owner, repo, prNumber);
    console.log("  PR merged!");

    // 13. Move card to "Done"
    const doneList = await findListByName(boardId, "Done");
    if (doneList) {
      await moveCard(card.id, doneList.id);
    }

    await addComment(
      card.id,
      `Task completed! PR merged: ${prUrl}`
    );

    console.log("  Card moved to Done");

    // 14. Cleanup workspace directory
    try {
      fs.rmSync(repoDir, { recursive: true, force: true });
      console.log(`  Cleaned up workspace: ${repoDir}`);
    } catch {
      console.warn(`  Failed to clean up workspace: ${repoDir}`);
    }

    await notifySuccess(projectName, card.name, prUrl);
    return { success: true, prUrl };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const redacted = redactToken(message);
    console.error(`  Pipeline error: ${redacted}`);

    if (attempt >= MAX_RETRIES) {
      return await handleMaxRetries(project, card, redacted);
    }

    try {
      await addComment(
        card.id,
        `Attempt ${attempt}/${MAX_RETRIES} failed:\n\n\`\`\`\n${redacted.slice(0, 3000)}\n\`\`\``
      );
    } catch {
      console.error("  Failed to comment on Trello card");
    }

    await notifyFailure(projectName, card.name, redacted, attempt, MAX_RETRIES);
    return { success: false, error: redacted };
  }
}

async function handleMaxRetries(
  project: ProjectConfig,
  card: TrelloCard,
  lastError: string
): Promise<PipelineResult> {
  const { name: projectName, trelloBoardId: boardId } = project;

  console.error(`  Max retries (${MAX_RETRIES}) reached. Moving to Failed.`);
  await notifyMaxRetries(projectName, card.name);

  try {
    const failedList = await findListByName(boardId, "Failed");
    if (failedList) {
      await moveCard(card.id, failedList.id);
    }
    await addComment(
      card.id,
      `Task failed after ${MAX_RETRIES} attempts. Last error:\n\n\`\`\`\n${lastError.slice(0, 3000)}\n\`\`\``
    );
  } catch {
    console.error("  Failed to update Trello card after max retries");
  }

  return { success: false, error: `Max retries exceeded. Last: ${lastError}` };
}
