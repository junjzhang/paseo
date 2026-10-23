#!/usr/bin/env npx tsx

/**
 * Phase 5: Send Command Tests
 *
 * Tests the send command - sending messages to existing agents (top-level command).
 * Since daemon may not be running, we test both:
 * - Help and argument parsing
 * - Graceful error handling when daemon not running
 * - All flags are accepted
 *
 * Tests:
 * - send --help shows options
 * - send requires id and prompt arguments
 * - send handles daemon not running
 * - send --no-wait flag is accepted
 * - agent shows send in subcommands
 */

import assert from "node:assert";
import { getAvailablePort } from "./helpers/network.ts";
import { runPaseoCli } from "./helpers/test-daemon.ts";
import { $ } from "zx";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  createTestPaseoDaemon,
  type TestPaseoDaemon,
} from "../../server/src/server/test-utils/paseo-daemon.ts";
import { createTestAgentClients } from "../../server/src/server/test-utils/fake-agent-client.ts";
import { DaemonClient } from "../../server/src/server/test-utils/daemon-client.ts";

/**
 * In-process daemon with a fake provider. The CLI still runs as a real
 * subprocess against its ephemeral loopback endpoint; only the provider is fake.
 */
interface IdleDaemonHarness {
  daemon: TestPaseoDaemon;
  client: DaemonClient;
  prompts: string[];
  fetchAgent: (
    agentId: string,
  ) => Promise<NonNullable<Awaited<ReturnType<DaemonClient["fetchAgent"]>>["agent"]>>;
  holdTurn: (match: string) => { release: () => void; started: Promise<void> };
  close: () => Promise<void>;
}

function promptText(prompt: unknown): string {
  return typeof prompt === "string" ? prompt : JSON.stringify(prompt);
}

async function startIdleDaemon(root: string): Promise<IdleDaemonHarness> {
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
    agentClients,
    pluginsEnabled: false,
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.13.0",
  });
  await client.connect();
  await client.fetchAgents({ subscribe: {} });

  return {
    daemon,
    client,
    prompts,
    fetchAgent: async (agentId) => {
      const result = await client.fetchAgent({ agentId });
      assert(result?.agent, `Agent ${agentId} not found`);
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
    close: async () => {
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
    },
  };
}

$.verbose = false;

console.log("=== Send Command Tests ===\n");

// Allocate an unused endpoint for connection-error and argument-validation checks.
const port = await getAvailablePort();
const paseoHome = await mkdtemp(join(tmpdir(), "paseo-test-home-"));
const promptFilePath = join(paseoHome, "send-prompt.txt");
await writeFile(promptFilePath, "prompt from file");

