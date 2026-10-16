#!/usr/bin/env python3
"""从 rig.json 生成 README 配图（docs/images/）。

用法：python3 tools/art/readme-images.py
依赖：Pillow、ffmpeg（只用来装 GIF）、macOS 自带的 Hiragino Sans GB 字体。

从 rig.json 生成 README 配图（PIL 合成 + 中文标注，ffmpeg 只负责装 GIF）。

**刻意不截屏。** 桌宠窗是透明置顶的，真机截屏会把用户当时的桌面内容一起拍进去，
并永久留在公开仓库里。所以全部用仓库自己的素材合成，几何参数一律照抄
rig.json 与 RigRenderer：
  · 表情层的 x/y 偏移      ← rig.json layers[*].x/y（配准是像素 diff 算出来的）
  · FX 边长 = 画布高 × 0.22 ← RigRenderer 的 FX_SIZE
  · FX 落点                ← RigRenderer 的 FX_SPAWN（锚点居中）
  · 歪头 12.6°             ← PROCEDURAL_POSE.tilt.rotation = 0.22 rad
这样图里看到的叠法/大小/落点和运行时渲染器完全一致。

唯一做不到的是程序化动画本身（呼吸、随机眨眼、挤压拉伸、RMS 驱动的口型）。
GIF 里的呼吸/眨眼/歪头是按渲染器的同样手法逐帧重演的，不是录屏 —— README 里如实写明。
"""
import json, math, subprocess, tempfile
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]      # tools/art/ → 仓库根
ART = ROOT / 'assets/stepchan_q_v1'
OUT = ROOT / 'docs/images'
TMP = Path(tempfile.mkdtemp(prefix='stepchan-readme-'))
RIG = json.load(open(ART / 'rig.json'))
OUT.mkdir(parents=True, exist_ok=True)

FONT = '/System/Library/Fonts/Hiragino Sans GB.ttc'
F_LABEL = ImageFont.truetype(FONT, 26)
F_KEY = ImageFont.truetype(FONT, 19)

FX_SIZE = 0.22
FX_SPAWN = {'sparkle': (0.26, 0.84), 'sweat': (0.22, 0.78), 'zzz': (0.24, 0.92),
            'heart': (-0.24, 0.86), 'exclaim': (0.2, 0.94), 'question': (0.22, 0.94),
            'note': (-0.26, 0.82)}
TILT_DEG = 0.22 * 180 / 3.141592653589793   # PROCEDURAL_POSE.tilt.rotation

_cache = {}
def load(rel):
    if rel not in _cache:
        _cache[rel] = Image.open(ART / rel).convert('RGBA')
    return _cache[rel]

# 覆盖层只在 idle 和程序化动作上成立 —— 其余姿势是整身图、自带脸，再叠
# 表情层就会出现「眼睛飘在头顶」。照抄 RigRenderer.layersActive()：
#   action === 'idle' || proceduralActions.has(action)
# 这个 bug 在应用里真实发生过（睡觉姿势的眼睛贴图位置不对），配图不该再犯一次。
LAYERS_ACTIVE = {'idle', 'tilt'}

def frame(expr=None, action='idle', fx=None, rotate=0.0, squash=1.0):
    """合成一帧 512×512 RGBA。"""
    im = load(RIG['actions'][action]['file']).copy()
    if action not in LAYERS_ACTIVE:
        expr = None
    if expr:
        e = RIG['expressions'][expr]
        if e['mode'] == 'sprite':
            im = Image.alpha_composite(im, load(e['sprite']['file']))
        else:
            for grp in ('eyes', 'brow', 'mouth'):
                m = RIG['layers'][grp][e[grp]]
                if m['width'] <= 1:        # 1×1 占位 = 该组就是底图状态
                    continue
                patch = load(m['file'])
                over = Image.new('RGBA', im.size, (0, 0, 0, 0))
                over.paste(patch, (m['x'], m['y']))
                im = Image.alpha_composite(im, over)
            if e.get('blush'):
                im = Image.alpha_composite(im, load('rig/blush.png'))
    if rotate:
        im = im.rotate(-rotate, resample=Image.BICUBIC, expand=False)
    if squash != 1.0:
        h = int(512 * squash)
        sq = im.resize((512, h), Image.LANCZOS)
        im = Image.new('RGBA', (512, 512), (0, 0, 0, 0))
        im.paste(sq, (0, 512 - h))
    if fx:
        side = round(512 * FX_SIZE)
        cx, cy = 256 + FX_SPAWN[fx][0] * 512, 512 - FX_SPAWN[fx][1] * 512
        art = load(RIG['fx'][fx]['file']).resize((side, side), Image.LANCZOS)
        over = Image.new('RGBA', im.size, (0, 0, 0, 0))
        over.paste(art, (round(cx - side / 2), round(cy - side / 2)))
        im = Image.alpha_composite(im, over)
    return im

