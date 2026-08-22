"""Caption building: SRT parsing, word grouping, styled karaoke ASS generation.

Ports the ASS style/header from E2E-slice-srt and improves on
E2E-finalize-short's karaoke pass: when real word timestamps are available
(from Whisper), each word is highlighted for its actual spoken duration
instead of an even split of the cue.
"""

import logging
import re
import textwrap
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

DEFAULT_CAPTION_CONFIG = {
    "fontFamily": "Montserrat",
    "fontSize": 92,
    "fontColor": "#FFFFFF",
    "strokeColor": "#000000",
    "strokeWidth": 8,
    "highlightColor": "#FFD400",
    "keywordHighlight": True,
    "keywordColor": "#00E676",
    "position": "bottom",
    "marginBottom": 260,
    "allCaps": True,
    "karaoke": True,
    "wordsPerGroup": 3,
}

# Start a new caption group when the gap between words exceeds this.
GROUP_GAP_MS = 1000


# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------

def _ts_to_ms(h: int, m: int, s: int, ms: int) -> int:
    return ((h * 60 + m) * 60 + s) * 1000 + ms


def _ms_to_srt_ts(ms: int) -> str:
    ms = max(0, int(ms))
    total_s, rem_ms = divmod(ms, 1000)
    total_m, s = divmod(total_s, 60)
    h, m = divmod(total_m, 60)
    return f"{h:02d}:{m:02d}:{s:02d},{rem_ms:03d}"


def _ms_to_ass_ts(ms: int) -> str:
    ms = max(0, int(ms))
    total_cs = ms // 10
    total_s, cs = divmod(total_cs, 100)
    total_m, s = divmod(total_s, 60)
    h, m = divmod(total_m, 60)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def _hex_to_ass_color(css_hex: str) -> str:
    """CSS #RRGGBB (or #RGB) -> ASS &H00BBGGRR (opaque)."""
    h = (css_hex or "#FFFFFF").lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    r, g, b = h[0:2].upper(), h[2:4].upper(), h[4:6].upper()
    return f"&H00{b}{g}{r}"


def _clean_text(text: str) -> str:
    text = re.sub(r"<[^>]+>", "", text or "")
    return re.sub(r"\s+", " ", text).strip()


# ---------------------------------------------------------------------------
# SRT parsing (port of E2E-slice-srt._parse_srt)
# ---------------------------------------------------------------------------

def parse_srt(content: str) -> List[Dict[str, Any]]:
    """Return cues: [{start_ms, end_ms, text}]."""
    cues = []
    content = (content or "").replace("\r\n", "\n").replace("\r", "\n")
    for block in re.split(r"\n\s*\n", content.strip()):
        lines = block.strip().splitlines()
        if not lines:
            continue
        num_line = lines[0].strip()
        if not num_line.isdigit() and len(lines) > 1 and lines[1].strip().isdigit():
            lines = lines[1:]
            num_line = lines[0].strip()
        if not num_line.isdigit() or len(lines) < 2:
            continue
        m = re.match(
            r"(\d+):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d+):(\d{2}):(\d{2})[,.](\d{3})",
            lines[1].strip(),
        )
        if not m:
            continue
        g = [int(x) for x in m.groups()]
        start_ms = _ts_to_ms(g[0], g[1], g[2], g[3])
        end_ms = _ts_to_ms(g[4], g[5], g[6], g[7])
        if end_ms <= start_ms:
            end_ms = start_ms + 1
        text = _clean_text("\n".join(lines[2:]))
        if text:
            cues.append({"start_ms": start_ms, "end_ms": end_ms, "text": text})
    return cues


# ---------------------------------------------------------------------------
# Word handling
# ---------------------------------------------------------------------------

