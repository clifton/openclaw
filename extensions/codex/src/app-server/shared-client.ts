import { resolveOpenClawAgentDir } from "openclaw/plugin-sdk/provider-auth";
import { applyCodexAppServerAuthProfile, bridgeCodexAppServerStartOptions } from "./auth-bridge.js";
import { CodexAppServerClient } from "./client.js";
import {
  codexAppServerStartOptionsKey,
  resolveCodexAppServerRuntimeOptions,
  type CodexAppServerStartOptions,
} from "./config.js";
import { resolveManagedCodexAppServerStartOptions } from "./managed-binary.js";
import { withTimeout } from "./timeout.js";

type SharedCodexAppServerClientEntry = {
  client?: CodexAppServerClient;
  promise?: Promise<CodexAppServerClient>;
};

type SharedCodexAppServerClientState = {
  entries: Map<string, SharedCodexAppServerClientEntry>;
};

const SHARED_CODEX_APP_SERVER_CLIENT_STATE = Symbol.for("openclaw.codexAppServerClientState");

function getSharedCodexAppServerClientState(): SharedCodexAppServerClientState {
  const globalState = globalThis as typeof globalThis & {
    [SHARED_CODEX_APP_SERVER_CLIENT_STATE]?: SharedCodexAppServerClientState;
  };
  globalState[SHARED_CODEX_APP_SERVER_CLIENT_STATE] ??= { entries: new Map() };
  globalState[SHARED_CODEX_APP_SERVER_CLIENT_STATE].entries ??= new Map();
  return globalState[SHARED_CODEX_APP_SERVER_CLIENT_STATE];
}

export async function getSharedCodexAppServerClient(options?: {
  startOptions?: CodexAppServerStartOptions;
  timeoutMs?: number;
  authProfileId?: string;
  agentDir?: string;
}): Promise<CodexAppServerClient> {
  const state = getSharedCodexAppServerClientState();
  const agentDir = options?.agentDir ?? resolveOpenClawAgentDir();
  const requestedStartOptions =
    options?.startOptions ?? resolveCodexAppServerRuntimeOptions().start;
  const managedStartOptions = await resolveManagedCodexAppServerStartOptions(requestedStartOptions);
  const startOptions = await bridgeCodexAppServerStartOptions({
    startOptions: managedStartOptions,
    agentDir,
    authProfileId: options?.authProfileId,
  });
  const key = codexAppServerStartOptionsKey(startOptions, {
    authProfileId: options?.authProfileId,
    agentDir,
  });
  const entry = getSharedCodexAppServerClientEntry(state, key);
  const sharedPromise =
    entry.promise ??
    (entry.promise = (async () => {
      const client = CodexAppServerClient.start(startOptions);
      entry.client = client;
      client.addCloseHandler((client) => clearSharedClientIfCurrent(key, client));
      try {
        await client.initialize();
        await applyCodexAppServerAuthProfile({
          client,
          agentDir,
          authProfileId: options?.authProfileId,
          startOptions,
        });
        return client;
      } catch (error) {
        // Startup failures happen before callers own the shared client, so close
        // the child here instead of leaving a rejected daemon attached to stdio.
        client.close();
        throw error;
      }
    })());
  try {
    return await withTimeout(
      sharedPromise,
      options?.timeoutMs ?? 0,
      "codex app-server initialize timed out",
    );
  } catch (error) {
    if (state.entries.get(key)?.promise === sharedPromise) {
      clearSharedCodexAppServerClientForKey(key);
    }
    throw error;
  }
}

export async function createIsolatedCodexAppServerClient(options?: {
  startOptions?: CodexAppServerStartOptions;
  timeoutMs?: number;
  authProfileId?: string;
  agentDir?: string;
}): Promise<CodexAppServerClient> {
  const agentDir = options?.agentDir ?? resolveOpenClawAgentDir();
  const requestedStartOptions =
    options?.startOptions ?? resolveCodexAppServerRuntimeOptions().start;
  const managedStartOptions = await resolveManagedCodexAppServerStartOptions(requestedStartOptions);
  const startOptions = await bridgeCodexAppServerStartOptions({
    startOptions: managedStartOptions,
    agentDir,
    authProfileId: options?.authProfileId,
  });
  const client = CodexAppServerClient.start(startOptions);
  const initialize = client.initialize();
  try {
    await withTimeout(initialize, options?.timeoutMs ?? 0, "codex app-server initialize timed out");
    await applyCodexAppServerAuthProfile({
      client,
      agentDir,
      authProfileId: options?.authProfileId,
      startOptions,
    });
    return client;
  } catch (error) {
    client.close();
    void initialize.catch(() => undefined);
    throw error;
  }
}

export function resetSharedCodexAppServerClientForTests(): void {
  const state = getSharedCodexAppServerClientState();
  state.entries.clear();
}

export function clearSharedCodexAppServerClient(): void {
  const state = getSharedCodexAppServerClientState();
  const entries = [...state.entries.values()];
  state.entries.clear();
  for (const entry of entries) {
    entry.client?.close();
  }
}

export function clearSharedCodexAppServerClientIfCurrent(
  client: CodexAppServerClient | undefined,
): boolean {
  if (!client) {
    return false;
  }
  const state = getSharedCodexAppServerClientState();
  for (const [key, entry] of state.entries) {
    if (entry.client !== client) {
      continue;
    }
    state.entries.delete(key);
    client.close();
    return true;
  }
  return false;
}

export async function clearSharedCodexAppServerClientAndWait(options?: {
  exitTimeoutMs?: number;
  forceKillDelayMs?: number;
}): Promise<void> {
  const state = getSharedCodexAppServerClientState();
  const entries = [...state.entries.values()];
  state.entries.clear();
  await Promise.all(entries.map((entry) => entry.client?.closeAndWait(options)));
}

function getSharedCodexAppServerClientEntry(
  state: SharedCodexAppServerClientState,
  key: string,
): SharedCodexAppServerClientEntry {
  const entry = state.entries.get(key) ?? {};
  state.entries.set(key, entry);
  return entry;
}

function clearSharedCodexAppServerClientForKey(key: string): void {
  const state = getSharedCodexAppServerClientState();
  const entry = state.entries.get(key);
  if (!entry) {
    return;
  }
  state.entries.delete(key);
  entry.client?.close();
}

function clearSharedClientIfCurrent(key: string, client: CodexAppServerClient): void {
  const state = getSharedCodexAppServerClientState();
  const entry = state.entries.get(key);
  if (entry?.client !== client) {
    return;
  }
  state.entries.delete(key);
}
