"""
封面自动差异化（D8：每条成片封面帧与标题互不相同，系统默认零操作可用）。

差异化三板斧：
1. **选帧不重复**：优先选该成片「独有素材」（其他成片没用到的素材）的中点帧；
   没有独有素材时，在同素材候选帧里选与其他成片封面帧时间差最大的位置。
2. **标题变体**：取脚本首句去标点截 20 字；同一脚本裂变的多片自动加
   「·其一/其二/其三…」后缀（标题本身也是查重差异信号）。
3. **模板轮替**：4 个预设模板（标题位置/配色组合，字段结构与现有 composite
   端点的 cover_style 对齐），成片间轮替。

用户手改过的封面（cover.user_modified=True）重跑 assign 时跳过不覆盖。
"""
from __future__ import annotations

import re
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

# ─── 预设封面模板（字段与 routes/ai_editing.py composite 的 cover_style 对齐）──
COVER_TEMPLATES: list[dict] = [
    {"id": "top_yellow",  "title_color": "#FFE135", "sub_color": "#FFFFFF", "title_y": 18, "sub_y": 32},
    {"id": "center_white", "title_color": "#FFFFFF", "sub_color": "#DDDDDD", "title_y": 42, "sub_y": 56},
    {"id": "bottom_cyan", "title_color": "#3EE6FF", "sub_color": "#FFFFFF", "title_y": 72, "sub_y": 84},
    {"id": "top_bar",     "title_color": "#FFFFFF", "sub_color": "#FFE135", "title_y": 10, "sub_y": 24},
]

# 裂变标题变体后缀（·其一/其二…）；超过 8 片退化为「·其N」
_CN_ORDINALS = ["其一", "其二", "其三", "其四", "其五", "其六", "其七", "其八"]

# 标题清洗：去掉标点/空白，只保留文字与数字（标题要做文件名，顺便满足 O5 安全字符）
# 用 re.escape 构造字符类，避免全角/半角引号与反斜杠转义歧义
_PUNCT_CHARS = " \t\n\r，。！？、；：「」『』“”‘’《》〈〉（）【】…—·,.!?;:'\"()[]<>-"
_PUNCT_PAT = re.compile("[" + re.escape(_PUNCT_CHARS) + "]+")
_SENTENCE_SPLIT = re.compile(r"[。！？!?\n]")


def make_title(script_text: str, max_len: int = 20) -> str:
    """从脚本首句生成封面标题：取首句 → 去标点 → 截断 max_len 字。"""
    text = (script_text or "").strip()
    if not text:
        return "未命名"
    first = _SENTENCE_SPLIT.split(text)[0]
    clean = _PUNCT_PAT.sub("", first)
    return (clean or "未命名")[:max_len]


def filename_safe(text: str, max_len: int = 40) -> str:
    """文件名安全字符清洗（O5：Windows 禁字符 + 空白转下划线）。"""
    clean = re.sub(r'[\\/:*?"<>|\r\n\t]+', "", text or "").strip()
    clean = re.sub(r"\s+", "_", clean)
    return (clean or "untitled")[:max_len]


# ─── 主入口 ───────────────────────────────────────────────

def assign_covers(batch: dict, templates: list[dict] | None = None) -> dict:
    """给批次每条成片分配差异化封面，返回 {clip_id: cover}（不直接写批次）。

    Args:
        batch: 批次对象（需含 clips/scripts；clips[].segments 已分配）。
        templates: 可覆盖默认模板列表（测试/自定义用）。

    Returns:
        {clip_id: cover}，cover 结构：
        {video_rel_path, file_hash, time, title, subtitle, template,
         title_color, sub_color, title_y, sub_y, user_modified: False}
    """
    templates = templates or COVER_TEMPLATES
    clips = batch.get("clips", [])
    scripts = {s.get("id"): s for s in batch.get("scripts", [])}

    # 素材 → 使用它的成片集合（找"独有素材"用）
    mat_to_clips: dict[str, set] = {}
    for c in clips:
        for s in c.get("segments", []):
            fh = s.get("file_hash", "")
            if fh:
                mat_to_clips.setdefault(fh, set()).add(c["id"])

    # 每个脚本的成片数（>1 才需要变体后缀）与计数器
    script_total: dict[str, int] = {}
    for c in clips:
        sid = c.get("script_id", "")
        script_total[sid] = script_total.get(sid, 0) + 1
    script_seen: dict[str, int] = {}

    used_frames: dict[str, list] = {}  # file_hash → 已被选作封面的时间点
    out: dict[str, dict] = {}

    for idx, clip in enumerate(clips):
        old_cover = clip.get("cover") or {}
        if old_cover.get("user_modified"):
            continue  # 用户手改的封面绝不覆盖（D8）

        segs = [s for s in clip.get("segments", []) if s.get("file_hash")]
        if not segs:
            continue

        # 1) 选帧：优先独有素材；再选与其他封面时间差最大的中点帧
        unique_segs = [s for s in segs if len(mat_to_clips.get(s["file_hash"], set())) <= 1]
        pool = unique_segs or segs
        best_seg, best_t, best_dist = None, 0.0, -1.0
        for s in pool:
            t = (float(s["in"]) + float(s["out"])) / 2.0
            d = min((abs(t - u) for u in used_frames.get(s["file_hash"], [])), default=999.0)
            if d > best_dist:
                best_seg, best_t, best_dist = s, t, d
        used_frames.setdefault(best_seg["file_hash"], []).append(best_t)

        # 2) 标题：脚本首句 + 裂变变体后缀
        sid = clip.get("script_id", "")
        base = make_title((scripts.get(sid) or {}).get("text", ""))
        script_seen[sid] = script_seen.get(sid, 0) + 1
        n = script_seen[sid]
        if script_total.get(sid, 0) > 1:
            suffix = _CN_ORDINALS[n - 1] if n <= len(_CN_ORDINALS) else f"其{n}"
            title = f"{base}·{suffix}"
        else:
            title = base

        # 3) 模板轮替
        tpl = templates[idx % len(templates)]
        out[clip["id"]] = {
            "video_rel_path": best_seg.get("video_rel_path", ""),
            "file_hash": best_seg["file_hash"],
            "time": round(best_t, 3),
            "title": title,
            "subtitle": "",
            "template": tpl["id"],
            "title_color": tpl["title_color"],
            "sub_color": tpl["sub_color"],
            "title_y": tpl["title_y"],
            "sub_y": tpl["sub_y"],
            "user_modified": False,
        }
    return out


