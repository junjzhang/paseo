import type { PluginServerContext } from "@getpaseo/plugin/server";
import { MagpieBridge } from "./server/magpie.js";
import { SshBridge, sshConfig } from "./server/ssh.js";
import {
  snapshotRpc,
  startRpc,
  sourceRpc,
  ultraRpc,
  signInStartRpc,
  signInPollRpc,
  signInSubmitRpc,
  signInCancelRpc,
} from "./shared/magpie.js";

export default function contribute(server: PluginServerContext) {
  const config = sshConfig(process.env);
  const bridge = config ? new SshBridge(config) : new MagpieBridge();
  server.handle(snapshotRpc, ({ refresh }) => bridge.snapshot(refresh));
  server.handle(startRpc, () => bridge.start());
  server.handle(sourceRpc, async ({ groupId, source }) => {
    await bridge.controls.source(groupId, source);
    return bridge.snapshot();
  });
  server.handle(ultraRpc, async ({ groupId, enabled }) => {
    await bridge.controls.ultra(groupId, enabled);
    return bridge.snapshot();
  });
  server.handle(signInStartRpc, ({ agent }) => bridge.begin(agent));
  server.handle(signInPollRpc, ({ id }) => bridge.poll(id));
  server.handle(signInSubmitRpc, ({ id, callback }) => bridge.submit(id, callback));
  server.handle(signInCancelRpc, ({ id }) => bridge.cancel(id));
  return () => bridge.dispose();
}
