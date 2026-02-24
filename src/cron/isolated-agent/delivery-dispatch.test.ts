import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../agents/subagent-announce.js", () => ({
  runSubagentAnnounceFlow: vi.fn(),
}));

vi.mock("../../agents/subagent-registry.js", () => ({
  countActiveDescendantRuns: vi.fn().mockReturnValue(0),
}));

vi.mock("./subagent-followup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent-followup.js")>();
  return {
    ...actual,
    waitForDescendantSubagentSummary: vi.fn().mockResolvedValue(undefined),
    readDescendantSubagentFallbackReply: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: vi.fn().mockResolvedValue([{ messageId: "m1" }]),
}));

vi.mock("../../infra/outbound/identity.js", () => ({
  resolveAgentOutboundIdentity: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../infra/outbound/outbound-session.js", () => ({
  resolveOutboundSessionRoute: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../config/sessions.js", () => ({
  resolveAgentMainSessionKey: vi.fn().mockReturnValue("agent:default:main"),
}));

vi.mock("../../cli/outbound-send-deps.js", () => ({
  createOutboundSendDeps: vi.fn().mockReturnValue({}),
}));

vi.mock("../../logger.js", () => ({
  logWarn: vi.fn(),
}));

vi.mock("../../plugins/runtime.js", () => ({
  setActivePluginRegistry: vi.fn(),
}));

import { countActiveDescendantRuns } from "../../agents/subagent-registry.js";
import type { OpenClawConfig } from "../../config/config.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import type { CronJob } from "../types.js";
import {
  dispatchCronDelivery,
  type DispatchCronDeliveryState,
  resetCompletedDirectCronDeliveriesForTests,
  type SuccessfulDeliveryTarget,
} from "./delivery-dispatch.js";
import type { RunCronAgentTurnResult } from "./run.js";
import {
  waitForDescendantSubagentSummary,
  readDescendantSubagentFallbackReply,
} from "./subagent-followup.js";

function makeCfg(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: "anthropic/claude-opus-4-5",
        workspace: "/tmp/test-workspace",
      },
    },
    session: { store: "/tmp/sessions.json", mainKey: "main" },
  } as OpenClawConfig;
}

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  const now = Date.now();
  return {
    id: "job-1",
    name: "job-1",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "test" },
    state: {},
    ...overrides,
  };
}

const DELIVERY_TARGET: SuccessfulDeliveryTarget = {
  ok: true,
  channel: "telegram",
  to: "123",
  accountId: undefined,
  threadId: undefined,
  mode: "explicit",
};

function makeParams(overrides: Record<string, unknown> = {}) {
  const cfg = makeCfg();
  return {
    cfg,
    cfgWithAgentDefaults: cfg,
    deps: {
      sendMessageSlack: vi.fn(),
      sendMessageWhatsApp: vi.fn(),
      sendMessageTelegram: vi.fn(),
      sendMessageDiscord: vi.fn(),
      sendMessageSignal: vi.fn(),
      sendMessageIMessage: vi.fn(),
    },
    job: makeJob({ delivery: { mode: "direct" as const, channel: "telegram", to: "123" } }),
    agentId: "default",
    agentSessionKey: "cron:job-1",
    runSessionId: "run-1",
    runStartedAt: Date.now() - 5000,
    runEndedAt: Date.now(),
    timeoutMs: 30_000,
    resolvedDelivery: DELIVERY_TARGET,
    deliveryRequested: true,
    skipHeartbeatDelivery: false,
    skipMessagingToolDelivery: false,
    deliveryBestEffort: false,
    deliveryPayloadHasStructuredContent: false,
    deliveryPayloads: [] as Array<{ text: string }>,
    synthesizedText: "hello world",
    summary: "summary",
    outputText: "hello world",
    telemetry: undefined,
    abortSignal: undefined,
    isAborted: () => false,
    abortReason: () => "",
    withRunSession: (
      result: Omit<RunCronAgentTurnResult, "sessionId" | "sessionKey">,
    ): RunCronAgentTurnResult => ({
      ...result,
      sessionId: "run-1",
      sessionKey: "cron:job-1",
    }),
    ...overrides,
  };
}

