import { afterEach, describe, expect, it, vi } from "vitest";
import {
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  logWarnMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn — transient HTTP retry", () => {
  setupRunCronIsolatedAgentTurnSuite();

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries once when the first provider attempt fails with a transient HTTP error", async () => {
    vi.useFakeTimers();
    runWithModelFallbackMock
      .mockRejectedValueOnce(new Error("529 API is busy"))
      .mockResolvedValueOnce({
        result: {
          payloads: [{ text: "cron recovered" }],
          meta: { agentMeta: { usage: { input: 10, output: 20 } } },
        },
        provider: "claude-cli",
        model: "claude-opus-4-6",
        attempts: [],
      });

    const resultPromise = runCronIsolatedAgentTurn(makeIsolatedAgentTurnParams());
    await vi.waitFor(() =>
      expect(logWarnMock).toHaveBeenCalledWith(
        expect.stringContaining("Transient HTTP provider error before reply"),
      ),
    );
    await vi.runOnlyPendingTimersAsync();
    const result = await resultPromise;

    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-transient provider failures", async () => {
    runWithModelFallbackMock.mockRejectedValueOnce(new Error("billing exhausted"));

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentTurnParams());

    expect(result.status).toBe("error");
    expect(runWithModelFallbackMock).toHaveBeenCalledTimes(1);
  });
});
