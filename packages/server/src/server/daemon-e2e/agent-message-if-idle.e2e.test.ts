import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";

import type { AgentPromptInput } from "../agent/agent-sdk-types.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

interface Harness {
  daemon: TestPaseoDaemon;
  client: DaemonClient;
  prompts: string[];
  createAgent: () => Promise<string>;
  fetchAgent: (agentId: string) => Promise<AgentSnapshotPayload>;
  holdTurn: (match: string) => { release: () => void; started: Promise<void> };
  close: () => Promise<void>;
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function promptText(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") return prompt;
  return JSON.stringify(prompt);
}

async function makeRoot(): Promise<{ root: string; cwd: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-if-idle-"));
  roots.push(root);
  const cwd = await mkdtemp(path.join(root, "cwd-"));
  return { root, cwd };
}

async function startHarness(root: string, cwd: string): Promise<Harness> {
  const prompts: string[] = [];
  const startWaiters: Array<() => void> = [];
  let holdMatch: string | null = null;
  let holdRelease: Promise<void> | null = null;

  const agentClients = createTestAgentClients({
    onStartTurn: (prompt, config) => {
      if (config.internal) return;
      prompts.push(promptText(prompt));
      for (const resolve of startWaiters.splice(0)) resolve();
    },
    beforeTurnComplete: async (prompt) => {
      if (holdMatch === null || !promptText(prompt).includes(holdMatch)) return;
      const release = holdRelease;
      holdMatch = null;
      holdRelease = null;
      await release;
    },
  });

  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot: root,
    cleanup: false,
    agentClients,
    pluginsEnabled: false,
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.13.0",
  });
  await client.connect();
  await client.fetchAgents({ subscribe: {} });

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client.close().catch(() => undefined);
    await daemon.close().catch(() => undefined);
  };

  return {
    daemon,
    client,
    prompts,
    createAgent: async () => {
      const agent = await client.createAgent({ config: { provider: "codex", cwd } });
      return agent.id;
    },
    fetchAgent: async (agentId) => {
      const result = await client.fetchAgent({ agentId });
      if (!result?.agent) throw new Error(`Agent ${agentId} not found`);
      return result.agent;
    },
    holdTurn: (match) => {
      let release!: () => void;
      holdRelease = new Promise<void>((resolve) => {
        release = resolve;
      });
      holdMatch = match;
      const started = new Promise<void>((resolve) => startWaiters.push(resolve));
      return { release, started };
    },
    close,
  };
}

async function timelineText(harness: Harness, agentId: string): Promise<string[]> {
  const timeline = await harness.client.fetchAgentTimeline(agentId, {
    direction: "tail",
    limit: 50,
  });
  return timeline.entries.flatMap((entry) => {
    const item = entry.item;
    if (item.type === "user_message" || item.type === "assistant_message") return [item.text];
    return [];
  });
}

test("idle delivery starts a turn in the original provider session", async () => {
  const { root, cwd } = await makeRoot();
  const harness = await startHarness(root, cwd);
  try {
    const agentId = await harness.createAgent();
    const before = await harness.fetchAgent(agentId);
    const sessionId = before.persistence?.sessionId;
    expect(sessionId).toBeTypeOf("string");

    await expect(
      harness.client.sendAgentMessageIfIdle(agentId, "idle notification", {
        messageId: "idle-1",
      }),
    ).resolves.toEqual({ agentId });
    const finished = await harness.client.waitForFinish(agentId, 10_000);
    expect(finished.status).toBe("idle");

    const after = await harness.fetchAgent(agentId);
    expect(after.persistence?.sessionId).toBe(sessionId);
    expect(after.status).toBe("idle");
    expect(harness.prompts.filter((prompt) => prompt.includes("idle notification"))).toHaveLength(
      1,
    );
    expect(await timelineText(harness, agentId)).toContain("idle notification");
  } finally {
    await harness.close();
  }
});

test("an active turn rejects idle delivery without side effects, then retries after it finishes", async () => {
  const { root, cwd } = await makeRoot();
  const harness = await startHarness(root, cwd);
  try {
    const agentId = await harness.createAgent();
    const before = await harness.fetchAgent(agentId);
    const hold = harness.holdTurn("active turn");

    await harness.client.sendMessage(agentId, "active turn");
    await hold.started;

    await expect(
      harness.client.sendAgentMessageIfIdle(agentId, "rejected idle notification", {
        messageId: "busy-1",
      }),
    ).rejects.toMatchObject({ code: "agent_busy" });

    const during = await harness.fetchAgent(agentId);
    expect(during.status).toBe("running");
    expect(during.persistence?.sessionId).toBe(before.persistence?.sessionId);
    expect(during.archivedAt ?? null).toBe(before.archivedAt ?? null);
    expect(during.pendingPermissions ?? []).toEqual(before.pendingPermissions ?? []);
    expect(
      harness.prompts.filter((prompt) => prompt.includes("rejected idle notification")),
    ).toHaveLength(0);
    expect(await timelineText(harness, agentId)).not.toContain("rejected idle notification");

    hold.release();
    await harness.client.waitForFinish(agentId, 10_000);

    await expect(
      harness.client.sendAgentMessageIfIdle(agentId, "rejected idle notification", {
        messageId: "busy-1",
      }),
    ).resolves.toEqual({ agentId });
    await harness.client.waitForFinish(agentId, 10_000);
    expect(
      harness.prompts.filter((prompt) => prompt.includes("rejected idle notification")),
    ).toHaveLength(1);
  } finally {
    await harness.close();
  }
});

