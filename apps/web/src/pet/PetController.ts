import {
  presentationSchema,
  type Activity,
  type Expression,
  type Motion,
} from '../../../../shared/protocol';
import capabilities from '../../../../contracts/presentation-capabilities.json';
export class PetController {
  activity: Activity = 'idle';
  expression: Expression = 'neutral';
  motion: Motion = 'idle';
  requestId: string | null = null;
  started = 0;
  lastText = 0;
  audioLevel: number | null = null;
  audioDriven = false;
  reduced = false;
  mouthEnabled = capabilities.mouthOverlay.enabledByDefault;
  previewMouth: 'closed' | 'open_small' | 'open_big' | null = null;
  begin(id: string, now = performance.now()) {
    this.requestId = id;
    this.expression = 'neutral';
    this.previewMouth = null;
    this.setActivity('thinking', now);
  }
  setActivity(activity: Activity, now = performance.now()) {
    this.activity = activity;
    this.play(activity === 'thinking' ? 'think' : activity === 'speaking' ? 'talk' : 'idle', now);
  }
  play(motion: Motion, now = performance.now()) {
    this.motion = motion;
    this.started = now;
  }
  present(value: unknown, id = this.requestId, now = performance.now()) {
    if (id !== this.requestId) return;
    const p = presentationSchema.safeParse(value);
    if (!p.success) return;
    if (p.data.expression) this.expression = p.data.expression;
    if (p.data.motion) this.play(p.data.motion, now);
    if (this.expression !== 'neutral') this.previewMouth = null;
  }
  text(id: string, now = performance.now()) {
    if (id !== this.requestId) return;
    this.lastText = now;
    this.setActivity('speaking', now);
  }
  finish(id: string, completed = false) {
    if (id !== this.requestId) return;
    this.requestId = null;
    this.previewMouth = null;
    this.lastText = 0;
    this.activity = 'idle';
    if (!completed || this.motion !== 'bounce') this.play('idle');
  }
  cancelMotion() {
    this.previewMouth = null;
    this.lastText = 0;
    this.play('idle');
  }
  pose(now: number, visible = true) {
    const elapsed = now - this.started;
    if (this.motion === 'bounce' && elapsed >= 600) this.play('idle', now);
    const still = this.reduced || !visible;
    const wave = still ? 0 : Math.sin(now / 650);
    let y = 0,
      scale = 1,
      rotation = 0;
    if (!still) {
      if (this.motion === 'bounce') {
        y = -18 * Math.sin(Math.PI * Math.min(1, elapsed / 600));
        scale = 1 + 0.018 * Math.sin((elapsed / 600) * Math.PI * 2);
      } else if (this.motion === 'think') {
        y = wave * 1.2;
        rotation = Math.sin(now / 1700) * 0.025;
      } else if (this.motion === 'talk') {
        y = wave * 1.5;
        scale = 1 + wave * 0.003;
      } else {
        scale = 1 + Math.sin(now / 650) * 0.004;
      }
    }
    const activeMouth =
      !this.audioDriven &&
      !still &&
      this.expression === 'neutral' &&
      this.mouthEnabled &&
      this.activity === 'speaking' &&
      now - this.lastText < 600;
    const mouth =
      this.expression === 'neutral' && !still
        ? (this.previewMouth ??
          (this.audioLevel !== null && this.mouthEnabled
            ? this.audioLevel > 0.065
              ? 'open_big'
              : this.audioLevel > 0.012
                ? 'open_small'
                : 'closed'
            : null) ??
          (activeMouth
            ? (['closed', 'open_small', 'open_big', 'open_small'] as const)[
                Math.floor(now / 180) % 4
              ]
            : null))
        : null;
    return { y, scale, rotation, mouth };
  }
}
