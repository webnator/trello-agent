import { spawn } from "child_process";

export interface StructuredCard {
  title: string;
  description: string;
}

const SYSTEM_PROMPT = `You are a task writer. The user will give you a free-form task description. You must respond with ONLY a JSON object (no markdown fences, no extra text) with exactly two fields:

{
  "title": "Short imperative card title (max 80 chars)",
  "description": "Markdown body"
}

The description must contain these sections:

## Context
What needs to be done and why.

## Acceptance Criteria
- [ ] Bullet checklist of requirements

## Tech Design
Brief approach and architecture notes.

## Edge Cases
Things to watch out for.

## Testing Notes
How to verify the work is correct.

Respond with ONLY the JSON object. No explanation, no fences.`;

export function structureCard(rawInput: string): Promise<StructuredCard> {
  return new Promise((resolve, reject) => {
    const prompt = `${SYSTEM_PROMPT}\n\nUser input:\n${rawInput}`;

    const args = ["-p", prompt, "--output-format", "text", "--model", "haiku"];

    const proc = spawn("claude", args, {
      cwd: "/tmp",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    const chunks: string[] = [];
    let settled = false;

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      if (!settled) {
        settled = true;
        reject(new Error("structureCard timed out after 60s"));
      }
    }, 60_000);

    proc.stdout.on("data", (data: Buffer) => {
      chunks.push(data.toString());
    });

    proc.stderr.on("data", (data: Buffer) => {
      process.stderr.write(`  [structure-card:err] ${data.toString()}`);
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;

      if (code !== 0 && code !== null) {
        console.warn(`structureCard claude exited with code ${code}, using fallback`);
        resolve(fallback(rawInput));
        return;
      }

      const raw = chunks.join("");
      resolve(parseCardJson(raw, rawInput));
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      console.error("Failed to spawn claude for card structuring:", err.message);
      resolve(fallback(rawInput));
    });
  });
}

function parseCardJson(raw: string, originalInput: string): StructuredCard {
  // Strip markdown code fences if present
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "");
  cleaned = cleaned.trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.title === "string" &&
      typeof parsed.description === "string"
    ) {
      return { title: parsed.title, description: parsed.description };
    }
  } catch {
    // JSON parse failed
  }

  console.warn("Failed to parse structured card JSON, using fallback");
  return fallback(originalInput);
}

function fallback(rawInput: string): StructuredCard {
  return {
    title: rawInput.slice(0, 80),
    description: rawInput,
  };
}
