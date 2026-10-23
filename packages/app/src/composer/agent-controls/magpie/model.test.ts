import { describe, expect, it } from "vitest";
import { resolveMagpieGroup, ultraDisabledReason, resolveMagpieSpeedLabel } from "./model";
import type { MenuBarQuotaReport } from "../../../../../desktop/src/features/menu-bar/quotas";

const report: MenuBarQuotaReport = {
  hostId: "remote",
  hostLabel: "devcloud",
  state: "ready",
  checkedAt: 1,
  accounts: [],
  speedControlReady: true,
  groups: [
    {
      id: "gpt-6-astra",
      name: "GPT-6 Astra",
      source: "auto",
      controllable: true,
      ultraAvailable: true,
      ultraEnabled: false,
    },
  ],
};

describe("composer Magpie selection", () => {
  it("reflects Fast when the personal Ultra fast override is off", () => {
    expect(resolveMagpieSpeedLabel({ source: "personal", ultraEnabled: false }, false)).toBe(
      "默认速度",
    );
    expect(resolveMagpieSpeedLabel({ source: "personal", ultraEnabled: false }, true)).toBe("Fast");
    expect(resolveMagpieSpeedLabel({ source: "personal", ultraEnabled: true }, false)).toBe(
      "Ultra fast",
    );
    expect(resolveMagpieSpeedLabel({ source: "auto", ultraEnabled: true }, true)).toBe(
      "Ultra fast",
    );
    expect(resolveMagpieSpeedLabel({ source: "ichat", ultraEnabled: true }, true)).toBe("Fast");
    expect(resolveMagpieSpeedLabel({ source: "ichat", ultraEnabled: true }, false)).toBe(
      "默认速度",
    );
    expect(resolveMagpieSpeedLabel(null, true)).toBe("读取速度…");
  });
  it("selects only the current host report and exact model ID", () => {
    expect(resolveMagpieGroup(report, "codex", "gpt-6-astra")?.id).toBe("gpt-6-astra");
    expect(resolveMagpieGroup(report, "codex", "codex/gpt-6-astra")?.id).toBe("gpt-6-astra");
    expect(resolveMagpieGroup(report, "codex", "gpt-6.1-sol")).toBeNull();
  });
  it("does not expose unrelated provider or offline cached settings", () => {
    expect(resolveMagpieGroup(report, "claude", "gpt-6-astra")).toBeNull();
    expect(resolveMagpieGroup(report, "opencode", "gpt-6-astra")).toBeNull();
    expect(
      resolveMagpieGroup({ ...report, state: "unavailable" }, "codex", "gpt-6-astra"),
    ).toBeNull();
  });
  it("explains speed capability and source restrictions", () => {
    const group = report.groups![0];
    expect(ultraDisabledReason(group, report)).toBeNull();
    expect(ultraDisabledReason({ ...group, source: "ichat" }, report)).toBe(
      "请先切换到个人优先或个人账号",
    );
    expect(ultraDisabledReason({ ...group, ultraAvailable: false }, report)).toBe(
      "此模型的个人账号不支持 Ultra fast",
    );
    expect(ultraDisabledReason(group, { ...report, speedControlReady: false })).toBe(
      "远程速度中间件未就绪",
    );
  });
});
