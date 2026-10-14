"""Step酱 Q 版角色的规范描述。

颜色取自 assets/blue_pet_assets_v0_2/expressions/neutral.png 的实际像素采样，
不是凭记忆写的：hair #CEEBFC、teal #14B6C5、skin #FDEEE5。

这个文件是所有生成 prompt 的单一来源。改角色设定只改这里。
"""

# 必须逐项保留的角色特征。任何变体 prompt 都会带上这段。
IDENTITY = (
    "very long pale ice-blue hair (#CEEBFC) reaching below the waist, "
    "with ONE single upright curved ahoge (a thin cowlick strand) sticking up from the top of the head, "
    "straight blunt bangs; "
    "one black rounded-square hair clip on her right side of the head bearing a small white square logo, "
    "with two short white-and-teal ribbon tails hanging from it; "
    "white long-sleeved sailor-collar school top, the sailor collar trimmed in teal (#14B6C5), "
    "a teal neckerchief knotted at the chest, white cuffs with teal bands; "
    "a small black rounded badge with a white square logo on her chest; "
    "teal (#14B6C5) pleated skirt with a white horizontal stripe near the hem; "
    "white over-the-knee socks with teal bands at the top; dark brown loafers; "
    "fair skin (#FDEEE5), soft pink cheek blush, large round eyes"
)

STYLE = (
    "clean flat cel-shaded anime illustration, crisp dark outline, simple soft shading, "
    "bright saturated colors, sticker-like and highly readable at small size"
)

# 透明背景只对单主体可抠图的 prompt 有意义（gpt-image-lab findings 第 1 节第 4 条）。
CUTOUT = (
    "Single character only, nothing else in frame. No background, no ground shadow, "
    "no text, no watermark, no border, no frame, no checkerboard pattern."
)

BASE_POSE = (
    "standing straight, front-facing, facing the viewer, perfectly centered in frame, "
    "feet near the bottom edge, symmetrical, arms relaxed hanging at her sides, "
    "neutral calm friendly expression, mouth closed, eyes open looking at the viewer"
)


def master_prompt(head_ratio: str, extra_style: str = "") -> str:
    """主形象 prompt。head_ratio 用自然语言描述头身比。"""
    style = f"{STYLE}, {extra_style}" if extra_style else STYLE
    return (
        f"Full-body chibi (Q-version) anime mascot girl, {head_ratio}, "
        f"tiny simplified hands, short stubby legs. "
        f"{BASE_POSE}. "
        f"Character design, must match exactly: {IDENTITY}. "
        f"Style: {style}. "
        f"{CUTOUT}"
    )


# 候选只变头身比和线条风格，姿势/朝向/构图保持一致 —— master 必须是中性基础姿势，
# 动作变体后面从 master 派生，所以候选之间不能换姿势。
CANDIDATES = {
    "q-a": master_prompt("head is about 40% of total body height"),
    "q-b": master_prompt("head is about 45% of total body height, very chibi proportions"),
    "q-c": master_prompt("head is about 35% of total body height, slightly taller proportions"),
    "q-d": master_prompt(
        "head is about 40% of total body height", "bold thick uniform outline, poster-like"
    ),
    "q-e": master_prompt(
        "head is about 40% of total body height", "soft rounded shapes, gentle pastel rendering"
    ),
    "q-f": master_prompt(
        "head is about 42% of total body height", "glossy highlights in the hair, slight gradient shading"
    ),
}


# ---------------------------------------------------------------------------
# 变体 prompt
# ---------------------------------------------------------------------------
# /images/edits 会忽略 background=transparent，返回 RGB 且模型可能把透明格子
# 直接画进画面（实测见 gpt-image-lab/out/spike/spike-blink.png）。
# 唯一验证可行的办法：输入先压平到纯品红，并在 prompt 里反复要求背景保持纯品红，
# 产物本地做 chroma key。实测 76.4% 品红、仅 0.35% 中间色光晕。
MAGENTA = (255, 0, 255)

BG_LOCK = (
    "The background MUST stay a single solid pure magenta #FF00FF fill, exactly as in the input image. "
    "背景保持纯品红色 #FF00FF 纯色填充，不要画格子、不要阴影、不要渐变。"
    "No checkerboard, no transparency pattern, no drop shadow, no gradient, no vignette, "
    "no ground shadow under the character, no text, no watermark, no border."
)

# 局部改动用。强调「除了指定处什么都别动」—— 配准完全依赖这一点。
KEEP_ALL = (
    "This is a character sprite sheet frame. Keep EVERYTHING identical to the input image: "
    "the exact same character, same hairstyle and ahoge, same clothes and colors, same line art style, "
    "same pose, same body position, same scale, same framing, same canvas margins. "
    "Do NOT move, rotate, rescale, re-center or redraw the body, hair, arms, legs or clothes. "
    "Change ONLY what is described next, and nothing else."
)