test("simultaneous idle deliveries admit exactly one turn", async () => {
  const { root, cwd } = await makeRoot();
  const harness = await startHarness(root, cwd);
  const hold = harness.holdTurn("race notification");
  try {
    const agentId = await harness.createAgent();
    const results = await Promise.allSettled([
      harness.client.sendAgentMessageIfIdle(agentId, "race notification one", {
        messageId: "race-1",
      }),
      harness.client.sendAgentMessageIfIdle(agentId, "race notification two", {
        messageId: "race-2",
      }),
    ]);
    const accepted = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: "agent_busy" });
    expect(harness.prompts.filter((prompt) => prompt.includes("race notification"))).toHaveLength(
      1,
    );

    hold.release();
    await harness.client.waitForFinish(agentId, 10_000);
  } finally {
    hold.release();
    await harness.close();
  }
});

test("a completed duplicate after a daemon restart is acknowledged without another turn", async () => {
  const { root, cwd } = await makeRoot();
  const first = await startHarness(root, cwd);
  let agentId: string;
  try {
    agentId = await first.createAgent();
    await first.client.sendAgentMessageIfIdle(agentId, "replay notification", {
      messageId: "replay-1",
    });
    await first.client.waitForFinish(agentId, 10_000);
  } finally {
    await first.close();
  }

  const second = await startHarness(root, cwd);
  try {
    const before = await second.fetchAgent(agentId);
    await expect(
      second.client.sendAgentMessageIfIdle(agentId, "replay notification", {
        messageId: "replay-1",
      }),
    ).resolves.toEqual({ agentId });
    expect(second.prompts).toHaveLength(0);
    const after = await second.fetchAgent(agentId);
    expect(after.persistence?.sessionId).toBe(before.persistence?.sessionId);
  } finally {
    await second.close();
  }
});

test("a receipt left pending by a crash stays outcome_unknown instead of replaying", async () => {
  const { root, cwd } = await makeRoot();
  const first = await startHarness(root, cwd);
  let agentId: string;
  try {
    agentId = await first.createAgent();
    await first.client.sendAgentMessageIfIdle(agentId, "ambiguous notification", {
      messageId: "ambiguous-1",
    });
    await first.client.waitForFinish(agentId, 10_000);
  } finally {
    await first.close();
  }

  const receiptDirectory = path.join(root, ".paseo", "agent-requests");
  const [receiptFile] = await readdir(receiptDirectory);
  const receiptPath = path.join(receiptDirectory, receiptFile);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as { state: string };
  expect(receipt.state).toBe("completed");
  await writeFile(receiptPath, JSON.stringify({ ...receipt, state: "pending" }), "utf8");

  const second = await startHarness(root, cwd);
  try {
    await expect(
      second.client.sendAgentMessageIfIdle(agentId, "ambiguous notification", {
        messageId: "ambiguous-1",
      }),
    ).rejects.toMatchObject({ code: "agent_request_outcome_unknown" });
    expect(second.prompts).toHaveLength(0);
  } finally {
    await second.close();
  }
});

test("the same message ID with a different request is a conflict", async () => {
  const { root, cwd } = await makeRoot();
  const harness = await startHarness(root, cwd);
  try {
    const agentId = await harness.createAgent();
    await harness.client.sendAgentMessageIfIdle(agentId, "first notification", {
      messageId: "conflict-1",
    });
    await harness.client.waitForFinish(agentId, 10_000);

    await expect(
      harness.client.sendAgentMessageIfIdle(agentId, "different notification", {
        messageId: "conflict-1",
      }),
    ).rejects.toMatchObject({ code: "agent_request_key_conflict" });
    expect(
      harness.prompts.filter((prompt) => prompt.includes("different notification")),
    ).toHaveLength(0);
  } finally {
    await harness.close();
  }
});