try {
  // Test 1: send --help shows options
  {
    console.log("Test 1: send --help shows options");
    const result = await $`npx paseo send --help`.nothrow();
    assert.strictEqual(result.exitCode, 0, "send --help should exit 0");
    assert(result.stdout.includes("--prompt"), "help should mention --prompt option");
    assert(result.stdout.includes("--prompt-file"), "help should mention --prompt-file option");
    assert(result.stdout.includes("--no-wait"), "help should mention --no-wait flag");
    assert(result.stdout.includes("--host"), "help should mention --host option");
    assert(result.stdout.includes("--if-idle"), "help should mention --if-idle flag");
    assert(result.stdout.includes("--message-id"), "help should mention --message-id flag");
    assert(result.stdout.includes("<id>"), "help should mention id argument");
    assert(result.stdout.includes("[prompt]"), "help should mention optional prompt argument");
    console.log("  help should mention --prompt option");
    console.log("  help should mention --prompt-file option");
    console.log("  help should mention --no-wait flag");
    console.log("  help should mention --host option");
    console.log("  help should mention <id> argument");
    console.log("  help should mention [prompt] argument");
    console.log("✓ send --help shows options\n");
  }

  // Test 2: send requires id argument
  {
    console.log("Test 2: send requires id argument");
    const result =
      await $`PASEO_HOME=${paseoHome} npx paseo --host localhost:${port} send`.nothrow();
    assert.notStrictEqual(result.exitCode, 0, "should fail without id");
    const output = result.stdout + result.stderr;
    // Commander should complain about missing argument
    const hasMissingArg =
      output.toLowerCase().includes("missing") ||
      output.toLowerCase().includes("required") ||
      output.toLowerCase().includes("argument");
    assert(hasMissingArg, "error should mention missing argument");
    console.log("✓ send requires id argument\n");
  }

  // Test 3: send requires prompt argument
  {
    console.log("Test 3: send requires prompt argument");
    const result =
      await $`PASEO_HOME=${paseoHome} npx paseo --host localhost:${port} send abc123`.nothrow();
    assert.notStrictEqual(result.exitCode, 0, "should fail without prompt");
    const output = result.stdout + result.stderr;
    // Commander should complain about missing argument
    const hasMissingArg =
      output.toLowerCase().includes("missing") ||
      output.toLowerCase().includes("required") ||
      output.toLowerCase().includes("argument");
    assert(hasMissingArg, "error should mention missing argument");
    console.log("✓ send requires prompt argument\n");
  }

  // Test 4: send handles daemon not running
  {
    console.log("Test 4: send handles daemon not running");
    const result =
      await $`PASEO_HOME=${paseoHome} npx paseo --host localhost:${port} send abc123 "test prompt"`.nothrow();
    // Should fail because daemon not running
    assert.notStrictEqual(result.exitCode, 0, "should fail when daemon not running");
    const output = result.stdout + result.stderr;
    const hasError =
      output.toLowerCase().includes("daemon") ||
      output.toLowerCase().includes("connect") ||
      output.toLowerCase().includes("cannot");
    assert(hasError, "error message should mention connection issue");
    console.log("✓ send handles daemon not running\n");
  }

  // Test 5: send --no-wait flag is accepted
  {
    console.log("Test 5: send --no-wait flag is accepted");
    const result =
      await $`PASEO_HOME=${paseoHome} npx paseo --host localhost:${port} send --no-wait abc123 "test prompt"`.nothrow();
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept --no-wait flag");
    assert(!output.includes("error: option"), "should not have option parsing error");
    console.log("✓ send --no-wait flag is accepted\n");
  }

  // Test 5b: send --prompt flag is accepted
  {
    console.log("Test 5b: send --prompt flag is accepted");
    const result =
      await $`PASEO_HOME=${paseoHome} npx paseo --host localhost:${port} send --prompt "test prompt" abc123`.nothrow();
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept --prompt flag");
    assert(!output.includes("error: option"), "should not have option parsing error");
    console.log("✓ send --prompt flag is accepted\n");
  }

  // Test 5c: send --prompt-file flag is accepted
  {
    console.log("Test 5c: send --prompt-file flag is accepted");
    const result =
      await $`PASEO_HOME=${paseoHome} npx paseo --host localhost:${port} send --prompt-file ${promptFilePath} abc123`.nothrow();
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept --prompt-file flag");
    assert(!output.includes("error: option"), "should not have option parsing error");
    console.log("✓ send --prompt-file flag is accepted\n");
  }

  // Test 6: send --host flag is accepted
  {
    console.log("Test 6: send --host flag is accepted");
    const result =
      await $`PASEO_HOME=${paseoHome} npx paseo send --host localhost:${port} abc123 "test prompt"`.nothrow();
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept --host flag");
    assert(!output.includes("error: option"), "should not have option parsing error");
    console.log("✓ send --host flag is accepted\n");
  }

  // Test 7: -q (quiet) flag is accepted with send
  {
    console.log("Test 7: -q (quiet) flag is accepted with send");
    const result =
      await $`PASEO_HOME=${paseoHome} npx paseo --host localhost:${port} -q send --no-wait abc123 "test prompt"`.nothrow();
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept -q flag");
    assert(!output.includes("error: option"), "should not have option parsing error");
    console.log("✓ -q (quiet) flag is accepted with send\n");
  }

  // Test 8: Combined flags work together
  {
    console.log("Test 8: Combined flags work together");
    const result =
      await $`PASEO_HOME=${paseoHome} npx paseo --host localhost:${port} -q send --no-wait abc123 "Run the linter"`.nothrow();
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept all combined flags");
    assert(!output.includes("error: option"), "should not have option parsing error");
    console.log("✓ Combined flags work together\n");
  }

  // Test 8b: conflicting prompt sources are rejected
  {
    console.log("Test 8b: conflicting prompt sources are rejected");
    const result =
      await $`PASEO_HOME=${paseoHome} npx paseo --host localhost:${port} send abc123 "positional prompt" --prompt "flag prompt"`.nothrow();
    assert.notStrictEqual(result.exitCode, 0, "should fail for conflicting prompt sources");
    const output = result.stdout + result.stderr;
    assert(
      output.includes("Provide exactly one of prompt argument, --prompt, or --prompt-file"),
      "should explain conflicting prompt sources",
    );
    console.log("✓ conflicting prompt sources are rejected\n");
  }

  // Test 9: paseo --help shows send command
  {
    console.log("Test 9: paseo --help shows send command");
    const result = await $`npx paseo --help`.nothrow();
    assert.strictEqual(result.exitCode, 0, "paseo --help should exit 0");
    assert(result.stdout.includes("send"), "help should mention send command");
    console.log("✓ paseo --help shows send command\n");
  }

  // Test 10: ID prefix syntax is mentioned in help
  {
    console.log("Test 10: send command description mentions ID");
    const result = await $`npx paseo send --help`.nothrow();
    assert.strictEqual(result.exitCode, 0, "send --help should exit 0");
    const hasIdMention =
      result.stdout.toLowerCase().includes("id") || result.stdout.toLowerCase().includes("prefix");
    assert(hasIdMention, "help should mention ID or prefix");
    console.log("✓ send command description mentions ID\n");
  }

  // Test 11: idle-only delivery through a real CLI process and an isolated daemon
  {
    console.log("Test 11: --if-idle CLI -> isolated daemon -> fake provider");

    const root = await mkdtemp(join(tmpdir(), "paseo-cli-idle-"));
    const idlePromptFile = join(root, "idle.txt");
    const busyPromptFile = join(root, "busy.txt");
    const idleText = "cli idle-only notification";
    const busyText = "cli busy notification";
    await writeFile(idlePromptFile, idleText);
    await writeFile(busyPromptFile, busyText);

    try {
      const workDir = join(root, "cwd");
      await mkdir(workDir, { recursive: true });
      const harness = await startIdleDaemon(root);
      try {
        const cliContext = { paseoHome: harness.daemon.paseoHome, workDir };
        const sendArgs = (target: string, messageId: string, promptFile: string) => [
          "--json",
          "send",
          target,
          "--if-idle",
          "--message-id",
          messageId,
          "--prompt-file",
          promptFile,
          "--no-wait",
          "--host",
          `127.0.0.1:${harness.daemon.port}`,
        ];
        const runCli = (args: string[]) =>
          runPaseoCli(cliContext, args, {
            // Keep tsx loader deprecation notices out of the CLI's JSON streams.
            env: { PASEO_AGENT_ID: "", NODE_OPTIONS: "--no-deprecation" },
            timeout: 30000,
          });

        const created = await harness.client.createAgent({
          config: { provider: "codex", cwd: workDir },
        });
        const agentId = created.id;
        const prefix = agentId.slice(0, 8);
        const before = await harness.fetchAgent(agentId);
        const sessionId = before.persistence?.sessionId;
        assert.strictEqual(typeof sessionId, "string", "fake provider should expose a session ID");

        // Idle delivery starts a turn and returns the canonical ID.
        const idle = await runCli(sendArgs(prefix, "cli-idle-1", idlePromptFile));
        assert.strictEqual(idle.exitCode, 0, `idle send should succeed: ${idle.stderr}`);
        const idleResult = JSON.parse(idle.stdout.trim());
        assert.deepStrictEqual(
          { agentId: idleResult.agentId, status: idleResult.status },
          { agentId, status: "sent" },
          "idle send should return the canonical agent ID and sent status",
        );
        await harness.client.waitForFinish(agentId, 10_000);
        assert.strictEqual(
          harness.prompts.filter((prompt) => prompt.includes(idleText)).length,
          1,
          "idle send should dispatch exactly one prompt",
        );

        // A held turn rejects with agent_busy and no side effects.
        const hold = harness.holdTurn("cli active turn");
        try {
          await harness.client.sendMessage(agentId, "cli active turn");
          await hold.started;

          const busy = await runCli(sendArgs(prefix, "cli-idle-busy", busyPromptFile));
          assert.notStrictEqual(busy.exitCode, 0, "busy idle-only send should fail");
          const busyError = JSON.parse(busy.stderr.trim());
          assert.strictEqual(busyError.error.code, "agent_busy", "stderr should report agent_busy");
          assert.strictEqual(
            harness.prompts.filter((prompt) => prompt.includes(busyText)).length,
            0,
            "busy rejection should not dispatch the rejected prompt",
          );
          const during = await harness.fetchAgent(agentId);
          assert.strictEqual(during.status, "running", "the active turn should keep running");
          assert.strictEqual(during.persistence?.sessionId, sessionId);
        } finally {
          hold.release();
        }
        await harness.client.waitForFinish(agentId, 10_000);

        // Retrying the same message ID after the turn finishes succeeds once.
        const retry = await runCli(sendArgs(prefix, "cli-idle-busy", busyPromptFile));
        assert.strictEqual(retry.exitCode, 0, `retry should succeed: ${retry.stderr}`);
        const retryResult = JSON.parse(retry.stdout.trim());
        assert.strictEqual(retryResult.agentId, agentId);
        assert.strictEqual(retryResult.status, "sent");
        await harness.client.waitForFinish(agentId, 10_000);
        assert.strictEqual(
          harness.prompts.filter((prompt) => prompt.includes(busyText)).length,
          1,
          "retry should dispatch the prompt exactly once",
        );

        // A completed replay is acknowledged without another turn.
        const replay = await runCli(sendArgs(prefix, "cli-idle-busy", busyPromptFile));
        assert.strictEqual(replay.exitCode, 0, `replay should be acknowledged: ${replay.stderr}`);
        const replayResult = JSON.parse(replay.stdout.trim());
        assert.strictEqual(replayResult.agentId, agentId);
        assert.strictEqual(replayResult.status, "sent");
        assert.strictEqual(
          harness.prompts.filter((prompt) => prompt.includes(busyText)).length,
          1,
          "completed replay should not execute again",
        );

        const after = await harness.fetchAgent(agentId);
        assert.strictEqual(
          after.persistence?.sessionId,
          sessionId,
          "native session ID must not change",
        );
        assert.strictEqual(after.status, "idle");
        console.log("✓ CLI idle-only delivery, busy rejection, retry, and replay\n");
      } finally {
        await harness.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
} finally {
  // Clean up temp directory
  await rm(paseoHome, { recursive: true, force: true });
}

console.log("=== All send tests passed ===");
