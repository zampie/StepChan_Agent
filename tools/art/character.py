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