def words_from_chunks(chunks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Convert Whisper chunk output [{text, timestamp: [s, e]}] to word dicts."""
    words = []
    prev_end = 0.0
    for chunk in chunks or []:
        text = _clean_text(str(chunk.get("text", "")))
        if not text:
            continue
        ts = chunk.get("timestamp") or [None, None]
        start = ts[0] if ts[0] is not None else prev_end
        end = ts[1] if len(ts) > 1 and ts[1] is not None else start + 0.3
        prev_end = end
        words.append({
            "text": text,
            "start_ms": int(round(float(start) * 1000)),
            "end_ms": int(round(float(end) * 1000)),
        })
    return words


def cues_from_words(words: List[Dict[str, Any]], words_per_group: int = 3) -> List[Dict[str, Any]]:
    """Group words into short caption cues (TikTok-style N-word groups)."""
    per_group = max(1, int(words_per_group))
    cues = []
    group: List[Dict[str, Any]] = []

    def flush():
        if group:
            cues.append({
                "start_ms": group[0]["start_ms"],
                "end_ms": group[-1]["end_ms"],
                "text": " ".join(w["text"] for w in group),
                "words": list(group),
            })
            group.clear()

    for word in words:
        if group and word["start_ms"] - group[-1]["end_ms"] > GROUP_GAP_MS:
            flush()
        group.append(word)
        if len(group) >= per_group:
            flush()
    flush()
    return cues


def slice_cues(cues: List[Dict[str, Any]], start_s: float, end_s: float) -> List[Dict[str, Any]]:
    """Cues overlapping [start_s, end_s], rebased so the window starts at 0.

    Used to cut a full-video SRT down to one short's window (port of
    E2E-slice-srt, but driven by the clip's exact boundaries).
    """
    start_ms, end_ms = int(start_s * 1000), int(end_s * 1000)
    out = []
    for cue in cues:
        if cue["end_ms"] <= start_ms or cue["start_ms"] >= end_ms:
            continue
        out.append({
            "start_ms": max(cue["start_ms"], start_ms) - start_ms,
            "end_ms": min(cue["end_ms"], end_ms) - start_ms,
            "text": cue["text"],
        })
    return out


def regroup_karaoke(cues: List[Dict[str, Any]], words_per_group: int = 3) -> List[Dict[str, Any]]:
    """SRT cues -> word stream (even-split timing) -> N-word karaoke groups."""
    words: List[Dict[str, Any]] = []
    for cue in cues:
        words.extend(_even_split_words(cue))
    return cues_from_words(words, words_per_group)


def _even_split_words(cue: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Fallback word timing: split the cue duration evenly (Lambda parity)."""
    tokens = cue["text"].split()
    if not tokens:
        return []
    duration = max(10, cue["end_ms"] - cue["start_ms"])
    per_word = duration / len(tokens)
    return [{
        "text": tok,
        "start_ms": int(cue["start_ms"] + i * per_word),
        "end_ms": int(cue["start_ms"] + (i + 1) * per_word),
    } for i, tok in enumerate(tokens)]


# ---------------------------------------------------------------------------
# Output builders
# ---------------------------------------------------------------------------

def build_srt(cues: List[Dict[str, Any]], all_caps: bool = False) -> str:
    lines = []
    for i, cue in enumerate(cues, start=1):
        text = cue["text"].upper() if all_caps else cue["text"]
        lines.append(str(i))
        lines.append(f"{_ms_to_srt_ts(cue['start_ms'])} --> {_ms_to_srt_ts(cue['end_ms'])}")
        lines.append(text)
        lines.append("")
    return "\n".join(lines)


HOOK_SECONDS = 2.8


def build_ass(
    cues: List[Dict[str, Any]],
    cfg: Optional[Dict[str, Any]] = None,
    video_w: int = 1080,
    video_h: int = 1920,
    hook_text: Optional[str] = None,
    keywords: Optional[List[str]] = None,
) -> str:
    """Build a styled ASS file. Karaoke word-highlight when enabled.

    Each cue may carry ``words`` with real timestamps; otherwise the cue
    duration is split evenly across its words (matching the old Lambda).

    ``hook_text`` burns a top-centered hook line over the clip's first
    HOOK_SECONDS (replaces the retention-killing black title slide).

    ``keywords`` (e.g. from AI highlight selection) are rendered in
    ``keywordColor`` for OpusClip-style emphasis; the karaoke highlight
    still wins while a keyword is the active word.
    """
    cfg = {**DEFAULT_CAPTION_CONFIG, **(cfg or {})}
    font_name = f"{cfg.get('fontFamily', 'Montserrat')} Black"
    font_size = int(cfg.get("fontSize", 92))
    primary = _hex_to_ass_color(cfg.get("fontColor", "#FFFFFF"))
    outline = _hex_to_ass_color(cfg.get("strokeColor", "#000000"))
    outline_w = int(cfg.get("strokeWidth", 8))
    highlight = _hex_to_ass_color(cfg.get("highlightColor", "#FFD400"))
    keyword_color = _hex_to_ass_color(cfg.get("keywordColor", "#00E676"))
    all_caps = bool(cfg.get("allCaps", True))
    karaoke = bool(cfg.get("karaoke", True))

    kw_set = set()
    if keywords and bool(cfg.get("keywordHighlight", True)):
        for keyword in keywords:
            for word in str(keyword).split():
                word = re.sub(r"[^\w']", "", word).lower()
                if len(word) > 2:
                    kw_set.add(word)

    def _is_keyword(token: str) -> bool:
        return bool(kw_set) and re.sub(r"[^\w']", "", token).lower() in kw_set

    if str(cfg.get("position", "bottom")).lower() == "center":
        alignment, margin_v = 5, 0
    else:
        alignment, margin_v = 2, int(cfg.get("marginBottom", 260))

    hook_fs = max(56, int(video_h * 0.038))
    hook_style = (
        f"Style: Hook,{font_name},{hook_fs},"
        f"{highlight},&H000000FF,"
        f"{outline},&H80000000,"
        f"-1,0,0,0,100,100,0,0,1,{outline_w},2,8,60,60,{int(video_h * 0.11)},1\n"
    ) if hook_text else ""

    header = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        "Collisions: Normal\n"
        f"PlayResX: {video_w}\n"
        f"PlayResY: {video_h}\n"
        "Timer: 100.0000\n"
        "\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Default,{font_name},{font_size},"
        f"{primary},&H000000FF,"
        f"{outline},&H80000000,"
        f"-1,0,0,0,100,100,0,0,1,{outline_w},2,{alignment},80,80,{margin_v},1\n"
        + hook_style +
        "\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )

    def fmt(text: str) -> str:
        return (text.upper() if all_caps else text).replace("\n", "\\N")

    dialogue = []
    if hook_text:
        line = "\\N".join(textwrap.wrap(fmt(hook_text.strip()), width=20)[:3])
        dialogue.append(
            f"Dialogue: 1,{_ms_to_ass_ts(0)},{_ms_to_ass_ts(int(HOOK_SECONDS * 1000))},"
            f"Hook,,0,0,0,,{line}"
        )
    for cue in cues:
        words = cue.get("words") or []
        if karaoke and (words or len(cue["text"].split()) > 1):
            if not words:
                words = _even_split_words(cue)
            for i, word in enumerate(words):
                start_ms = word["start_ms"]
                # Extend each word's highlight to the next word's start so the
                # phrase never flickers to un-highlighted between words.
                end_ms = words[i + 1]["start_ms"] if i + 1 < len(words) else cue["end_ms"]
                if end_ms <= start_ms:
                    end_ms = start_ms + 10
                parts = []
                for j, other in enumerate(words):
                    token = fmt(other["text"])
                    if j == i:
                        color = highlight
                    elif _is_keyword(other["text"]):
                        color = keyword_color
                    else:
                        color = primary
                    parts.append(f"{{\\c{color}&}}{token}")
                dialogue.append(
                    f"Dialogue: 0,{_ms_to_ass_ts(start_ms)},{_ms_to_ass_ts(end_ms)},"
                    f"Default,,0,0,0,,{' '.join(parts)}"
                )
        else:
            if kw_set:
                text = " ".join(
                    f"{{\\c{keyword_color}&}}{fmt(tok)}{{\\c{primary}&}}"
                    if _is_keyword(tok) else fmt(tok)
                    for tok in cue["text"].split()
                )
            else:
                text = fmt(cue["text"])
            dialogue.append(
                f"Dialogue: 0,{_ms_to_ass_ts(cue['start_ms'])},{_ms_to_ass_ts(cue['end_ms'])},"
                f"Default,,0,0,0,,{text}"
            )

    return header + "\n".join(dialogue) + "\n"