# 换姿势用。身体必须重画，但角色设定与画幅约定要守住。
KEEP_IDENTITY = (
    "Redraw the SAME chibi character in a new pose. "
    "Keep the exact same character design, the same art style, the same line weight and the same colors as the input image. "
    "Full body must be fully visible inside the frame, horizontally centered, "
    "with the lowest part of the body near the bottom edge and a small empty margin on every side. "
    "Same apparent body size as the input."
)


def _local_edit(change: str) -> str:
    return f"{KEEP_ALL} {change} {BG_LOCK}"


def _pose_edit(pose: str) -> str:
    return f"{KEEP_IDENTITY} New pose: {pose} {BG_LOCK}"


# 眼睛：'open' 就是 master 自己，不生成。
EYE_EDITS = {
    "half": _local_edit(
        "Redraw ONLY her eyes as half-lidded: the upper eyelid covers the top half of each iris, "
        "lashes lowered, a relaxed sleepy look. Keep the eyes in exactly the same place and the same width."
    ),
    "closed": _local_edit(
        "Redraw ONLY her eyes as fully closed: replace each eye with a single smooth downward-curving "
        "closed eyelid line with short lashes, as in a blink frame. "
        "Keep them in exactly the same place and the same width as the open eyes."
    ),
    "smile": _local_edit(
        "Redraw ONLY her eyes as happy closed smiling eyes: each eye becomes an upward curving arc "
        "(a ^ shape) with short lashes. Keep them in exactly the same place and the same width."
    ),
    "sparkle": _local_edit(
        "Redraw ONLY her eyes as excited sparkling eyes: keep the same eye shape and position but put a "
        "large bright four-pointed star highlight in each pupil plus extra white glints, "
        "making them look glittering and thrilled."
    ),
    "wide": _local_edit(
        "Redraw ONLY her eyes as wide open and startled: the iris becomes a smaller circle with clearly "
        "more white sclera visible all around it, eyelids pulled back. "
        "Keep the eye outline in the same place and the same width."
    ),
}

# 口型：'closed' 就是 master 自己，不生成。
MOUTH_EDITS = {
    "small": _local_edit(
        "Redraw ONLY her mouth as slightly open: a small narrow oval opening, as if softly starting to speak. "
        "Keep it in exactly the same place on her face and the same width."
    ),
    "medium": _local_edit(
        "Redraw ONLY her mouth as half open: a medium rounded opening showing a little of the dark inside, "
        "as if mid-sentence. Keep it in exactly the same place on her face."
    ),
    "wide": _local_edit(
        "Redraw ONLY her mouth as wide open saying 'ah': a large rounded opening with the dark inside of the "
        "mouth visible. Keep it centred in exactly the same place on her face."
    ),
    "round": _local_edit(
        # 第一版 prompt 说的是「small perfectly round 'o'」，模型几乎没动嘴
        # （实测 diffRatio 0.00061，低于 0.0008 的下限被判死）。
        # 原因大概是 master 的闭嘴本来就是一条小弧线，「small」给了模型不改的借口。
        "Redraw ONLY her mouth as a clearly open, perfectly round letter-'O' shape, as if saying 'ooh' — "
        "a bold circular opening with a dark mouth interior and a thick dark outline, "
        "clearly larger and rounder than the thin closed smile line it replaces. "
        "Keep it in exactly the same place on her face."
    ),
    "smile": _local_edit(
        "Redraw ONLY her mouth as a wide happy open smile with the corners curving up. "
        "Keep it in exactly the same place on her face."
    ),
}

# 眉毛：'neutral' 就是 master 自己，不生成。
# 注意 master 的眉毛基本被刘海遮住，这几个变体很可能 diff 极小 → 由 register.py 用数据判定降级。
BROW_EDITS = {
    "raised": _local_edit(
        "Redraw ONLY her eyebrows: draw two thin eyebrows raised high, clearly visible above the eyes "
        "and above the bangs' lower edge, giving a surprised curious look. Do not change the eyes."
    ),
    "furrowed": _local_edit(
        "Redraw ONLY her eyebrows: draw two thin eyebrows slanting down towards the nose in an angry frown, "
        "clearly visible above the eyes. Do not change the eyes."
    ),
    "worried": _local_edit(
        "Redraw ONLY her eyebrows: draw two thin eyebrows with the inner ends raised and the outer ends "
        "drooping, a worried upset look, clearly visible above the eyes. Do not change the eyes."
    ),
}

BLUSH_EDIT = _local_edit(
    "Redraw ONLY her cheeks: make the pink cheek blush much stronger and larger — two wide warm pink "
    "blush patches with a few small diagonal blush lines, a bashful flustered look. "
    "Do not change her eyes, eyebrows or mouth."
)

