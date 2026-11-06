#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Render the docs images for dsh-status-tray.

!!! 这些全部是「界面示意图（illustrative mockups），非实机截图」。!!!

它们用手绘矢量形状 + Windows 系统字体模拟 Windows 11 外观，用于 README 展示，
不含任何个人信息、真实余额、真实时间日期、桌面壁纸、第三方 App 图标或真实会话标题。
所有内容都是占位文案（示例项目 A / 示例项目 B / ¥12.34）。

生成物（open-source/dsh-status-tray/docs/）：
    status-lights.png        636x216  四色圆点 + 中文状态标签
    tray-menu.png            660x420  Windows 11 风格右键菜单（v6 八项：控制台 / 网页版 / 状态页 / 余额 / 设置快捷键 / 退出）
    hotkey-settings.png      470x340  「设置全局快捷键」窗口 mockup（捕获框 / 状态行 / 三个按钮）
    tooltip-multi-session.png 715x248 托盘悬停提示（两个工作中的会话）+ 中性任务栏
    notify-completion.png    760x300  任务完成通知气泡
    notify-approval.png      760x300  需要审批通知气泡

用法（任意目录均可，脚本按自身位置定位仓库）：
    python dev/render-docs-images.py

依赖：Python 3.8+ / Pillow 9.1+（Windows 自带字体 msyh.ttc / msyhbd.ttc /
segoeui.ttf / segmdl2.ttf，缺少字体时会明确报错）。
绘制时统一以 device_scale=2 超采样，最后 LANCZOS 降采样，保证细线/中文小字清晰。
脚本是确定性的（无随机、无时间戳），重复运行输出相同的 PNG。
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

# ---------------------------------------------------------------------------
# 基本设置
# ---------------------------------------------------------------------------

SCALE = 2  # device_scale：先按 2x 绘制，再 LANCZOS 缩到目标尺寸
ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
FONT_DIR = Path(r"C:\Windows\Fonts")

# 与 README / config.json 默认值一致的四色
COLORS = {
    "approval": "#E5484D",  # 红：需要审批 / 需要你回答
    "working": "#F2B705",   # 黄：工作中
    "idle": "#2FA84F",      # 绿：空闲（DSH 正常运行）
    "offline": "#9AA0A6",   # 灰：DSH 未运行
}

INK = "#1B1B1F"            # Win11 主文本色
TASKBAR_BG = "#1F1F1F"     # 中性深色任务栏（非真实桌面）
TOAST_BG_TOP = "#303030"   # Win11 深色通知卡片
TOAST_BG_BOTTOM = "#272727"
TOAST_BORDER = (255, 255, 255, 26)

FONT_UI = "msyh.ttc"          # 微软雅黑（index=1 -> Microsoft YaHei UI）
FONT_UI_BOLD = "msyhbd.ttc"
FONT_LATIN = "segoeui.ttf"
FONT_LATIN_BOLD = "segoeuib.ttf"
FONT_GLYPH = "segmdl2.ttf"    # Windows 系统图标字形（非第三方 App 图标）


# ---------------------------------------------------------------------------
# 颜色 / 几何小工具
# ---------------------------------------------------------------------------