describe("dispatchCronDelivery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetCompletedDirectCronDeliveriesForTests();
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(deliverOutboundPayloads).mockResolvedValue([{ messageId: "m1" }] as never);
    vi.mocked(waitForDescendantSubagentSummary).mockResolvedValue(undefined);
    vi.mocked(readDescendantSubagentFallbackReply).mockResolvedValue(undefined);
  });

  describe("NO_REPLY suppression", () => {
    it("direct mode suppresses NO_REPLY instead of sending literal text", async () => {
      const params = makeParams({
        synthesizedText: "NO_REPLY",
        outputText: "NO_REPLY",
      });

      const result: DispatchCronDeliveryState = await dispatchCronDelivery(params);

      expect(result.delivered).toBe(false);
      expect(result.result?.status).toBe("ok");
      expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    });

    it("announce mode suppresses NO_REPLY (existing behavior)", async () => {
      const params = makeParams({
        synthesizedText: "NO_REPLY",
        outputText: "NO_REPLY",
        job: makeJob({ delivery: { mode: "announce", channel: "telegram", to: "123" } }),
      });

      const result = await dispatchCronDelivery(params);

      expect(result.delivered).toBe(false);
      expect(result.result?.status).toBe("ok");
      expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    });

    it("suppresses case-insensitive no_reply variants", async () => {
      const params = makeParams({
        synthesizedText: "no_reply",
        outputText: "no_reply",
      });

      const result = await dispatchCronDelivery(params);

      expect(result.delivered).toBe(false);
      expect(result.result?.status).toBe("ok");
      expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    });
  });

  describe("subagent wait", () => {
    it("direct mode waits for subagent descendants before delivering", async () => {
      vi.mocked(countActiveDescendantRuns)
        .mockReturnValueOnce(1) // initial check: 1 active
        .mockReturnValueOnce(0); // after wait: done
      vi.mocked(waitForDescendantSubagentSummary).mockResolvedValue("final digest from subagent");

      const params = makeParams({
        synthesizedText: "on it, pulling everything together",
        outputText: "on it, pulling everything together",
      });

      const result = await dispatchCronDelivery(params);

      expect(waitForDescendantSubagentSummary).toHaveBeenCalledTimes(1);
      expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
      const payloads = vi.mocked(deliverOutboundPayloads).mock.calls[0]?.[0]?.payloads;
      expect(payloads).toEqual([{ text: "final digest from subagent" }]);
      expect(result.synthesizedText).toBe("final digest from subagent");
    });

    it("suppresses stale interim text when subagents ran but no final reply arrived", async () => {
      vi.mocked(countActiveDescendantRuns)
        .mockReturnValueOnce(1) // initial: active descendants
        .mockReturnValueOnce(0); // after wait: done
      vi.mocked(waitForDescendantSubagentSummary).mockResolvedValue(undefined);
      vi.mocked(readDescendantSubagentFallbackReply).mockResolvedValue(undefined);

      const params = makeParams({
        synthesizedText: "on it, pulling everything together",
        outputText: "on it, pulling everything together",
      });

      const result = await dispatchCronDelivery(params);

      expect(deliverOutboundPayloads).not.toHaveBeenCalled();
      expect(result.result?.status).toBe("ok");
    });

    it("returns early without delivering when subagents are still active", async () => {
      vi.mocked(countActiveDescendantRuns)
        .mockReturnValueOnce(2) // initial: 2 active
        .mockReturnValueOnce(1); // after wait: still active
      vi.mocked(waitForDescendantSubagentSummary).mockResolvedValue(undefined);

      const params = makeParams({
        synthesizedText: "working on it",
        outputText: "working on it",
      });

      const result = await dispatchCronDelivery(params);

      expect(deliverOutboundPayloads).not.toHaveBeenCalled();
      expect(result.result?.status).toBe("ok");
    });

    it("uses subagent fallback reply when wait returns nothing", async () => {
      vi.mocked(countActiveDescendantRuns)
        .mockReturnValueOnce(1) // initial: active
        .mockReturnValueOnce(0); // after wait: done
      vi.mocked(waitForDescendantSubagentSummary).mockResolvedValue(undefined);
      vi.mocked(readDescendantSubagentFallbackReply).mockResolvedValue("fallback digest text");

      const params = makeParams({
        synthesizedText: "on it, pulling everything together",
        outputText: "on it, pulling everything together",
      });

      const result = await dispatchCronDelivery(params);

      expect(readDescendantSubagentFallbackReply).toHaveBeenCalledTimes(1);
      expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
      const payloads = vi.mocked(deliverOutboundPayloads).mock.calls[0]?.[0]?.payloads;
      expect(payloads).toEqual([{ text: "fallback digest text" }]);
      expect(result.synthesizedText).toBe("fallback digest text");
    });
  });

  describe("normal delivery", () => {
    it("direct mode delivers non-NO_REPLY text via outbound payloads", async () => {
      const params = makeParams({
        synthesizedText: "here is your digest",
      });

      const result = await dispatchCronDelivery(params);

      expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
      expect(result.delivered).toBe(true);
    });
  });
});