# 整脸表情。只给「分层组合表达不出来」的那几个留后路：
# shy 需要强腮红、angry 需要怒气符号、sad 需要眼泪、excited 需要全脸张力。
# 其余表情由 layers 组合，不白烧额度。
EXPRESSION_EDITS = {
    "shy": _local_edit(
        "Change ONLY her face: a bashful shy expression — eyes looking away and half-lidded, "
        "a tiny wavy embarrassed mouth, and large strong pink blush patches on both cheeks."
    ),
    "angry": _local_edit(
        "Change ONLY her face: an angry pouting expression — eyebrows slanted down towards the nose, "
        "eyes narrowed, a small frowning mouth, and a small cartoon anger cross-popping-vein mark "
        "on her forehead near the temple."
    ),
    "sad": _local_edit(
        "Change ONLY her face: a sad about-to-cry expression — eyebrows with inner ends raised, "
        "eyes glistening with big tears welling up, one small teardrop at the outer corner of each eye, "
        "and a small wavy downturned mouth."
    ),
    "excited": _local_edit(
        "Change ONLY her face: a thrilled excited expression — eyes wide with big four-pointed star "
        "sparkle highlights in the pupils, eyebrows raised high, and a big wide open happy smile."
    ),
}

# 整身动作。'idle' 就是 master 自己，不生成。
ACTION_EDITS = {
    "wave": _pose_edit(
        "she stands facing the viewer and raises one arm up beside her head, hand open with fingers spread, "
        "waving hello; the other arm stays relaxed at her side; a cheerful open smile; both feet on the ground."
    ),
    "sit": _pose_edit(
        "she is sitting on the ground facing the viewer, legs folded to one side, both hands resting on the "
        "ground beside her hips, relaxed calm smile; her skirt spreads on the ground; "
        "the whole sitting figure is centred with her hips and legs near the bottom edge."
    ),
    "sleep": _pose_edit(
        "she is curled up asleep on her side on the ground, facing the viewer, knees drawn up, "
        "both hands tucked under her cheek, eyes peacefully closed with closed-eyelid lines, mouth slightly open; "
        "her long hair spreads out behind her; the lying figure fills the frame horizontally."
    ),
    # point / hold / tilt 的第一版 prompt 全部失败：模型根本没动肢体，产物和 idle 肉眼无法区分
    # （剪影异或 1%–18%，但那点差异全来自头发重绘，不是姿势）。
    # 改成「逐肢体点名 + 给角度/距离 + 显式否定原姿势」，并且中英各写一遍。
    "point": _pose_edit(
        "她的右手臂必须明显抬起并向前伸出，手肘伸直，食指指向观众，手掌离开身体至少一个头的距离；"
        "左手叉在腰上，手肘向外弯。不要让两条手臂都垂在身侧。"
        "Her right arm MUST be clearly raised and fully extended forward toward the viewer, elbow straight, "
        "index finger pointing at the viewer, the hand held far away from her body — "
        "the arm silhouette must be clearly separated from the torso with visible empty background between them. "
        "Her left hand rests on her hip with the elbow bent outward. "
        "DO NOT leave both arms hanging down at her sides — that is the pose we are replacing. "
        "Confident explaining expression, mouth slightly open as if speaking; both feet on the ground."
    ),
    "hold": _pose_edit(
        "她的两条手臂必须明显抬到胸前，两个手肘弯曲约 90 度，小臂水平，双手手掌向上张开并拢，"
        "像在捧着一件看不见的小东西；两条小臂明显压在躯干前面。不要让任何一条手臂垂在身侧。"
        "Both of her arms MUST be clearly raised in front of her chest with both elbows bent about 90 degrees, "
        "both forearms horizontal and clearly overlapping her chest, "
        "both palms open and turned upward, cupped together as if offering an invisible small object. "
        "DO NOT leave either arm hanging down at her side — that is the pose we are replacing. "
        "A gentle helpful smile; both feet on the ground."
    ),
    "jump": _pose_edit(
        "she is jumping joyfully, both arms stretched up above her head, both feet off the ground with knees "
        "bent and toes pointing down, hair and skirt flying upward, eyes happy closed arcs and a big open smile."
    ),
    "tilt": _pose_edit(
        # 第二版（"头向左肩倾斜 25 度" + 中英双写）仍然失败，模型把头画得笔直。
        # 第三版换描述框架：不说「怎么改」，直接说「成品长什么样」，并用呆毛的朝向当硬指标。
        "整个人是一个「歪头」的 Q 版姿势：头和脖子一起向画面左侧倾倒，"
        "头顶的呆毛不再竖直向上，而是明显斜指向左上方约 45 度；"
        "两只眼睛连成的线是斜的，左眼明显比右眼低；下巴偏向左肩。"
        "The finished drawing is a classic chibi HEAD-TILT pose, as if the whole head has rotated "
        "anticlockwise by 25-30 degrees around the neck. "
        "Hard requirement: the ahoge strand on top of her head must point diagonally up-left at roughly "
        "45 degrees from vertical, NOT straight up. "
        "The line through her two eyes must be visibly slanted, not horizontal — one eye clearly lower than the other. "
        "Her chin points toward her left shoulder. Her shoulders and hips stay level and front-facing. "
        "A curious questioning look, one eyebrow raised, mouth a small puzzled line; "
        "both arms relaxed at her sides, both feet on the ground."
    ),
    "walk_a": _pose_edit(
        "she is walking towards the viewer's left in profile-three-quarter view: her near leg is forward with the "
        "heel down and her far leg is back, the opposite arm swung forward; a happy walking smile; "
        "her hair swings slightly behind her."
    ),
    "walk_b": _pose_edit(
        "she is walking towards the viewer's left in profile-three-quarter view, the opposite step of a walk cycle: "
        "her near leg is back and her far leg is forward with the heel down, the arms swung the other way; "
        "a happy walking smile; her hair swings slightly behind her."
    ),
}