def rgb(hex_color: str) -> tuple[int, int, int]:
    hex_color = hex_color.lstrip("#")
    return tuple(int(hex_color[i:i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def mix(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    """线性混合两个颜色，t=0 -> a，t=1 -> b。"""
    t = max(0.0, min(1.0, t))
    return tuple(round(a[i] * (1 - t) + b[i] * t) for i in range(3))  # type: ignore[return-value]


def font(name: str, size: float, index: int = 0) -> ImageFont.FreeTypeFont:
    path = FONT_DIR / name
    if not path.exists():
        raise FileNotFoundError(f"缺少字体：{path}（本脚本面向 Windows，需系统自带字体）")
    return ImageFont.truetype(str(path), int(round(size * SCALE)), index=index)


def ui_font(size: float, bold: bool = False) -> ImageFont.FreeTypeFont:
    """中文 UI 字体：Microsoft YaHei UI。"""
    return font(FONT_UI_BOLD if bold else FONT_UI, size, index=1)


def latin_font(size: float, bold: bool = False) -> ImageFont.FreeTypeFont:
    """拉丁 UI 字体：Segoe UI（用于英文标题/窗口名）。"""
    return font(FONT_LATIN_BOLD if bold else FONT_LATIN, size)


def glyph_font(size: float) -> ImageFont.FreeTypeFont:
    """Segoe MDL2 Assets：Windows 系统图标字形。"""
    return font(FONT_GLYPH, size)


# ---------------------------------------------------------------------------
# 画布：逻辑坐标按 SCALE 放大，最后 LANCZOS 缩小
# ---------------------------------------------------------------------------

class Canvas:
    def __init__(self, width: int, height: int) -> None:
        self.w = width
        self.h = height
        self.img = Image.new("RGBA", (width * SCALE, height * SCALE), (0, 0, 0, 0))
        self.d = ImageDraw.Draw(self.img)

    # -- 坐标换算 ----------------------------------------------------------
    def _p(self, x: float, y: float) -> tuple[int, int]:
        return int(round(x * SCALE)), int(round(y * SCALE))

    def _box(self, box) -> tuple[int, int, int, int]:
        return tuple(int(round(v * SCALE)) for v in box)  # type: ignore[return-value]

    def _w(self, width: float) -> int:
        return max(1, int(round(width * SCALE)))

    # -- 背景 --------------------------------------------------------------
    def gradient_bg(self, top_hex: str, bottom_hex: str) -> None:
        top, bottom = rgb(top_hex), rgb(bottom_hex)
        strip = Image.new("RGB", (1, self.h * SCALE))
        for y in range(strip.height):
            t = y / max(1, strip.height - 1)
            strip.putpixel((0, y), mix(top, bottom, t))
        self.img.paste(strip.resize(self.img.size, Image.Resampling.BILINEAR), (0, 0))

    # -- 形状 --------------------------------------------------------------
    # 注意：Pillow 的 ImageDraw 在 RGBA 画布上是「覆盖」而不是「混合」半透明色，
    # 所以凡是 alpha < 255 的颜色都先画到独立图层，再 alpha_composite 回画布。
    @staticmethod
    def _has_alpha(color) -> bool:
        return isinstance(color, tuple) and len(color) == 4 and color[3] < 255

    def _layer_draw(self, fn) -> None:
        layer = Image.new("RGBA", self.img.size, (0, 0, 0, 0))
        fn(ImageDraw.Draw(layer))
        self.img.alpha_composite(layer)

    def rrect(self, box, radius: float, fill=None, outline=None, width: float = 1) -> None:
        args = (self._box(box),)
        kwargs = dict(radius=int(round(radius * SCALE)), fill=fill,
                      outline=outline, width=self._w(width))
        if self._has_alpha(fill) or self._has_alpha(outline):
            self._layer_draw(lambda d: d.rounded_rectangle(*args, **kwargs))
        else:
            self.d.rounded_rectangle(*args, **kwargs)

    def rect(self, box, fill) -> None:
        args = (self._box(box),)
        if self._has_alpha(fill):
            self._layer_draw(lambda d: d.rectangle(*args, fill=fill))
        else:
            self.d.rectangle(*args, fill=fill)

    def ellipse(self, box, fill=None, outline=None, width: float = 1) -> None:
        args = (self._box(box),)
        kwargs = dict(fill=fill, outline=outline, width=self._w(width))
        if self._has_alpha(fill) or self._has_alpha(outline):
            self._layer_draw(lambda d: d.ellipse(*args, **kwargs))
        else:
            self.d.ellipse(*args, **kwargs)

    def line(self, xy, fill, width: float = 1) -> None:
        pts = [self._p(x, y) for x, y in xy]
        if self._has_alpha(fill):
            self._layer_draw(lambda d: d.line(pts, fill=fill, width=self._w(width)))
        else:
            self.d.line(pts, fill=fill, width=self._w(width))

    def polygon(self, points, fill) -> None:
        pts = [self._p(x, y) for x, y in points]
        if self._has_alpha(fill):
            self._layer_draw(lambda d: d.polygon(pts, fill=fill))
        else:
            self.d.polygon(pts, fill=fill)

    def text(self, xy, text: str, f: ImageFont.FreeTypeFont, fill, anchor: str = "la") -> None:
        pos = self._p(*xy)
        if self._has_alpha(fill):
            self._layer_draw(lambda d: d.text(pos, text, font=f, fill=fill, anchor=anchor))
        else:
            self.d.text(pos, text, font=f, fill=fill, anchor=anchor)

    def glyph(self, xy, codepoint: int, size: float, fill, anchor: str = "mm") -> None:
        self.text(xy, chr(codepoint), glyph_font(size), fill, anchor=anchor)

    # -- 文本宽度（逻辑像素） ----------------------------------------------
    @staticmethod
    def text_len(text: str, f: ImageFont.FreeTypeFont) -> float:
        return f.getlength(text) / SCALE

    # -- 阴影 --------------------------------------------------------------
    def drop_shadow(self, box, radius: float, blur: float = 8,
                    offset: tuple[float, float] = (0, 4), alpha: int = 40) -> None:
        layer = Image.new("RGBA", self.img.size, (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        x0, y0, x1, y1 = box
        ld.rounded_rectangle(
            self._box((x0 + offset[0], y0 + offset[1], x1 + offset[0], y1 + offset[1])),
            radius=int(round(radius * SCALE)), fill=(0, 0, 0, alpha),
        )
        layer = layer.filter(ImageFilter.GaussianBlur(blur * SCALE))
        self.img.alpha_composite(layer)

    # -- 输出 --------------------------------------------------------------
    def save(self, path: Path) -> None:
        out = self.img.convert("RGB").resize((self.w, self.h), Image.Resampling.LANCZOS)
        out.save(path, format="PNG", optimize=True)


# ---------------------------------------------------------------------------
# 复用组件
# ---------------------------------------------------------------------------

def glossy_dot(cv: Canvas, cx: float, cy: float, r: float, color_hex: str) -> None:
    """Win11 风格状态圆点：柔和投影 + 深色描边 + 顶部高光 + 底部收暗。"""
    base = rgb(color_hex)
    # 1) 柔和投影
    cv.drop_shadow(
        (cx - r * 0.92, cy - r * 0.82, cx + r * 0.92, cy + r * 0.98),
        radius=r * 0.92, blur=3.4, offset=(0, 2.4), alpha=44,
    )
    # 2) 深色描边 + 主体
    cv.ellipse((cx - r, cy - r, cx + r, cy + r), fill=mix(base, (0, 0, 0), 0.46))
    inner = r - max(1.4, r * 0.045)
    cv.ellipse((cx - inner, cy - inner, cx + inner, cy + inner), fill=base)

    # 3) 球面光照：左上高光 + 边缘收暗（逐像素计算，面积很小，纯 Python 足够快）
    R = inner * SCALE
    size = int(round(R * 2)) + 4
    patch = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    pix = patch.load()
    centre = size / 2.0
    light_x, light_y = -0.40, -0.44
    for yy in range(size):
        ny = (yy - centre) / R
        for xx in range(size):
            nx = (xx - centre) / R
            d2 = nx * nx + ny * ny
            if d2 > 1.0:
                continue
            dl = math.hypot(nx - light_x, ny - light_y)
            white = 0.52 * max(0.0, 1.0 - dl / 1.55) ** 2.1
            edge = math.sqrt(d2)
            dark = 0.34 * max(0.0, (edge - 0.72) / 0.28) ** 1.6
            total = white + dark
            if total <= 0.004:
                continue
            alpha = min(255, int(round(255 * total)))
            value = int(round(255 * white / total))
            pix[xx, yy] = (value, value, value, alpha)
    patch = patch.filter(ImageFilter.GaussianBlur(max(1.0, R * 0.012)))
    cv.img.alpha_composite(patch, (int(round(cx * SCALE - size / 2)),
                                   int(round(cy * SCALE - size / 2))))

    # 4) 左上角镜面高光（柔和光斑）
    spec = Image.new("RGBA", cv.img.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(spec)
    sx, sy = cx - r * 0.30, cy - r * 0.44
    sw, sh = r * 0.28, r * 0.17
    sd.ellipse(cv._box((sx - sw, sy - sh, sx + sw, sy + sh)), fill=(255, 255, 255, 138))
    spec = spec.filter(ImageFilter.GaussianBlur(r * 0.055 * SCALE))
    cv.img.alpha_composite(spec)


def info_icon(cv: Canvas, cx: float, cy: float, r: float) -> None:
    """通知里的蓝色信息图标（圆底 + 白色 i）。"""
    cv.ellipse((cx - r, cy - r, cx + r, cy + r), fill=mix(rgb("#3B82F6"), (0, 0, 0), 0.10))
    # 圆形高光
    cv.ellipse((cx - r * 0.78, cy - r * 0.82, cx + r * 0.10, cy - r * 0.18),
               fill=(255, 255, 255, 26))
    stem_w = max(1.8, r * 0.11)
    cv.rrect((cx - stem_w, cy - r * 0.04, cx + stem_w, cy + r * 0.46),
             radius=stem_w, fill=(255, 255, 255, 255))
    dot_r = max(2.0, r * 0.13)
    cv.ellipse((cx - dot_r, cy - r * 0.47 - dot_r, cx + dot_r, cy - r * 0.47 + dot_r),
               fill=(255, 255, 255, 255))


def warning_icon(cv: Canvas, cx: float, cy: float, r: float) -> None:
    """通知里的黄色警告图标（圆角实心三角 + 深色 !）。"""
    top = (cx, cy - r)
    left = (cx - r * 1.08, cy + r * 0.80)
    right = (cx + r * 1.08, cy + r * 0.80)
    yellow = rgb("#F5C242")

    cv.polygon((top, left, right), fill=yellow)
    # 三个顶点补圆 -> 圆角三角
    corner = max(2.0, r * 0.16)
    for vx, vy in (top, left, right):
        cv.ellipse((vx - corner, vy - corner, vx + corner, vy + corner), fill=yellow)
    # 顶部略亮一点，增加层次
    cv.polygon(((cx, cy - r * 0.82), (cx - r * 0.72, cy + r * 0.52),
                (cx + r * 0.72, cy + r * 0.52)), fill=mix(yellow, (255, 255, 255), 0.14))

    dark = rgb("#231A00")
    stem_w = max(2.0, r * 0.13)
    cv.rrect((cx - stem_w, cy - r * 0.32, cx + stem_w, cy + r * 0.10),
             radius=stem_w * 0.6, fill=dark)
    dot_r = max(2.0, r * 0.15)
    cv.ellipse((cx - dot_r, cy + r * 0.34 - dot_r, cx + dot_r, cy + r * 0.34 + dot_r),
               fill=dark)


# ---------------------------------------------------------------------------
# 1) status-lights.png —— 四色圆点 + 中文标签
# ---------------------------------------------------------------------------

def render_status_lights() -> None:
    W, H = 636, 216
    cv = Canvas(W, H)
    cv.gradient_bg("#FBFCFD", "#F1F3F5")

    dots = [
        ("working", "工作中"),
        ("approval", "需要审批"),
        ("idle", "空闲（DSH 正常运行）"),
        ("offline", "DSH 未运行"),
    ]
    label_font = ui_font(20)
    centers = [78.0, 206.0, 381.5, 557.5]  # 与原示意图的圆点位置接近
    radius = 48.0
    dot_cy = 76.0
    label_cy = 157.0

    for (key, label), cx in zip(dots, centers):
        glossy_dot(cv, cx, dot_cy, radius, COLORS[key])
        cv.text((cx, label_cy), label, label_font, INK, anchor="mm")

    cv.save(DOCS / "status-lights.png")


# ---------------------------------------------------------------------------
# 2) tray-menu.png —— Win11 风格右键菜单
# ---------------------------------------------------------------------------

def render_tray_menu() -> None:
    """v6 菜单：6 个操作项 + 2 条分隔线（共 8 行），Win11 风格圆角面板。"""
    menu_rows = [
        ("打开控制台", False),
        ("打开网页版 DeepSeek", False),
        ("查看 DS 服务器状态", False),
        ("充值余额：¥12.34", False),
        ("", True),  # 分隔线
        ("设置全局快捷键…", False),
        ("", True),  # 分隔线
        ("退出", False),
    ]
    W, H = 660, 420
    cv = Canvas(W, H)
    cv.gradient_bg("#F2F3F5", "#FBFBFC")

    item_font = ui_font(23)
    text_items = [label for label, is_sep in menu_rows if not is_sep]
    text_w = max(cv.text_len(t, item_font) for t in text_items)

    pad_x = 22.0
    pad_top = 11.0
    item_h = 50.0
    sep_block = 13.0  # 4px 上边距 + 1px 分隔线 + 8px 下边距
    panel_w = max(280.0, text_w + pad_x * 2 + 26.0)
    content_h = pad_top * 2
    for _, is_sep in menu_rows:
        content_h += sep_block if is_sep else item_h
    panel_h = content_h
    px = (W - panel_w) / 2
    py = (H - panel_h) / 2

    # 柔和阴影 + 圆角面板 + 细边框（Win11 风格）
    cv.drop_shadow((px, py, px + panel_w, py + panel_h),
                   radius=9, blur=16, offset=(0, 7), alpha=52)
    cv.rrect((px, py, px + panel_w, py + panel_h), radius=9,
             fill="#FAFAFA", outline=(0, 0, 0, 30), width=1)
    # 顶部内高光（让圆角面板更立体）
    cv.line(((px + 11, py + 1.0), (px + panel_w - 11, py + 1.0)),
            fill=(255, 255, 255, 190), width=1)

    # 逐行绘制菜单项与分隔线
    y = py + pad_top
    for label, is_sep in menu_rows:
        if is_sep:
            sep_y = y + 4.5
            cv.line(((px + 12, sep_y), (px + panel_w - 12, sep_y)),
                    fill="#E3E4E6", width=1)
            y += sep_block
        else:
            cv.text((px + pad_x, y + item_h * 0.5), label, item_font, INK, anchor="lm")
            y += item_h

    cv.save(DOCS / "tray-menu.png")


# ---------------------------------------------------------------------------
# 2b) hotkey-settings.png —— 「设置全局快捷键」窗口 mockup
# ---------------------------------------------------------------------------

def render_hotkey_settings() -> None:
    """Win11 浅色小窗口 mockup：标题栏 / 说明 / 捕获框 / 状态行 / 三个按钮。"""
    win_w, win_h = 426.0, 289.0
    W, H = 470, 340
    cv = Canvas(W, H)
    cv.gradient_bg("#F2F3F5", "#FBFBFC")

    wx = (W - win_w) / 2
    wy = (H - win_h) / 2

    # 窗口：柔和阴影 + 圆角 + 细边框
    cv.drop_shadow((wx, wy, wx + win_w, wy + win_h),
                   radius=8, blur=18, offset=(0, 9), alpha=64)
    cv.rrect((wx, wy, wx + win_w, wy + win_h), radius=8,
             fill="#F7F7F8", outline=(0, 0, 0, 34), width=1)

    # 标题栏：标题 + 关闭按钮 + 细分隔线
    cv.text((wx + 18, wy + 19), "设置全局快捷键", ui_font(14, bold=True), INK, anchor="lm")
    cv.glyph((wx + win_w - 20, wy + 19), 0xE711, 12, (90, 92, 96, 255))
    cv.line(((wx + 1, wy + 38), (wx + win_w - 1, wy + 38)),
            fill=(0, 0, 0, 20), width=1)

    # 说明文字（两行，占位文案）
    hint_font = ui_font(10.5)
    hint_color = (60, 62, 66, 255)
    cv.text((wx + 18, wy + 54), "按下新的快捷键组合（至少包含 Ctrl / Alt / Shift / Win 之一",
            hint_font, hint_color, anchor="la")
    cv.text((wx + 18, wy + 71), "+ 一个普通键）", hint_font, hint_color, anchor="la")

    # 只读捕获框
    box = (wx + 18, wy + 96, wx + win_w - 18, wy + 128)
    cv.rrect(box, radius=5, fill="#FFFFFF", outline=(0, 0, 0, 46), width=1)
    cv.text(((box[0] + box[2]) / 2, (box[1] + box[3]) / 2),
            "Ctrl+Alt+F9", ui_font(13), INK, anchor="mm")

    # 状态行
    cv.text((wx + 18, wy + 154), "已捕获：Ctrl+Alt+F9（点「保存并注册」生效）",
            ui_font(10.5), (47, 49, 54, 255), anchor="la")

    # 底部三个按钮（Win11 浅色圆角按钮）
    btn_h = 28.0
    btn_w = 100.0
    gap = 15.0
    btn_y = wy + win_h - 18 - btn_h
    inner_w = win_w - 36
    start_x = wx + 18 + (inner_w - (btn_w * 3 + gap * 2)) / 2
    for i, label in enumerate(["保存并注册", "清除", "取消"]):
        bx = start_x + i * (btn_w + gap)
        cv.rrect((bx, btn_y, bx + btn_w, btn_y + btn_h), radius=4,
                 fill="#FDFDFD", outline=(0, 0, 0, 50), width=1)
        cv.text((bx + btn_w / 2, btn_y + btn_h / 2), label, ui_font(11), INK, anchor="mm")

    cv.save(DOCS / "hotkey-settings.png")


# ---------------------------------------------------------------------------
# 3) tooltip-multi-session.png —— 悬停提示 + 中性任务栏
# ---------------------------------------------------------------------------

def render_tooltip() -> None:
    W, H = 715, 248
    taskbar_h = 46.0
    taskbar_top = H - taskbar_h
    cv = Canvas(W, H)
    cv.gradient_bg("#F4F5F7", "#FCFCFD")

    # 中性任务栏（深色、无真实桌面、无第三方图标、无时钟）
    cv.rect((0, taskbar_top, W, H), rgb(TASKBAR_BG))
    cv.line(((0, taskbar_top + 0.5), (W, taskbar_top + 0.5)),
            fill=(255, 255, 255, 16), width=1)

    bar_cy = taskbar_top + taskbar_h / 2
    icon_color = (222, 222, 222, 255)

    # 托盘：显示隐藏图标(^) / DSH 状态圆点（悬停高亮） / 系统图标
    cv.glyph((552, bar_cy), 0xE70E, 15, (200, 200, 200, 255))       # ChevronUp
    dot_cx = 592.0
    cv.rrect((dot_cx - 17, bar_cy - 17, dot_cx + 17, bar_cy + 17),
             radius=6, fill="#3A3A3A")
    glossy_dot(cv, dot_cx, bar_cy, 8.5, COLORS["working"])
    cv.glyph((632, bar_cy), 0xE701, 16, icon_color)                  # Wifi
    cv.glyph((661, bar_cy), 0xE995, 17, icon_color)                  # Volume
    cv.glyph((690, bar_cy), 0xE83F, 17, icon_color)                  # Battery

    # 悬停提示气泡：两行会话标题
    lines = ["示例项目 A", "示例项目 B"]
    tip_font = ui_font(15)
    line_h = 21.0
    pad_v = 8.0
    tip_w = max(cv.text_len(t, tip_font) for t in lines) + 24.0
    tip_h = pad_v * 2 + line_h * len(lines)
    tip_x = dot_cx - tip_w / 2
    tip_y = taskbar_top - 10 - tip_h
    cv.drop_shadow((tip_x, tip_y, tip_x + tip_w, tip_y + tip_h),
                   radius=6, blur=8, offset=(0, 3), alpha=60)
    cv.rrect((tip_x, tip_y, tip_x + tip_w, tip_y + tip_h), radius=6,
             fill="#2B2B2B", outline=(255, 255, 255, 20), width=1)
    for i, line in enumerate(lines):
        cy = tip_y + pad_v + line_h * (i + 0.5)
        cv.text((tip_x + tip_w / 2, cy), line, tip_font, (255, 255, 255, 255), anchor="mm")

    cv.save(DOCS / "tooltip-multi-session.png")


# ---------------------------------------------------------------------------
# 4/5) 通知气泡
# ---------------------------------------------------------------------------

def render_toast(filename: str, title: str, body: str, kind: str) -> None:
    W, H = 760, 300
    cv = Canvas(W, H)
    cv.gradient_bg("#F2F4F7", "#FBFBFC")

    toast_w, toast_h = 364.0, 96.0
    tx = (W - toast_w) / 2
    ty = (H - toast_h) / 2

    # 深色 Win11 通知卡片：柔和阴影 + 圆角 + 细边框 + 轻微渐变
    cv.drop_shadow((tx, ty, tx + toast_w, ty + toast_h),
                   radius=8, blur=18, offset=(0, 9), alpha=64)
    cv.rrect((tx, ty, tx + toast_w, ty + toast_h), radius=8,
             fill=TOAST_BG_TOP, outline=TOAST_BORDER, width=1)

    # 卡片内渐变：顶部略亮、底部略暗（裁剪到圆角矩形内）
    x0, y0, x1, y1 = cv._box((tx, ty, tx + toast_w, ty + toast_h))
    grad = Image.new("RGB", cv.img.size, rgb(TOAST_BG_TOP))
    gd = ImageDraw.Draw(grad)
    top_c, bottom_c = rgb(TOAST_BG_TOP), rgb(TOAST_BG_BOTTOM)
    for i in range((y1 - y0) + 1):
        gd.line(((0, y0 + i), (grad.width, y0 + i)),
                fill=mix(top_c, bottom_c, i / max(1, y1 - y0)))
    mask = Image.new("L", cv.img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (x0, y0, x1, y1), radius=int(round(8 * SCALE)), fill=255)
    cv.img.paste(grad, (0, 0), mask)
    # 重画边框，保证圆角边缘干净
    cv.rrect((tx, ty, tx + toast_w, ty + toast_h), radius=8,
             fill=None, outline=TOAST_BORDER, width=1)

    # 顶部工具条：应用名 + ... + 关闭
    header_cy = ty + 21.0
    cv.ellipse((tx + 14, header_cy - 5, tx + 24, header_cy + 5), fill="#9A9FA5")
    cv.text((tx + 30, header_cy), "DSHStatusTray.exe", latin_font(11.5, bold=False),
            (200, 202, 205, 255), anchor="lm")
    cv.glyph((tx + toast_w - 38, header_cy), 0xE712, 13, (198, 198, 198, 255))  # More
    cv.glyph((tx + toast_w - 15, header_cy), 0xE711, 12, (198, 198, 198, 255))  # Close

    # 主体：左侧彩色图标 + 标题 + 正文
    icon_cx = tx + 36.0
    icon_cy = ty + 63.0
    if kind == "info":
        info_icon(cv, icon_cx, icon_cy, 17.0)
    else:
        warning_icon(cv, icon_cx, icon_cy - 1.0, 16.0)

    text_x = tx + 67.0
    cv.text((text_x, ty + 49.0), title, ui_font(15.5, bold=True),
            (255, 255, 255, 255), anchor="lm")
    cv.text((text_x, ty + 72.0), body, ui_font(13),
            (211, 214, 218, 255), anchor="lm")

    cv.save(DOCS / filename)


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main() -> None:
    DOCS.mkdir(parents=True, exist_ok=True)
    render_status_lights()
    render_tray_menu()
    render_hotkey_settings()
    render_tooltip()
    render_toast("notify-completion.png", "任务完成", "「示例项目 A」已完成本轮任务", "info")
    render_toast("notify-approval.png", "需要审批", "有操作在等你批准：pwsh · 示例项目 A", "warning")

    print("Rendered docs images (illustrative mockups, NOT real screenshots):")
    for name in (
        "status-lights.png",
        "tray-menu.png",
        "hotkey-settings.png",
        "tooltip-multi-session.png",
        "notify-completion.png",
        "notify-approval.png",
    ):
        path = DOCS / name
        with Image.open(path) as im:
            print(f"  {path.relative_to(ROOT).as_posix():38s} {im.width}x{im.height}  {path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
