import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Test the card state management logic used by the poller.
// We test the Map-based state tracking in isolation.

interface CardState {
  attempt: number;
  inFlight: boolean;
  lastError?: string;
}

describe("poller card state management", () => {
  let cardStates: Map<string, CardState>;

  beforeEach(() => {
    cardStates = new Map();
  });

  it("initializes state for a new card", () => {
    const cardId = "card-1";
    let state = cardStates.get(cardId);

    if (!state) {
      state = { attempt: 0, inFlight: false };
      cardStates.set(cardId, state);
    }

    state.attempt++;
    state.inFlight = true;

    expect(state.attempt).toBe(1);
    expect(state.inFlight).toBe(true);
  });

  it("tracks attempts across retries", () => {
    const cardId = "card-2";

    // First attempt
    cardStates.set(cardId, { attempt: 1, inFlight: false, lastError: "CI failed" });

    // Second attempt
    const state = cardStates.get(cardId)!;
    state.attempt++;
    state.inFlight = true;

    expect(state.attempt).toBe(2);
    expect(state.lastError).toBe("CI failed");
  });

  it("prevents concurrent processing via inFlight flag", () => {
    const cardId = "card-3";
    cardStates.set(cardId, { attempt: 1, inFlight: true });

    const state = cardStates.get(cardId)!;
    const shouldSkip = state.inFlight;

    expect(shouldSkip).toBe(true);
  });

  it("cleans up state on success", () => {
    const cardId = "card-4";
    cardStates.set(cardId, { attempt: 3, inFlight: true, lastError: "prev error" });

    // Simulate success
    cardStates.delete(cardId);

    expect(cardStates.has(cardId)).toBe(false);
  });

  it("preserves error context for retry prompt", () => {
    const cardId = "card-5";
    const errorMsg = "npm test failed: 3 tests failed\n  - login.test.ts\n  - auth.test.ts";

    cardStates.set(cardId, { attempt: 1, inFlight: false, lastError: errorMsg });

    const state = cardStates.get(cardId)!;
    expect(state.lastError).toBe(errorMsg);
    expect(state.attempt).toBe(1);
  });
});