def sheet(items, cols, out, cell=230, gap=14, label_h=58, bg=(255, 255, 255, 0),
          label_color=(90, 100, 115, 255)):
    """items: [(图, 中文名, rig 键)]。标注画在每格下方。"""
    rows = (len(items) + cols - 1) // cols
    W = cols * cell + (cols + 1) * gap
    H = rows * (cell + label_h) + (rows + 1) * gap
    canvas = Image.new('RGBA', (W, H), bg)
    d = ImageDraw.Draw(canvas)
    for i, (im, name, key) in enumerate(items):
        r, c = divmod(i, cols)
        x = gap + c * (cell + gap)
        y = gap + r * (cell + label_h + gap)
        canvas.paste(im.resize((cell, cell), Image.LANCZOS), (x, y), im.resize((cell, cell), Image.LANCZOS))
        for text, font, dy in ((name, F_LABEL, 4), (key, F_KEY, 32)):
            w = d.textlength(text, font=font)
            d.text((x + (cell - w) / 2, y + cell + dy), text, font=font,
                   fill=label_color if dy == 4 else (150, 158, 172, 255))
    canvas.save(out)
    return out

EXPRS = [('neutral', '平静'), ('happy', '开心'), ('excited', '兴奋'), ('curious', '好奇'),
         ('confused', '困惑'), ('surprised', '惊讶'), ('proud', '得意'), ('shy', '害羞'),
         ('sleepy', '困倦'), ('angry', '生气'), ('sad', '难过')]
ACTS = [('idle', '待机', 0), ('wave', '挥手', 0), ('point', '指', 0), ('hold', '捧', 0),
        ('jump', '跳', 0), ('sit', '坐', 0), ('walk_a', '走 A', 0), ('walk_b', '走 B', 0),
        ('tilt', '歪头', TILT_DEG), ('sleep', '睡觉', 0)]
FXS = [('sparkle', '闪光'), ('heart', '爱心'), ('note', '音符'), ('exclaim', '惊叹'),
       ('question', '疑问'), ('sweat', '汗'), ('zzz', '呼呼')]

if __name__ == '__main__':
    # 1. hero
    frame(expr='happy').resize((440, 440), Image.LANCZOS).save(OUT / 'hero.png')

    # 2. 表情表。sprite 模式的三个在键名后标出来 —— 它们是**降级项**，
    #    分层画不出腮红/怒气符号/眼泪，所以整脸交叉淡入（见 rig.json 的 degraded）。
    items = []
    for key, name in EXPRS:
        mode = RIG['expressions'][key]['mode']
        suffix = f'{key} · 整脸' if mode == 'sprite' else key
        items.append((frame(expr=key), name, suffix))
    sheet(items, 6, OUT / 'expressions.png')

    # 3. 动作表。tilt 没有独立素材，是渲染器对整身图转 12.6°。
    items = []
    for key, name, rot in ACTS:
        suffix = f'{key} · 程序化' if rot else key
        items.append((frame(expr='neutral', action=key, rotate=rot), name, suffix))
    sheet(items, 5, OUT / 'actions.png')

    # 4. FX 表
    items = [(frame(expr='happy', fx=k), n, k) for k, n in FXS]
    sheet(items, 7, OUT / 'fx.png', cell=200, label_h=54)

    # 5. GIF
    seq = TMP / 'gseq'
    seq.mkdir(parents=True, exist_ok=True)
    frames = []
    def push(n=1, **kw):
        im = frame(**kw).resize((340, 340), Image.LANCZOS)
        frames.extend([im] * n)

    # 呼吸（渲染器是正弦缩放）+ 一次连眨
    for t in range(16):
        sq = 1 - 0.014 * (1 - math.cos(t / 16 * 2 * math.pi)) / 2
        e = 'neutral'
        if t in (6, 11):
            e = 'confused'    # eyes-half
        elif t in (7, 8, 12):
            e = 'sleepy'
        push(expr=e, squash=sq)
    # 说话：真机口型由播放音频的 RMS 驱动，这里用几档嘴形示意
    for e in ('happy', 'excited', 'curious', 'excited', 'happy', 'surprised'):
        push(2, expr=e)
    # 被摸头 → 害羞 + 爱心
    push(6, expr='shy', fx='heart')
    # 歪头看你
    for r in (3.2, 7.0, TILT_DEG, TILT_DEG, TILT_DEG, 7.0, 3.2):
        push(expr='curious', rotate=r)
    # 挥手
    push(5, action='wave')
    # 打瞌睡
    push(8, action='sleep', fx='zzz')

    # GIF 只有 1 bit 透明，软边会毛，所以铺一层浅底（深浅主题下都能看）。
    BG = (238, 242, 247, 255)
    for i, im in enumerate(frames):
        flat = Image.new('RGBA', im.size, BG)
        Image.alpha_composite(flat, im).convert('RGB').save(seq / f'{i:03d}.png')
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', '12',
                    '-i', str(seq / '%03d.png'), '-filter_complex',
                    'split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];'
                    '[b][p]paletteuse=dither=bayer:bayer_scale=5',
                    '-loop', '0', str(OUT / 'stepchan.gif')], check=True)
    print(f'生成完毕：{len(frames)} 帧 GIF')