# ─── 单元自测 ─────────────────────────────────────────────

if __name__ == "__main__":
    print("=== cover_differ 自测 ===")

    def seg(fh, i, o, rel=""):
        return {"file_hash": fh, "video_rel_path": rel or f"mat/{fh}.mp4", "in": i, "out": o, "duration": o - i}

    # 8 片：s1 裂变 3 片 + s2 裂变 3 片 + s3/s4 各 1 片；素材 m1 被 c1/c2 共用
    scripts = [
        {"id": "s1", "text": "这个产品真的太好用了！你一定要试试。"},
        {"id": "s2", "text": "今天教大家三个省钱技巧，记得收藏。"},
        {"id": "s3", "text": "全球 news 速报。"},
        {"id": "s4", "text": ""},
    ]
    clips = [
        {"id": "c1", "script_id": "s1", "segments": [seg("m1", 1, 3), seg("m2", 0, 2)]},
        {"id": "c2", "script_id": "s1", "segments": [seg("m1", 4, 6), seg("m3", 0, 2)]},
        {"id": "c3", "script_id": "s1", "segments": [seg("m4", 2, 4)]},
        {"id": "c4", "script_id": "s2", "segments": [seg("m5", 1, 3)]},
        {"id": "c5", "script_id": "s2", "segments": [seg("m6", 1, 3)]},
        {"id": "c6", "script_id": "s2", "segments": [seg("m7", 1, 3)]},
        {"id": "c7", "script_id": "s3", "segments": [seg("m8", 1, 3)]},
        {"id": "c8", "script_id": "s4", "segments": [seg("m9", 1, 3)]},
    ]
    batch = {"clips": clips, "scripts": scripts}
    covers = assign_covers(batch)

    # 1) 8 片全部有封面，帧 (素材,时间) 两两不同
    assert len(covers) == 8
    frames = [(cv["file_hash"], cv["time"]) for cv in covers.values()]
    assert len(set(frames)) == 8, f"封面帧应两两不同: {frames}"
    # 2) 裂变片标题带变体后缀且互不相同；单片脚本无后缀
    t_s1 = [covers[c]["title"] for c in ("c1", "c2", "c3")]
    assert t_s1 == ["这个产品真的太好用了·其一", "这个产品真的太好用了·其二", "这个产品真的太好用了·其三"], t_s1
    assert covers["c7"]["title"] == "全球news速报"  # 标点清洗，无后缀
    assert covers["c8"]["title"] == "未命名"
    # 3) 模板轮替：相邻片不同模板，4 片一轮
    tpls = [covers[c["id"]]["template"] for c in clips]
    assert tpls == ["top_yellow", "center_white", "bottom_cyan", "top_bar"] * 2, tpls
    print(f"[OK] 8 片分配: 帧两两不同，裂变标题 {t_s1[:2]}...，模板轮替 {tpls[:4]}")

    # 4) user_modified 不被覆盖
    clips[0]["cover"] = {"title": "手工标题", "user_modified": True}
    covers2 = assign_covers(batch)
    assert "c1" not in covers2, "user_modified 封面应跳过"
    assert len(covers2) == 7
    print("[OK] user_modified 封面跳过不覆盖")

    # 5) 时间差最大化：同素材被两片共用（m1 in c1/c2），第二次选帧应避开第一次的时间
    #    c1 用 m1 中点 t=2.0；c2 若落到 m1 应选 t=5.0（段 [4,6] 中点）——验证不同即可
    assert covers["c1"]["time"] != covers["c2"]["time"] or covers["c1"]["file_hash"] != covers["c2"]["file_hash"]
    print("[OK] 共用素材封面帧时间错开")

    print("=== 全部自测通过 ===")
