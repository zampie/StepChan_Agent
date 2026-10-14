// 桌宠表现层的对外入口。UI 只需要 import 这里。
export { RigRenderer, type RigRendererOptions } from './RigRenderer';
export {
  loadRig,
  resolveBaseUrl,
  degradedNames,
  availableActions,
  isNoopAction,
  type LoadedRig,
} from './rigManifest';
export {
  logoManifestSchema,
  logoSlots,
  logoManifestFile,
  logoUrlFor,
  parseLogoManifest,
  type LoadedLogo,
  type LogoManifest,
  type LogoPlacement,
  type LogoSlot,
} from './logoManifest';
export {
  VisemeTracker,
  audioVisemeLadder,
  audioDrivenVisemes,
  silenceFloor,
  minHoldMs,
} from './visemeMap';
export {
  BlinkScheduler,
  ShuffleBag,
  Spring,
  breathe,
  clawFeel,
  clawPose,
  sagTarget,
  swingTarget,
  sway,
  squash,
  fxPose,
  easeInOut,
  crossfadeMs,
  type BlinkOptions,
  type ClawFeel,
  type ClawInput,
  type ClawPose,
} from './motion';
export {
  tapPools,
  tapTargets,
  tapTargetOf,
  tapActionHoldMs,
  type TapReaction,
  type TapTarget,
} from './tapReactions';
