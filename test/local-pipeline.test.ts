import { describe, it, expect } from "vitest";
import type { TrelloCard } from "../src/types.js";
import { buildPrompt, slugify } from "../src/lib/local-pipeline.js";

describe("local-pipeline prompt building", () => {
  const baseCard: TrelloCard = {
    id: "card123",
    name: "Add login page",
    desc: "Create a login page with email and password fields",
    shortLink: "abc123",
    idList: "list1",
    url: "https://trello.com/c/abc123",
  };

  it("builds a basic prompt from card name and description", () => {
    const prompt = buildPrompt(baseCard);

    expect(prompt).toContain("## Task: Add login page");
    expect(prompt).toContain("Create a login page with email and password fields");
    expect(prompt).toContain("Commit your changes when everything is working");
    expect(prompt).not.toContain("Previous attempt failed");
    expect(prompt).not.toContain("## Requirements");
  });

  it("includes checklists as requirements", () => {
    const card: TrelloCard = {
      ...baseCard,
      checklists: [
        {
          id: "cl1",
          name: "Acceptance Criteria",
          checkItems: [
            { id: "i1", name: "Has email input", state: "incomplete" },
            { id: "i2", name: "Has password input", state: "complete" },
            { id: "i3", name: "Has submit button", state: "incomplete" },
          ],
        },
      ],
    };

    const prompt = buildPrompt(card);

    expect(prompt).toContain("## Requirements");
    expect(prompt).toContain("### Acceptance Criteria");
    expect(prompt).toContain("- [ ] Has email input");
    expect(prompt).toContain("- [x] Has password input");
    expect(prompt).toContain("- [ ] Has submit button");
  });

  it("appends failure context on retry", () => {
    const prompt = buildPrompt(baseCard, "CI failed: test suite returned exit code 1\nnpm test failed");

    expect(prompt).toContain("## Previous attempt failed");
    expect(prompt).toContain("CI failed: test suite returned exit code 1");
    expect(prompt).toContain("Fix the issues described above");
  });

  it("handles card with no description", () => {
    const card: TrelloCard = { ...baseCard, desc: "" };
    const prompt = buildPrompt(card);

    expect(prompt).toContain("No description provided.");
  });

  it("handles multiple checklists", () => {
    const card: TrelloCard = {
      ...baseCard,
      checklists: [
        {
          id: "cl1",
          name: "Frontend",
          checkItems: [{ id: "i1", name: "Build UI", state: "incomplete" }],
        },
        {
          id: "cl2",
          name: "Backend",
          checkItems: [{ id: "i2", name: "Create API", state: "incomplete" }],
        },
      ],
    };

    const prompt = buildPrompt(card);

    expect(prompt).toContain("### Frontend");
    expect(prompt).toContain("### Backend");
    expect(prompt).toContain("- [ ] Build UI");
    expect(prompt).toContain("- [ ] Create API");
  });
});

describe("slugify", () => {
  it("converts text to lowercase slug", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("replaces special characters with hyphens", () => {
    expect(slugify("Add login & signup page!")).toBe("add-login-signup-page");
  });

  it("truncates to 40 characters", () => {
    const long = "this is a very long card name that should be truncated at forty characters";
    expect(slugify(long).length).toBeLessThanOrEqual(40);
  });

  it("strips leading and trailing hyphens", () => {
    expect(slugify("--hello--")).toBe("hello");
  });
});
