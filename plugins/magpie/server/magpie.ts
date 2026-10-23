import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Snapshot, SignIn } from "../shared/magpie.js";
import { projectSnapshot, projectSignIn, validCallback } from "./projection.js";
import { Controls } from "./controls.js";

const run = promisify(execFile);
export type Transport = (path: string, body?: unknown, gateway?: boolean) => Promise<unknown>;

export const localRequest: Transport = async (path, body, gateway = false) => {
  if (!/^\/(?:api|v1)\//.test(path) || path.includes(".."))
    throw new Error("不支持的 Magpie 操作。");
  const key = gateway
    ? ""
    : (await readFile(join(homedir(), ".local/state/magpie/web-key"), "utf8")).trim();
  if (!gateway && !/^[a-zA-Z0-9._~-]{16,}$/.test(key))
    throw new Error("Magpie 管理凭据格式不正确。");
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: gateway ? 3425 : 3430,
        path,
        method: payload === undefined ? "GET" : "POST",
        headers: {
          ...(gateway
            ? { Authorization: "Bearer magpie-paseo" }
            : { Cookie: `magpie_web_3430=${key}` }),
          ...(payload === undefined
            ? {}
            : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) {
            req.destroy(new Error("Magpie 返回的数据过大。"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", () => reject(new Error("Magpie 连接中断。")));
        res.on("end", () => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Magpie 操作未成功（HTTP ${res.statusCode ?? 0}）。`));
            return;
          }
          let parsed: unknown;
          try {
            parsed =
              res.statusCode === 204 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            reject(new Error("Magpie 返回了无法识别的数据。"));
            return;
          }
          resolve(parsed);
        });
      },
    );
    const deadline = setTimeout(() => req.destroy(new Error("timeout")), 30000);
    req.on("close", () => clearTimeout(deadline));
    req.on("error", () => reject(new Error("无法连接 Magpie，请启动服务后重试。")));
    req.end(payload);
  });
};

export class MagpieBridge {
  private flow: SignIn | null = null;
  private starting = false;
  readonly controls: Controls;
  constructor(private readonly send: Transport = localRequest) {
    this.controls = new Controls(send);
  }
  private activeFlow(): SignIn | null {
    return this.flow && ["waiting", "installing"].includes(this.flow.state) ? this.flow : null;
  }

  async snapshot(refresh = false): Promise<Snapshot> {
    try {
      const quota = this.send(`/v1/magpie/quotas${refresh ? "" : "?kept=1"}`, undefined, true).then(
        (data) => ({ data, failed: false }),
        () => ({ data: { data: [] }, failed: true }),
      );
      const [providers, groups, quotas] = await Promise.all([
        this.send("/api/providers"),
        this.send("/api/groups"),
        quota,
      ]);
      const result = projectSnapshot(providers, groups, quotas.data);
      await this.controls.enrich(result);
      if (quotas.failed) result.issue = "网关已连接，但本次额度读取失败。";
      result.signIn = this.activeFlow();
      return result;
    } catch {
      return {
        available: false,
        speedControlReady: false,
        issue: "无法读取 Magpie。请启动服务；若服务已运行，请检查管理界面和本机凭据。",
        checkedAt: new Date().toISOString(),
        providers: [],
        groups: [],
        quotas: [],
        signIn: this.activeFlow(),
      };
    }
  }

  async start(): Promise<Snapshot> {
    try {
      await run(join(homedir(), ".local/bin/magpie-start"), [], {
        timeout: 45000,
        maxBuffer: 16384,
      });
    } catch {
      throw new Error("Magpie 启动失败，请在服务器终端运行 magpie-start 检查。 ");
    }
    return this.snapshot();
  }

  async begin(agent: "codex" | "claude"): Promise<SignIn> {
    if (this.starting) throw new Error("正在准备登录，请稍候。");
    this.starting = true;
    try {
      if (this.flow && ["waiting", "installing"].includes(this.flow.state)) {
        const current = await this.poll(this.flow.id);
        if (["waiting", "installing"].includes(current.state)) {
          if (current.agent === agent) return current;
          throw new Error("请先完成或取消当前登录。");
        }
      }
      this.flow = projectSignIn(await this.send("/api/signin", { agent }));
      return this.flow;
    } finally {
      this.starting = false;
    }
  }

  private owned(id: string): SignIn {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || !this.flow || this.flow.id !== id)
      throw new Error("登录会话已失效，请重新开始。");
    return this.flow;
  }
  async poll(id: string): Promise<SignIn> {
    this.owned(id);
    try {
      this.flow = projectSignIn(await this.send(`/api/signin/${id}`));
    } catch {
      this.flow = { ...this.owned(id), state: "failed", error: "无法读取登录状态，请重新开始。" };
    }
    return this.flow;
  }
  async submit(id: string, callback: string): Promise<{ ok: true }> {
    const flow = this.owned(id);
    if (flow.state !== "waiting" || !validCallback(callback.trim(), flow))
      throw new Error(
        "请粘贴本次登录结束时的完整 localhost 地址，或 Claude 页面显示的 code#state。",
      );
    await this.send(`/api/signin/${id}/callback`, { url: callback.trim() });
    return { ok: true };
  }
  async cancel(id: string): Promise<{ ok: true }> {
    this.owned(id);
    await this.send(`/api/signin/${id}/cancel`, {});
    this.flow = { ...this.owned(id), state: "canceled" };
    return { ok: true };
  }
  dispose(): void {
    if (this.flow && ["waiting", "installing"].includes(this.flow.state))
      void this.cancel(this.flow.id).catch(() => {});
  }
}
