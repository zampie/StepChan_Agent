// 角色合成：直接读 rig.json / logo.json，用绝对定位叠图层。
//
// 几何规则必须和运行时渲染器一致，否则海报不代表实际观感：
//   · 覆盖层的 x/y 偏移      ← rig.json layers[*]（像素 diff 算出来的配准）
//   · 覆盖层只在 idle 和程序化动作上成立 ← RigRenderer.layersActive()
//   · FX 边长 = 画布高 × 0.22、锚点居中 ← RigRenderer 的 FX_SIZE / FX_SPAWN
//   · 歪头 12.6°（0.22 rad）  ← PROCEDURAL_POSE.tilt.rotation
//   · logo 位置逐姿势实测      ← logo.json placements（含 rotation 与"看不见"的降级项）
export const FX_SIZE = 0.22;
export const FX_SPAWN = {
  sparkle: [0.26, 0.84], sweat: [0.22, 0.78], zzz: [0.24, 0.92],
  heart: [-0.24, 0.86], exclaim: [0.2, 0.94], question: [0.22, 0.94], note: [-0.26, 0.82],
};
export const TILT_DEG = (0.22 * 180) / Math.PI;
const LAYERS_ACTIVE = new Set(['idle', 'tilt']);

export async function loadRig(base) {
  const [rig, logo] = await Promise.all([
    fetch(`${base}/rig.json`).then((r) => r.json()),
    fetch(`${base}/logo.json`).then((r) => r.json()),
  ]);
  return { rig, logo, base };
}

/** 把一帧角色渲染进 host（host 必须是 position:relative、尺寸 = size×size）。 */
export function renderFrame({ rig, logo, base }, host, state) {
  const {
    expr = 'neutral', action = 'idle', fx = null,
    rotate = 0, squash = 1, dy = 0,
    // 直接指定图层组合（{eyes, brow, mouth, blush}），绕过 rig.json 的预设。
    // 预设只有 11 个固定组合，而图层系统本身支持任意组合 —— 表情包需要
    // 「睁眼 + 笑嘴」这种预设里没有的搭配才能做出正常的眨眼。
    layers = null,
  } = state;
  const S = rig.canvas.width; // 512
  host.innerHTML = '';
  const stage = document.createElement('div');
  stage.className = 'rig-stage';
  // 呼吸/落地回弹就是沿 y 压扁，锚点在脚底 —— 和渲染器同一种做法。
  // dy 是整体上下位移（rig 单位，负值向上），表情包的弹跳用它。
  stage.style.transform =
    `translateY(${(dy / S) * 100}%) rotate(${rotate}deg) scaleY(${squash})`;
  host.appendChild(stage);

  const add = (file, x, y, w, h, extra = '') => {
    const img = document.createElement('img');
    img.src = `${base}/${file}`;
    img.style.cssText =
      `position:absolute;left:${(x / S) * 100}%;top:${(y / S) * 100}%;` +
      `width:${(w / S) * 100}%;height:${(h / S) * 100}%;${extra}`;
    stage.appendChild(img);
    return img;
  };

  const act = rig.actions[action];
  add(act.file, 0, 0, S, S);

  if (LAYERS_ACTIVE.has(action) && (layers || expr)) {
    const e = layers ?? rig.expressions[expr];
    if (!layers && e.mode === 'sprite') {
      add(e.sprite.file, 0, 0, S, S);
    } else {
      for (const grp of ['eyes', 'brow', 'mouth']) {
        const name = e[grp] ?? (grp === 'eyes' ? 'open' : grp === 'brow' ? 'neutral' : 'closed');
        const m = rig.layers[grp][name];
        if (m.width > 1) add(m.file, m.x, m.y, m.width, m.height);
      }
      if (e.blush) add('rig/blush.png', 0, 0, S, S);
    }
  }

  // logo：盖上清晰素材。位置是逐姿势实测的，没有记录的（被遮住）就不贴。
  const place = logo.placements[action] || logo.placements.idle;
  for (const slot of ['hair', 'chest']) {
    const p = place?.[slot];
    if (!p) continue;
    add(logo.asset.file, p.cx - p.size / 2, p.cy - p.size / 2, p.size, p.size,
        `transform:rotate(${(p.rotation * 180) / Math.PI}deg);`);
  }

  if (fx) {
    const side = S * FX_SIZE;
    const [sx, sy] = FX_SPAWN[fx];
    add(rig.fx[fx].file, S / 2 + sx * S - side / 2, S - sy * S - side / 2, side, side);
  }
}
