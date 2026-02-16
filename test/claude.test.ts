import { describe, it, expect, vi } from "vitest";
import { runClaude } from "../src/lib/claude.js";
import * as child_process from "child_process";
import { EventEmitter } from "events";
import { Readable } from "stream";

vi.mock("child_process");

function createMockProcess(exitCode: number, stdout: string, stderr: string = "") {
  const proc = new EventEmitter() as any;
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.kill = vi.fn();

  // Push data async so listeners are attached first
  setTimeout(() => {
    if (stdout) proc.stdout.push(Buffer.from(stdout));
    proc.stdout.push(null);
    if (stderr) proc.stderr.push(Buffer.from(stderr));
    proc.stderr.push(null);
    proc.emit("close", exitCode);
  }, 10);

  return proc;
}

describe("runClaude", () => {
  it("returns exit code 0 and output on success", async () => {
    const mockProc = createMockProcess(0, '{"type":"result","result":"done"}\n');
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const result = await runClaude("/tmp/test-repo", "Build a hello world app");

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("done");
    expect(child_process.spawn).toHaveBeenCalledWith(
      "claude",
      ["-p", "Build a hello world app", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"],
      expect.objectContaining({ cwd: "/tmp/test-repo" })
    );
  });

  it("returns non-zero exit code on failure", async () => {
    const mockProc = createMockProcess(1, "", "Error: something went wrong\n");
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const result = await runClaude("/tmp/test-repo", "do stuff");

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("something went wrong");
  });

  it("handles spawn errors", async () => {
    const proc = new EventEmitter() as any;
    proc.stdout = new Readable({ read() {} });
    proc.stderr = new Readable({ read() {} });
    proc.kill = vi.fn();

    setTimeout(() => {
      proc.emit("error", new Error("ENOENT: claude not found"));
    }, 10);

    vi.mocked(child_process.spawn).mockReturnValue(proc as any);

    const result = await runClaude("/tmp/test-repo", "test");

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("claude not found");
  });

  it("kills process on timeout", async () => {
    const proc = new EventEmitter() as any;
    proc.stdout = new Readable({ read() {} });
    proc.stderr = new Readable({ read() {} });
    proc.kill = vi.fn(() => {
      // Simulate process closing after kill
      setTimeout(() => proc.emit("close", null), 5);
    });

    vi.mocked(child_process.spawn).mockReturnValue(proc as any);

    const result = await runClaude("/tmp/test-repo", "long task", 50);

    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    expect(result.output).toContain("TIMEOUT");
  });
});
