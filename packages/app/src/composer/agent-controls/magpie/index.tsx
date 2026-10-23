export interface MagpieComposerControlsProps {
  serverId: string | null;
  provider: string;
  model: string | undefined;
  disabled: boolean;
  fastEnabled: boolean;
  compact: boolean;
  onVisibilityChange?: (visible: boolean) => void;
}

export function MagpieComposerControls(_props: MagpieComposerControlsProps) {
  return null;
}
