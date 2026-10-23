import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useStableEvent } from "@/hooks/use-stable-event";
import { Text, View } from "react-native";
import { ChevronDown, CircleUserRound, Gauge } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useMutation } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import { getHostRuntimeStore, useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useComposerControlLayout } from "@/composer/agent-controls/layout-context";
import { ComposerToolbarGlyph } from "@/composer/agent-controls/glyph";
import { fetchMenuBarQuota } from "@/desktop/menu-bar/quotas";
import { executeMagpieAction } from "@/desktop/menu-bar/actions.electron";
import type { MagpieAction } from "../../../../../desktop/src/features/menu-bar/quotas";
import {
  resolveMagpieGroup,
  SOURCE_LABELS,
  ultraDisabledReason,
  hideMagpieControls,
  resolveMagpieSpeedLabel,
} from "./model";
import type { MagpieComposerControlsProps } from "./index";
import type { Theme } from "@/styles/theme";
import type { MenuTriggerState } from "@/components/ui/menu/menu-root";

const AccountIcon = withUnistyles(CircleUserRound);
const SpeedIcon = withUnistyles(Gauge);
const Caret = withUnistyles(ChevronDown);
function mutedIcon(theme: Theme) {
  return { color: theme.colors.foregroundMuted };
}
function activeIcon(theme: Theme) {
  return { color: theme.colors.palette.yellow[400] };
}
function triggerStyle({ hovered, open }: MenuTriggerState) {
  return [styles.trigger, (hovered || open) && styles.highlight];
}
function compactTriggerStyle(state: MenuTriggerState) {
  return [...triggerStyle(state), styles.iconOnly];
}

export function MagpieComposerControls(props: MagpieComposerControlsProps) {
  if (!props.serverId || !["codex", "claude"].includes(props.provider)) return null;
  return (
    <ConnectedControls
      key={`${props.serverId}:${props.provider}:${props.model}`}
      {...props}
      serverId={props.serverId}
    />
  );
}

function ConnectedControls({
  serverId,
  provider,
  model,
  disabled,
  fastEnabled,
  compact,
  onVisibilityChange,
}: MagpieComposerControlsProps & { serverId: string }) {
  const runtime = useHostRuntimeSnapshot(serverId);
  const online = runtime?.connectionStatus === "online";
  const { glyphSize } = useComposerControlLayout();
  const [open, setOpen] = useState<"account" | "speed" | null>(null);
  const hostLabel =
    getHostRuntimeStore()
      .getHosts()
      .find((host) => host.serverId === serverId)?.label ?? serverId;
  const query = useFetchQuery({
    queryKey: ["menu-bar", "magpie-quotas", serverId, online ? "online" : "offline"],
    enabled: online,
    dataShape: "value",
    staleTimeMs: 60_000,
    refetchInterval: 60_000,
    retry: false,
    queryFn: async () => {
      const client = getHostRuntimeStore().getClient(serverId);
      if (!client) throw new Error("主机连接已断开");
      return fetchMenuBarQuota({ hostId: serverId, hostLabel, client });
    },
  });
  const mutation = useMutation({
    mutationFn: (action: MagpieAction) => executeMagpieAction(action),
  });
  const report = query.data;
  const group = resolveMagpieGroup(report, provider, model);
  const hidden = hideMagpieControls(report, group !== null);
  useEffect(() => {
    onVisibilityChange?.(!hidden);
    return () => onVisibilityChange?.(false);
  }, [hidden, onVisibilityChange]);
  // A missing plugin or unrelated model has no effect on this provider's requests.
  const available = online && report?.state === "ready" && group !== null;
  const busy = mutation.isPending;
  const cannotChange = disabled || busy || !available;
  const reason = group && report ? ultraDisabledReason(group, report) : "等待主机连接与模型路由";
  const stateLabel = online ? report?.issue || "正在读取 Magpie 设置" : "主机离线，请恢复连接";

  const change = useStableEvent((action: MagpieAction) => {
    mutation.mutate(action);
  });
  const changeOpen = useStableEvent((kind: "account" | "speed", next: boolean) => {
    if (busy) return;
    mutation.reset();
    setOpen(next ? kind : null);
  });
  const status = useMemo(
    () => (
      <ControlStatus
        hostLabel={hostLabel}
        model={model}
        available={available}
        stateLabel={stateLabel}
        mutation={mutation}
      />
    ),
    [hostLabel, model, available, stateLabel, mutation],
  );
  if (hidden) return null;

  return (
    <View style={styles.controls} testID="composer-magpie-controls">
      <AccountMenu
        group={group}
        glyphSize={glyphSize}
        compact={compact}
        status={status}
        open={open}
        changeOpen={changeOpen}
        cannotChange={cannotChange}
        online={online}
        busy={busy}
        available={available}
        serverId={serverId}
        change={change}
      />
      <SpeedMenu
        group={group}
        glyphSize={glyphSize}
        compact={compact}
        fastEnabled={fastEnabled}
        status={status}
        open={open}
        changeOpen={changeOpen}
        cannotChange={cannotChange}
        speedControlReady={report?.speedControlReady === true}
        reason={reason}
        serverId={serverId}
        change={change}
      />
    </View>
  );
}

