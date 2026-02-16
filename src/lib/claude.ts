import { spawn, type ChildProcess } from "child_process";

export interface ClaudeResult {
  exitCode: number;
  output: string;
}

// Track all active Claude processes for graceful shutdown
const activeProcesses = new Set<ChildProcess>();

export function getActiveClaudeProcesses(): Set<ChildProcess> {
  return activeProcesses;
}

export function runClaude(
  workDir: string,
  prompt: string,
  timeoutMs: number = 60 * 60 * 1000
): Promise<ClaudeResult> {
  return new Promise((resolve) => {
    const chunks: string[] = [];

    const args = [
      "-p", prompt,
      "--output-format", "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ];

    const proc = spawn("claude", args, {
      cwd: workDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    activeProcesses.add(proc);

    let settled = false;
    function finish(exitCode: number) {
      if (settled) return;
      settled = true;
      clearTimeout(termTimeout);
      clearTimeout(killTimeout);
      activeProcesses.delete(proc);
      resolve({
        exitCode,
        output: chunks.join(""),
      });
    }

    // SIGTERM after timeout
    const termTimeout = setTimeout(() => {
      proc.kill("SIGTERM");
      chunks.push("\n[TIMEOUT] Claude process sent SIGTERM after timeout");
    }, timeoutMs);

    // SIGKILL escalation: 30s after SIGTERM timeout
    const killTimeout = setTimeout(() => {
      if (!settled) {
        proc.kill("SIGKILL");
        chunks.push("\n[TIMEOUT] Claude process sent SIGKILL after 30s grace period");
      }
    }, timeoutMs + 30_000);

    proc.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      chunks.push(text);
      // Log each line for progress visibility
      for (const line of text.split("\n")) {
        if (line.trim()) {
          try {
            const event = JSON.parse(line);
            if (event.type === "assistant" && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === "text") {
                  process.stdout.write(`  [claude] ${block.text.slice(0, 200)}\n`);
                }
              }
            }
          } catch {
            // Not JSON or partial line, ignore
          }
        }
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      chunks.push(text);
      process.stderr.write(`  [claude:err] ${text}`);
    });

    proc.on("close", (code) => {
      finish(code ?? 1);
    });

    proc.on("error", (err) => {
      chunks.push(`Failed to spawn claude: ${err.message}`);
      finish(1);
    });
  });
}
