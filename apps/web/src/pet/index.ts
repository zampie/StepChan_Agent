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
  VisemeTracker,
  audioVisemeLadder,
  audioDrivenVisemes,
  silenceFloor,
  minHoldMs,
} from './visemeMap';
export {
  BlinkScheduler,
  Spring,
  breathe,
  sway,
  squash,
  fxPose,
  easeInOut,
  crossfadeMs,
  type BlinkOptions,
} from './motion';