# 特效本该走 /images/generations + background=transparent 拿真 alpha。
# 实测这条路在本次运行中不可用：该 key 的 /images/generations 持续返回 400（偶发 403），
# 连 gpt-image-lab README 里原样的 leaf prompt 也 400，而同一 key 的 /images/edits 27/27 全成。
# 所以特效也走 edits：输入一张纯品红空画布，让模型在上面画符号，产物本地抠像。
# 代价是拿不到模型自己的 alpha，但品红抠像实测光晕只有 0.35%，对单主体符号完全够用。
FX_BLANK_PREFIX = (
    "The input image is a blank solid pure magenta #FF00FF canvas. "
    "Draw the following single object large in the center of the canvas, filling most of the frame. "
)

FX_STYLE = (
    "Flat cel-shaded anime effect icon, thick crisp dark outline, bright saturated colors, "
    "simple sticker-like shape, highly readable at small size, centered in frame, large and filling the frame. "
    + CUTOUT
)

_FX_SUBJECTS = {
    "sparkle": "A cluster of three four-pointed anime sparkle stars of different sizes, bright warm yellow with white centers and a soft glow.",
    "sweat": "One single large glossy anime sweat drop, a pale blue teardrop shape with a white highlight, pointed end up.",
    "zzz": "The three capital letters Z Z Z arranged in a rising diagonal row, getting bigger towards the top right, drawn as bold rounded cartoon sleep letters in white with a thick dark outline.",
    "heart": "One single glossy cartoon heart, warm pink with a white highlight.",
    "exclaim": "One single bold cartoon exclamation mark, bright warm yellow with a thick dark outline.",
    "question": "One single bold cartoon question mark, bright teal #14B6C5 with a thick dark outline.",
    "note": "One single bold cartoon eighth music note with a flag, teal #14B6C5 with a thick dark outline.",
}

# 走 generations 时用（如果额度恢复了）。
FX_PROMPTS = {k: f"{v} {FX_STYLE}" for k, v in _FX_SUBJECTS.items()}
# 走 edits + 空品红画布时用。
FX_BLANK_PROMPTS = {
    k: f"{FX_BLANK_PREFIX}{v} {FX_STYLE} {BG_LOCK}" for k, v in _FX_SUBJECTS.items()
}


# ---------------------------------------------------------------------------
# 作业表：label -> (kind, prompt)
# kind 决定调用哪个接口、以及后处理走 chroma key 还是直接用 alpha。
#   edit       —— /images/edits，输入 master 压平的品红图，产物抠像
#   edit_blank —— /images/edits，输入纯品红空画布，产物抠像
#   gen        —— /images/generations + background=transparent，产物直接有 alpha
# ---------------------------------------------------------------------------
def variant_jobs(fx_mode: str = "edit_blank") -> dict[str, tuple[str, str]]:
    jobs: dict[str, tuple[str, str]] = {}
    for name, prompt in EYE_EDITS.items():
        jobs[f"eyes-{name}"] = ("edit", prompt)
    for name, prompt in MOUTH_EDITS.items():
        jobs[f"mouth-{name}"] = ("edit", prompt)
    for name, prompt in BROW_EDITS.items():
        jobs[f"brow-{name}"] = ("edit", prompt)
    jobs["blush-on"] = ("edit", BLUSH_EDIT)
    for name, prompt in EXPRESSION_EDITS.items():
        jobs[f"face-{name}"] = ("edit", prompt)
    for name, prompt in ACTION_EDITS.items():
        jobs[f"action-{name}"] = ("edit", prompt)
    source = FX_PROMPTS if fx_mode == "gen" else FX_BLANK_PROMPTS
    for name, prompt in source.items():
        jobs[f"fx-{name}"] = (fx_mode, prompt)
    return jobs
