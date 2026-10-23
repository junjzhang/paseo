import type { MenuBarQuotaReport } from "../../../../../desktop/src/features/menu-bar/quotas";
import type { AgentFeature } from "@getpaseo/protocol/agent-types";

export function isFastFeatureEnabled(features: readonly AgentFeature[] | undefined): boolean {
  return (
    features?.some(
      (feature) =>
        feature.id === "fast_mode" && feature.type === "toggle" && feature.value === true,
    ) ?? false
  );
}

export const SOURCE_LABELS = {
  auto: "个人优先",
  personal: "个人账号",
  ichat: "ichat",
  custom: "自定义来源",
} as const;

export function resolveMagpieSpeedLabel(
  group: { source: string; ultraEnabled: boolean } | null,
  fastEnabled: boolean,
): string {
  if (!group) return "读取速度…";
  if (group.ultraEnabled && group.source !== "ichat") return "Ultra fast";
  return fastEnabled ? "Fast" : "默认速度";
}

export function hideMagpieControls(
  report: MenuBarQuotaReport | undefined,
  hasGroup: boolean,
): boolean {
  return report?.state === "not-configured" || (report?.state === "ready" && !hasGroup);
}

export function resolveMagpieGroup(
  report: MenuBarQuotaReport | undefined,
  provider: string,
  model: string | undefined,
) {
  if (report?.state !== "ready" || !model) return null;
  if (provider !== "codex" && provider !== "claude") return null;
  const id = model.replace(/^(codex|claude|ichat)\//, "").toLowerCase();
  const matchesProvider = provider === "codex" ? id.startsWith("gpt-") : id.startsWith("claude-");
  if (!matchesProvider) return null;
  return report.groups?.find((group) => group.id === id && group.controllable) ?? null;
}

export function ultraDisabledReason(
  group: NonNullable<ReturnType<typeof resolveMagpieGroup>>,
  report: MenuBarQuotaReport,
): string | null {
  if (!group.ultraAvailable) return "此模型的个人账号不支持 Ultra fast";
  if (!report.speedControlReady) return "远程速度中间件未就绪";
  if (group.source === "ichat") return "请先切换到个人优先或个人账号";
  return null;
}
