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
  type SlotPlacements,
} from './logoManifest';
export {
  fullBodyFallback,
  parsePoseRegions,
  poseRegionsFile,
  poseRegionsManifestSchema,
  poseRegionsUrlFor,
  type LoadedPoseRegions,
  type PoseRegion,
  type PoseRegionsManifest,
} from './poseRegions';
export {
  VisemeTracker,
  audioVisemeLadder,
  audioDrivenVisemes,
  silenceFloor,
  minHoldMs,
} from './visemeMap';
export {
  BlinkScheduler,
  BreathPhase,
  HoldTimer,
  ShuffleBag,
  Spring,
  awakeBreath,
  breathe,
  breatheAt,
  listenFeel,
  listenPose,
  sway,
  squash,
  fxPose,
  easeInOut,
  crossfadeMs,
  type BlinkOptions,
  type ListenFeel,
  type ListenPose,
} from './motion';
export {
  ZzzEmitter,
  sleepExpression,
  sleepFeel,
  sleepPose,
  zzzSpawn,
  type FxSpawnPoint,
  type SleepFeel,
  type SleepPose,
} from './sleep';
export {
  tapPools,
  tapTargets,
  tapTargetOf,
  tapActionHoldMs,
  tapExpressionHoldMs,
  type TapReaction,
  type TapTarget,
} from './tapReactions';
