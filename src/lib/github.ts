import { Octokit } from "@octokit/rest";
import type { PullRequestInfo } from "../types.js";

function getOctokit(): Octokit {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("Missing GITHUB_TOKEN");
  return new Octokit({ auth: token });
}

const CI_WORKFLOW_CONTENT = `name: CI
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Install & test
        run: |
          if [ -f package.json ]; then
            npm ci
            npm test
          fi
`;

const BOOTSTRAP_PACKAGE_JSON = JSON.stringify(
  {
    name: "app",
    version: "0.0.0",
    private: true,
    scripts: {
      build: "echo \"no build\"",
      test: "echo \"ok\"",
    },
  },
  null,
  2
);

const BOOTSTRAP_VERCEL_JSON = JSON.stringify(
  {
    buildCommand: "",
    outputDirectory: ".",
  },
  null,
  2
);

async function bootstrapRepo(octokit: Octokit, owner: string, repo: string): Promise<void> {
  // Wait briefly for GitHub to finish initializing the repo with README
  await new Promise((r) => setTimeout(r, 2000));

  const { data: mainRef } = await octokit.git.getRef({
    owner,
    repo,
    ref: "heads/main",
  });
  const baseSha = mainRef.object.sha;

  const { data: baseCommit } = await octokit.git.getCommit({
    owner,
    repo,
    commit_sha: baseSha,
  });

  const bootstrapFiles = [
    { path: "package.json", content: BOOTSTRAP_PACKAGE_JSON },
    { path: "vercel.json", content: BOOTSTRAP_VERCEL_JSON },
    { path: ".github/workflows/ci.yml", content: CI_WORKFLOW_CONTENT },
  ];

  const treeItems = await Promise.all(
    bootstrapFiles.map(async (file) => {
      const { data: blob } = await octokit.git.createBlob({
        owner,
        repo,
        content: file.content,
        encoding: "utf-8",
      });
      return {
        path: file.path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: blob.sha,
      };
    })
  );

  const { data: tree } = await octokit.git.createTree({
    owner,
    repo,
    base_tree: baseCommit.tree.sha,
    tree: treeItems,
  });

  const { data: commit } = await octokit.git.createCommit({
    owner,
    repo,
    message: "chore: bootstrap repo with CI, package.json, and vercel.json",
    tree: tree.sha,
    parents: [baseSha],
  });

  await octokit.git.updateRef({
    owner,
    repo,
    ref: "heads/main",
    sha: commit.sha,
  });
}

async function createRepoForOwner(
  octokit: Octokit,
  owner: string,
  repo: string
): Promise<void> {
  let isOrg = false;
  try {
    const { data: ownerData } = await octokit.users.getByUsername({ username: owner });
    isOrg = ownerData.type === "Organization";
  } catch {
    // Default to user if lookup fails
  }

  if (isOrg) {
    await octokit.repos.createInOrg({
      org: owner,
      name: repo,
      auto_init: true,
      visibility: "public",
    });
  } else {
    await octokit.repos.createForAuthenticatedUser({
      name: repo,
      auto_init: true,
      private: false,
    });
  }
}

export async function ensureRepoExists(owner: string, repo: string): Promise<void> {
  const octokit = getOctokit();

  try {
    await octokit.repos.get({ owner, repo });
  } catch (err: unknown) {
    const e = err as { status?: number };
    if (e.status === 404) {
      await createRepoForOwner(octokit, owner, repo);
      await bootstrapRepo(octokit, owner, repo);
    } else {
      throw err;
    }
  }
}

export async function createRepo(owner: string, repoName: string): Promise<void> {
  const octokit = getOctokit();
  await createRepoForOwner(octokit, owner, repoName);
  await bootstrapRepo(octokit, owner, repoName);
}

export async function createPullRequest(
  owner: string,
  repo: string,
  branchName: string,
  title: string,
  body: string
): Promise<PullRequestInfo> {
  const octokit = getOctokit();

  const { data: pr } = await octokit.pulls.create({
    owner,
    repo,
    title,
    body,
    head: branchName,
    base: "main",
  });

  return {
    number: pr.number,
    html_url: pr.html_url,
    head: { ref: pr.head.ref },
    title: pr.title,
  };
}

export async function getCheckRuns(
  owner: string,
  repo: string,
  ref: string
): Promise<{
  conclusion: "success" | "failure" | "neutral" | "pending";
  runs: Array<{
    name: string;
    status: string;
    conclusion: string | null;
    html_url: string;
  }>;
}> {
  const octokit = getOctokit();

  const { data } = await octokit.checks.listForRef({
    owner,
    repo,
    ref,
  });

  const runs = data.check_runs.map((r) => ({
    name: r.name,
    status: r.status,
    conclusion: r.conclusion,
    html_url: r.html_url ?? "",
  }));

  // If any are still in progress, the overall status is pending
  if (runs.some((r) => r.status !== "completed")) {
    return { conclusion: "pending", runs };
  }

  // If any failed, the overall conclusion is failure
  if (runs.some((r) => r.conclusion === "failure")) {
    return { conclusion: "failure", runs };
  }

  // If there are no runs at all, treat as pending
  if (runs.length === 0) {
    return { conclusion: "pending", runs };
  }

  return { conclusion: "success", runs };
}

export async function mergePullRequest(
  owner: string,
  repo: string,
  prNumber: number
): Promise<void> {
  const octokit = getOctokit();

  await octokit.pulls.merge({
    owner,
    repo,
    pull_number: prNumber,
    merge_method: "squash",
  });
}

export async function getOpenPullRequests(
  owner: string,
  repo: string
): Promise<PullRequestInfo[]> {
  const octokit = getOctokit();

  const { data } = await octokit.pulls.list({
    owner,
    repo,
    state: "open",
    sort: "created",
    direction: "desc",
    per_page: 30,
  });

  return data.map((pr) => ({
    number: pr.number,
    html_url: pr.html_url,
    head: { ref: pr.head.ref },
    title: pr.title,
  }));
}

export async function getPRBody(
  owner: string,
  repo: string,
  prNumber: number
): Promise<string> {
  const octokit = getOctokit();

  const { data } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  return data.body ?? "";
}

export async function getFailedCheckDetails(
  owner: string,
  repo: string,
  ref: string
): Promise<string> {
  const { runs } = await getCheckRuns(owner, repo, ref);
  const failed = runs.filter((r) => r.conclusion === "failure");

  if (failed.length === 0) return "No failed checks found.";

  return failed
    .map((r) => `- **${r.name}**: ${r.conclusion} ([details](${r.html_url}))`)
    .join("\n");
}