interface MenuProps {
  group: ReturnType<typeof resolveMagpieGroup>;
  glyphSize: number;
  compact: boolean;
  status: ReactNode;
  open: "account" | "speed" | null;
  changeOpen: (kind: "account" | "speed", next: boolean) => void;
  cannotChange: boolean;
  serverId: string;
  change: (action: MagpieAction) => void;
}
interface AccountProps extends MenuProps {
  online: boolean;
  busy: boolean;
  available: boolean;
}
function AccountMenu({
  group,
  glyphSize,
  compact,
  status,
  open,
  changeOpen,
  cannotChange,
  online,
  busy,
  available,
  serverId,
  change,
}: AccountProps) {
  const sourceLabel = group ? SOURCE_LABELS[group.source] : "账号来源";
  const openChange = useStableEvent((next: boolean) => {
    changeOpen("account", next);
  });
  const refresh = useStableEvent(() => {
    change({ kind: "refresh", hostId: serverId });
  });
  const login = useStableEvent(() => {
    change({ kind: "magpie", hostId: serverId });
  });
  function renderSource(source: "auto" | "personal" | "ichat") {
    return (
      <SourceItem
        key={source}
        source={source}
        group={group}
        cannotChange={cannotChange}
        serverId={serverId}
        change={change}
      />
    );
  }
  return (
    <DropdownMenu open={open === "account"} onOpenChange={openChange} compactMode="sheet">
      <DropdownMenuTrigger
        accessibilityLabel={`账号来源：${sourceLabel}`}
        testID="composer-account-selector"
        style={compact ? compactTriggerStyle : triggerStyle}
      >
        <ComposerToolbarGlyph size={glyphSize}>
          <AccountIcon size={glyphSize} uniProps={mutedIcon} />
        </ComposerToolbarGlyph>
        {!compact ? (
          <Text style={styles.value} numberOfLines={1}>
            {sourceLabel}
          </Text>
        ) : null}
        {!compact ? <Caret size={12} uniProps={mutedIcon} /> : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" width={320} sheetTitle="账号来源">
        <DropdownMenuLabel>账号来源</DropdownMenuLabel>
        {status}
        {(["auto", "personal", "ichat"] as const).map(renderSource)}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!online || busy} closeOnSelect={false} onSelect={refresh}>
          刷新账号与额度
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!available || busy} onSelect={login}>
          登录 / 更换个人账号…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SourceItem({
  source,
  group,
  cannotChange,
  serverId,
  change,
}: Pick<MenuProps, "group" | "cannotChange" | "serverId" | "change"> & {
  source: "auto" | "personal" | "ichat";
}) {
  const select = useStableEvent(() => {
    if (group) change({ kind: "source", hostId: serverId, groupId: group.id, source });
  });
  return (
    <DropdownMenuItem
      key={source}
      selected={group?.source === source}
      disabled={cannotChange}
      closeOnSelect={false}
      onSelect={select}
      description={source === "auto" ? "优先个人账号，不可用时回退 ichat" : undefined}
    >
      {SOURCE_LABELS[source]}
    </DropdownMenuItem>
  );
}

interface SpeedProps extends MenuProps {
  fastEnabled: boolean;
  speedControlReady: boolean;
  reason: string | null;
}
function SpeedMenu({
  group,
  glyphSize,
  compact,
  fastEnabled,
  status,
  open,
  changeOpen,
  cannotChange,
  speedControlReady,
  reason,
  serverId,
  change,
}: SpeedProps) {
  const speedLabel = resolveMagpieSpeedLabel(group, fastEnabled);
  const iconProps =
    group && (fastEnabled || (group.ultraEnabled && group.source !== "ichat"))
      ? activeIcon
      : mutedIcon;
  const openChange = useStableEvent((next: boolean) => {
    changeOpen("speed", next);
  });
  const normal = useStableEvent(() => {
    if (group) change({ kind: "ultra", hostId: serverId, groupId: group.id, enabled: false });
  });
  const ultra = useStableEvent(() => {
    if (group) change({ kind: "ultra", hostId: serverId, groupId: group.id, enabled: true });
  });
  return (
    <DropdownMenu open={open === "speed"} onOpenChange={openChange} compactMode="sheet">
      <DropdownMenuTrigger
        accessibilityLabel={`Magpie 速度：${speedLabel}`}
        testID="composer-magpie-speed-selector"
        style={compact ? compactTriggerStyle : triggerStyle}
      >
        <ComposerToolbarGlyph size={glyphSize}>
          <SpeedIcon size={glyphSize} uniProps={iconProps} />
        </ComposerToolbarGlyph>
        {!compact ? (
          <Text style={styles.value} numberOfLines={1}>
            {speedLabel}
          </Text>
        ) : null}
        {!compact ? <Caret size={12} uniProps={mutedIcon} /> : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" width={320} sheetTitle="Magpie 速度">
        <DropdownMenuLabel>个人账号速度</DropdownMenuLabel>
        {status}
        <DropdownMenuItem
          selected={group?.ultraEnabled === false}
          disabled={cannotChange || !speedControlReady || !group?.ultraEnabled}
          closeOnSelect={false}
          onSelect={normal}
          description={`取消个人 Ultra fast 覆盖；当前 Fast 按钮${fastEnabled ? "已开启，请求 Fast" : "已关闭，请求默认档位"}`}
        >
          跟随 Fast 按钮
        </DropdownMenuItem>
        <DropdownMenuItem
          selected={group?.ultraEnabled === true}
          disabled={cannotChange || reason !== null}
          closeOnSelect={false}
          onSelect={ultra}
          description={
            reason || "覆盖个人请求为 Ultra fast；ichat 回退不使用此档位，可能加快额度消耗"
          }
        >
          Ultra fast
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface StatusProps {
  hostLabel: string;
  model: string | undefined;
  available: boolean;
  stateLabel: string;
  mutation: { isPending: boolean; isSuccess: boolean; error: Error | null };
}
function ControlStatus({ hostLabel, model, available, stateLabel, mutation }: StatusProps) {
  return (
    <>
      <Text style={styles.hint}>
        {hostLabel} · {model}
      </Text>
      <Text style={styles.hint}>
        Magpie 主机级设置：该模型的其他请求也会受影响。不经过 Magpie 的会话不受影响。
      </Text>
      {!available ? <Text style={styles.hint}>{stateLabel}</Text> : null}
      {mutation.isPending ? <Text style={styles.hint}>正在保存…</Text> : null}
      {mutation.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {mutation.error.message}
        </Text>
      ) : null}
      {mutation.isSuccess ? <Text style={styles.success}>已保存，后续 Magpie 请求生效</Text> : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  controls: {
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  trigger: {
    height: 28,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius["2xl"],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    minWidth: 0,
    flexShrink: 1,
  },
  iconOnly: { width: 28, paddingHorizontal: 0, flexShrink: 0, justifyContent: "center" },
  highlight: { backgroundColor: theme.colors.interactionHighlight },
  value: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[3],
  },
  success: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[3],
  },
}));