test("an archived agent rejects idle delivery without unarchiving it", async () => {
  const { root, cwd } = await makeRoot();
  const harness = await startHarness(root, cwd);
  try {
    const agentId = await harness.createAgent();
    await harness.client.archiveAgent(agentId);
    const archived = await harness.fetchAgent(agentId);
    expect(archived.archivedAt).toBeTypeOf("string");

    await expect(
      harness.client.sendAgentMessageIfIdle(agentId, "archived notification", {
        messageId: "archived-1",
      }),
    ).rejects.toThrow(/archived/);
    expect(harness.prompts).toHaveLength(0);
    const after = await harness.fetchAgent(agentId);
    expect(after.archivedAt).toBe(archived.archivedAt);
  } finally {
    await harness.close();
  }
});

test("a completed duplicate is acknowledged while an unrelated turn is busy", async () => {
  const { root, cwd } = await makeRoot();
  const harness = await startHarness(root, cwd);
  const hold = harness.holdTurn("unrelated busy turn");
  try {
    const agentId = await harness.createAgent();
    await harness.client.sendAgentMessageIfIdle(agentId, "replayed notification", {
      messageId: "replay-busy-1",
    });
    await harness.client.waitForFinish(agentId, 10_000);
    const settled = await harness.fetchAgent(agentId);

    await harness.client.sendMessage(agentId, "unrelated busy turn");
    await hold.started;
    const busyBefore = await harness.fetchAgent(agentId);
    expect(busyBefore.status).toBe("running");
    expect(busyBefore.activeTurn?.turnId).toBeTypeOf("string");

    await expect(
      harness.client.sendAgentMessageIfIdle(agentId, "replayed notification", {
        messageId: "replay-busy-1",
      }),
    ).resolves.toEqual({ agentId });

    const busyAfter = await harness.fetchAgent(agentId);
    expect(busyAfter.status).toBe("running");
    expect(busyAfter.activeTurn?.turnId).toBe(busyBefore.activeTurn?.turnId);
    expect(busyAfter.persistence?.sessionId).toBe(settled.persistence?.sessionId);
    expect(
      harness.prompts.filter((prompt) => prompt.includes("replayed notification")),
    ).toHaveLength(1);
    expect(harness.prompts.filter((prompt) => prompt.includes("unrelated busy turn"))).toHaveLength(
      1,
    );
    expect(
      (await timelineText(harness, agentId)).filter((text) =>
        text.includes("replayed notification"),
      ),
    ).toHaveLength(1);
    expect(
      (await timelineText(harness, agentId)).filter((text) => text.includes("unrelated busy turn")),
    ).toHaveLength(1);

    hold.release();
    await harness.client.waitForFinish(agentId, 10_000);
    expect(
      harness.prompts.filter((prompt) => prompt.includes("replayed notification")),
    ).toHaveLength(1);
  } finally {
    hold.release();
    await harness.close();
  }
});

test("archive during idle preflight cannot leave a history runtime ready to execute", async () => {
  const { root, cwd } = await makeRoot();
  const harness = await startHarness(root, cwd);
  const manager = harness.daemon.daemon.agentManager;
  const waitForClose = manager.waitForAgentClose.bind(manager);
  const hook = vi.spyOn(manager, "waitForAgentClose");
  try {
    const agentId = await harness.createAgent();
    hook.mockImplementationOnce(async (id) => {
      await manager.archiveAgent(id);
      await waitForClose(id);
    });
    await expect(
      harness.client.sendAgentMessageIfIdle(agentId, "preflight archive", {
        messageId: "preflight-archive",
      }),
    ).rejects.toThrow(/archived/);
    expect(harness.prompts).toHaveLength(0);
    expect(manager.getAgent(agentId) === null).toBe(true);
    expect((await harness.fetchAgent(agentId)).archivedAt).toBeTruthy();
  } finally {
    hook.mockRestore();
    await harness.close();
  }
});

test("archive at final admission leaves no receipt preventing an explicit retry after unarchive", async () => {
  const { root, cwd } = await makeRoot();
  const harness = await startHarness(root, cwd);
  const manager = harness.daemon.daemon.agentManager;
  const admit = manager.tryStreamAgentIfIdle.bind(manager);
  const hook = vi.spyOn(manager, "tryStreamAgentIfIdle");
  try {
    const agentId = await harness.createAgent();
    hook.mockImplementationOnce(async (...args) => {
      await manager.archiveAgent(args[0]);
      return admit(...args);
    });
    await expect(
      harness.client.sendAgentMessageIfIdle(agentId, "admission archive", {
        messageId: "admission-archive",
      }),
    ).rejects.toThrow(/archived/);
    expect(harness.prompts).toHaveLength(0);
    await manager.unarchiveSnapshot(agentId);
    await expect(
      harness.client.sendAgentMessageIfIdle(agentId, "admission archive", {
        messageId: "admission-archive",
      }),
    ).resolves.toEqual({ agentId });
    await harness.client.waitForFinish(agentId, 10_000);
    expect(harness.prompts.filter((prompt) => prompt.includes("admission archive"))).toHaveLength(
      1,
    );
  } finally {
    hook.mockRestore();
    await harness.close();
  }
});
