import "dotenv/config";
import { pollLoop, stopPolling } from "./lib/poller.js";
import { startBot, stopBot } from "./lib/telegram.js";
import { loadRegistry, getAllProjects } from "./lib/projects.js";
import { getActiveClaudeProcesses } from "./lib/claude.js";
import { startDashboard, stopDashboard } from "./lib/dashboard.js";

console.log("Task Agent Daemon starting...");

// Validate required env vars (API credentials only - per-project settings come from registry)
const required = ["GITHUB_TOKEN"];
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`Missing required env vars: ${missing.join(", ")}`);
  process.exit(1);
}

// Load project registry
const registry = loadRegistry();
const projects = getAllProjects();

if (projects.length === 0) {
  console.warn("No projects configured. Use /newproject from Telegram to create one.");
  console.warn("Or create ~/.task-agent/projects.json manually.");
} else {
  console.log(`Loaded ${projects.length} project(s):`);
  for (const p of projects) {
    console.log(`  - ${p.name}: ${p.githubOwner}/${p.githubRepo}`);
  }
}

console.log(`Workspace: ${process.env.WORKSPACE_DIR || "~/workspace/task-agent-projects"}`);
console.log("");

// Uncaught exception handlers
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

// Graceful shutdown
let shutdownInProgress = false;

function shutdown(signal: string): void {
  if (shutdownInProgress) return;
  shutdownInProgress = true;

  console.log(`\n${signal} received. Shutting down gracefully...`);
  stopPolling();
  stopBot();
  stopDashboard();

  // Kill all in-flight Claude processes
  const activeProcs = getActiveClaudeProcesses();
  if (activeProcs.size > 0) {
    console.log(`Terminating ${activeProcs.size} active Claude process(es)...`);
    for (const proc of activeProcs) {
      proc.kill("SIGTERM");
    }
  }

  // Hard exit timeout: if still running after 30s, force exit
  setTimeout(() => {
    console.error("Shutdown timed out after 30s. Forcing exit.");
    process.exit(1);
  }, 30_000).unref();

  // Give in-flight tasks a moment to finish
  setTimeout(() => {
    console.log("Daemon stopped.");
    process.exit(0);
  }, 2000);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Start polling and Telegram bot
const interval = parseInt(process.env.POLL_INTERVAL_MS || "30000", 10);
pollLoop(interval);
startBot();
startDashboard();
