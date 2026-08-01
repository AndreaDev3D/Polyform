//! Text shaping + layout (Sprint E, the HarfBuzz stack). rustybuzz shapes
//! (kerning, ligatures, OpenType features); ttf-parser supplies metrics and
//! glyph outlines. Layout mirrors src/renderer/src/engine/text.ts
//! `layoutText` — same greedy word wrap, same alignment and baseline
//! formula — but measures with real shaped advances instead of Canvas2D
//! `measureText`, and uses the font's real ascender instead of the 0.8em
//! approximation. Deterministic: same font bytes + params → same layout on
//! every machine (closes F-02).
//!
//! Coordinates: font tables are y-up; everything returned from this module
//! is converted to the document's y-down convention.

use std::cell::RefCell;

use crate::geometry::vec2;
use crate::shapes::{Anchor, SubPath};

thread_local! {
    static FONTS: RefCell<Vec<Vec<u8>>> = const { RefCell::new(Vec::new()) };
}

/// Register font bytes; returns a handle or None if the face fails to parse.
pub fn load_font(bytes: Vec<u8>) -> Option<usize> {
    rustybuzz::Face::from_slice(&bytes, 0)?;
    FONTS.with(|f| {
        let mut fonts = f.borrow_mut();
        fonts.push(bytes);
        Some(fonts.len() - 1)
    })
}

pub fn with_face<T>(id: usize, run: impl FnOnce(&rustybuzz::Face) -> T) -> Option<T> {
    FONTS.with(|f| {
        let fonts = f.borrow();
        let bytes = fonts.get(id)?;
        let face = rustybuzz::Face::from_slice(bytes, 0)?;
        Some(run(&face))
    })
}

#[derive(Clone, Copy, Debug)]
pub struct FontMetrics {
    pub units_per_em: f64,
    pub ascender: f64,
    pub descender: f64,
    pub line_gap: f64,
}

pub fn metrics(face: &rustybuzz::Face) -> FontMetrics {
    FontMetrics {
        units_per_em: face.units_per_em() as f64,
        ascender: face.ascender() as f64,
        descender: face.descender() as f64,
        line_gap: face.line_gap() as f64,
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ShapedGlyph {
    pub glyph_id: u32,
    pub x_advance: f64, // font units
    pub x_offset: f64,
    pub y_offset: f64,
}

/// Shape one run (no bidi/script itemization — single-style runs, LTR).
pub fn shape_run(face: &rustybuzz::Face, text: &str) -> Vec<ShapedGlyph> {
    let mut buf = rustybuzz::UnicodeBuffer::new();
    buf.push_str(text);
    let out = rustybuzz::shape(face, &[], buf);
    let infos = out.glyph_infos();
    let positions = out.glyph_positions();
    infos
        .iter()
        .zip(positions.iter())
        .map(|(i, p)| ShapedGlyph {
            glyph_id: i.glyph_id,
            x_advance: p.x_advance as f64,
            x_offset: p.x_offset as f64,
            y_offset: p.y_offset as f64,
        })
        .collect()
}

/// Shaped width in px: advances scaled to `size`, plus `letter_spacing`
/// after every glyph (mirrors Canvas2D `letterSpacing` semantics).
fn measure_shaped(face: &rustybuzz::Face, text: &str, size: f64, letter_spacing: f64) -> f64 {
    if text.is_empty() {
        return 0.0;
    }
    let scale = size / face.units_per_em() as f64;
    let glyphs = shape_run(face, text);
    let mut w = 0.0;
    for glyph in &glyphs {
        w += glyph.x_advance * scale + letter_spacing;
    }
    w
}

/// Split retaining whitespace runs — the Rust twin of `text.split(/(\s+)/)`.
fn split_keep_whitespace(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut in_ws: Option<bool> = None;
    for (i, ch) in text.char_indices() {
        let ws = ch.is_whitespace();
        match in_ws {
            None => in_ws = Some(ws),
            Some(prev) if prev != ws => {
                out.push(&text[start..i]);
                start = i;
                in_ws = Some(ws);
            }
            _ => {}
        }
    }
    if start < text.len() {
        out.push(&text[start..]);
    }
    out
}

/// Greedy word wrap, mirroring text.ts `wrapLine` (incl. the binary-search
/// hard break for overlong single words, on char boundaries).
fn wrap_line<'a>(
    face: &rustybuzz::Face,
    text: &'a str,
    size: f64,
    letter_spacing: f64,
    max_width: f64,
) -> Vec<String> {
    if max_width <= 0.0 || measure_shaped(face, text, size, letter_spacing) <= max_width {
        return vec![text.to_string()];
    }
    let mut lines: Vec<String> = Vec::new();
    let mut current = String::new();
    for word in split_keep_whitespace(text) {
        let candidate = format!("{current}{word}");
        if !current.is_empty()
            && measure_shaped(face, candidate.trim_end(), size, letter_spacing) > max_width
        {
            lines.push(current.trim_end().to_string());
            current = word.trim_start().to_string();
            // Hard-break overlong single words (binary search on chars).
            while measure_shaped(face, &current, size, letter_spacing) > max_width
                && current.chars().count() > 1
            {
                let chars: Vec<char> = current.chars().collect();
                let mut lo = 1usize;
                let mut hi = chars.len();
                while lo < hi {
                    let mid = lo + (hi - lo).div_ceil(2);
                    let prefix: String = chars[..mid].iter().collect();
                    if measure_shaped(face, &prefix, size, letter_spacing) > max_width {
                        hi = mid - 1;
                    } else {
                        lo = mid;
                    }
                }
                lines.push(chars[..lo].iter().collect());
                current = chars[lo..].iter().collect();
            }
        } else {
            current = candidate;
        }
    }
    if !current.trim_end().is_empty() || lines.is_empty() {
        lines.push(current.trim_end().to_string());
    }
    lines
}

#[derive(Clone, Copy, Debug)]
pub struct LayoutParams<'a> {
    pub text: &'a str,
    pub size: f64,
    pub line_height: f64,
    pub letter_spacing: f64,
    pub width: f64,
    pub height: f64,
    /// 0 LEFT, 1 CENTER, 2 RIGHT
    pub align_h: u8,
    /// 0 TOP, 1 CENTER, 2 BOTTOM
    pub align_v: u8,
    /// 0 WIDTH_AND_HEIGHT, 1 HEIGHT, 2 NONE
    pub auto_resize: u8,
}

#[derive(Clone, Debug)]
pub struct GlyphPos {
    pub glyph_id: u32,
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug)]
pub struct LaidLine {
    pub text: String,
    pub width: f64,
    pub x: f64,
    pub baseline: f64,
    pub glyphs: Vec<GlyphPos>,
}

#[derive(Clone, Debug)]
pub struct TextLayoutOut {
    pub lines: Vec<LaidLine>,
    pub line_height_px: f64,
    pub ascent: f64,
    pub total_width: f64,
    pub total_height: f64,
}

pub fn layout_text(face: &rustybuzz::Face, p: &LayoutParams) -> TextLayoutOut {
    let scale = p.size / face.units_per_em() as f64;
    let line_height_px = p.size * p.line_height;
    // Real ascender in the same baseline formula text.ts uses with its 0.8em
    // approximation — an intentional metric improvement, not a parity bug.
    let ascent = face.ascender() as f64 * scale;

    let raw: Vec<&str> = if p.text.is_empty() { vec![""] } else { p.text.split('\n').collect() };
    let texts: Vec<String> = if p.auto_resize == 0 {
        raw.iter().map(|s| s.to_string()).collect()
    } else {
        raw.iter()
            .flat_map(|l| wrap_line(face, l, p.size, p.letter_spacing, p.width))
            .collect()
    };

    let widths: Vec<f64> =
        texts.iter().map(|t| measure_shaped(face, t, p.size, p.letter_spacing)).collect();
    let total_width = widths.iter().fold(1.0f64, |a, &b| a.max(b));
    let total_height = line_height_px.max(texts.len() as f64 * line_height_px);

    let box_width = if p.auto_resize == 0 { total_width } else { p.width };
    let box_height = if p.auto_resize == 2 { p.height } else { total_height };

    let mut y_start = 0.0;
    if p.align_v == 1 {
        y_start = (box_height - texts.len() as f64 * line_height_px) / 2.0;
    } else if p.align_v == 2 {
        y_start = box_height - texts.len() as f64 * line_height_px;
    }

    let lines = texts
        .iter()
        .zip(widths.iter())
        .enumerate()
        .map(|(i, (text, &width))| {
            let mut x = 0.0;
            if p.align_h == 1 {
                x = (box_width - width) / 2.0;
            } else if p.align_h == 2 {
                x = box_width - width;
            }
            let baseline = y_start + i as f64 * line_height_px + ascent
                + (line_height_px - p.size) / 2.0;
            let mut glyphs = Vec::new();
            if !text.is_empty() {
                let mut pen = x;
                for glyph in shape_run(face, text) {
                    glyphs.push(GlyphPos {
                        glyph_id: glyph.glyph_id,
                        x: pen + glyph.x_offset * scale,
                        y: baseline - glyph.y_offset * scale,
                    });
                    pen += glyph.x_advance * scale + p.letter_spacing;
                }
            }
            LaidLine { text: text.clone(), width, x, baseline, glyphs }
        })
        .collect();

    TextLayoutOut { lines, line_height_px, ascent, total_width, total_height }
}

// ---------------------------------------------------------------------------
// Glyph outlines -> SubPath anchors (font units, converted to y-down)
// ---------------------------------------------------------------------------

struct OutlineCollector {
    paths: Vec<SubPath>,
    pending: Vec<Anchor>,
}

impl OutlineCollector {
    fn flush(&mut self, closed: bool) {
        if self.pending.is_empty() {
            return;
        }
        let mut anchors = std::mem::take(&mut self.pending);
        if closed && anchors.len() > 1 {
            // TTF contours often end on their start point; merge the
            // duplicate so the closing segment carries the curve controls.
            let first_p = anchors[0].p;
            let last = anchors.last().unwrap();
            if (last.p.x - first_p.x).abs() < 1e-6 && (last.p.y - first_p.y).abs() < 1e-6 {
                let last = anchors.pop().unwrap();
                anchors[0].cp_in = last.cp_in;
            }
        }
        self.paths.push(SubPath { closed, anchors });
    }
}

impl rustybuzz::ttf_parser::OutlineBuilder for OutlineCollector {
    fn move_to(&mut self, x: f32, y: f32) {
        self.flush(false);
        self.pending.push(Anchor { p: vec2(x as f64, -y as f64), cp_in: None, cp_out: None });
    }

    fn line_to(&mut self, x: f32, y: f32) {
        self.pending.push(Anchor { p: vec2(x as f64, -y as f64), cp_in: None, cp_out: None });
    }

    fn quad_to(&mut self, cx: f32, cy: f32, x: f32, y: f32) {
        // Exact quadratic -> cubic elevation.
        let c = vec2(cx as f64, -cy as f64);
        let p = vec2(x as f64, -y as f64);
        if let Some(prev) = self.pending.last_mut() {
            let p0 = prev.p;
            prev.cp_out =
                Some(vec2(p0.x + (c.x - p0.x) * 2.0 / 3.0, p0.y + (c.y - p0.y) * 2.0 / 3.0));
            self.pending.push(Anchor {
                p,
                cp_in: Some(vec2(p.x + (c.x - p.x) * 2.0 / 3.0, p.y + (c.y - p.y) * 2.0 / 3.0)),
                cp_out: None,
            });
        }
    }

    fn curve_to(&mut self, c1x: f32, c1y: f32, c2x: f32, c2y: f32, x: f32, y: f32) {
        if let Some(prev) = self.pending.last_mut() {
            prev.cp_out = Some(vec2(c1x as f64, -c1y as f64));
        }
        self.pending.push(Anchor {
            p: vec2(x as f64, -y as f64),
            cp_in: Some(vec2(c2x as f64, -c2y as f64)),
            cp_out: None,
        });
    }

    fn close(&mut self) {
        self.flush(true);
    }
}

/// Glyph outline as SubPaths in font units, y-down (baseline at y=0, tops
/// negative). Empty for whitespace/missing glyphs.
pub fn glyph_sub_paths(face: &rustybuzz::Face, glyph_id: u16) -> Vec<SubPath> {
    let mut collector = OutlineCollector { paths: Vec::new(), pending: Vec::new() };
    let _ = face.outline_glyph(rustybuzz::ttf_parser::GlyphId(glyph_id), &mut collector);
    collector.flush(false); // stray open contour, if any
    collector.paths
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// System font candidates — tests skip (loudly) when none exists.
    fn test_font_bytes() -> Option<Vec<u8>> {
        let candidates = [
            "C:\\Windows\\Fonts\\arial.ttf",
            "C:\\Windows\\Fonts\\segoeui.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/TTF/DejaVuSans.ttf",
            "/System/Library/Fonts/Supplemental/Arial.ttf",
        ];
        for path in candidates {
            if let Ok(bytes) = std::fs::read(path) {
                return Some(bytes);
            }
        }
        eprintln!("text tests skipped: no system test font found");
        None
    }

    fn with_test_face(run: impl FnOnce(&rustybuzz::Face)) {
        let Some(bytes) = test_font_bytes() else { return };
        let face = rustybuzz::Face::from_slice(&bytes, 0).expect("face parses");
        run(&face);
    }

    #[test]
    fn metrics_are_sane() {
        with_test_face(|face| {
            let m = metrics(face);
            assert!(m.units_per_em > 0.0);
            assert!(m.ascender > 0.0);
            assert!(m.descender < 0.0);
        });
    }

    #[test]
    fn shaping_is_deterministic_and_kerns() {
        with_test_face(|face| {
            let a = measure_shaped(face, "AVATAR To", 16.0, 0.0);
            let b = measure_shaped(face, "AVATAR To", 16.0, 0.0);
            assert_eq!(a, b);
            // Kerned pair no wider than the sum of its parts.
            let av = measure_shaped(face, "AV", 100.0, 0.0);
            let a1 = measure_shaped(face, "A", 100.0, 0.0);
            let v1 = measure_shaped(face, "V", 100.0, 0.0);
            assert!(av <= a1 + v1 + 1e-6, "AV={av} A+V={}", a1 + v1);
        });
    }

    #[test]
    fn wrap_fits_width_and_layout_positions_are_monotonic() {
        with_test_face(|face| {
            let p = LayoutParams {
                text: "The quick brown fox jumps over the lazy dog again and again",
                size: 16.0,
                line_height: 1.4,
                letter_spacing: 0.0,
                width: 150.0,
                height: 300.0,
                align_h: 0,
                align_v: 0,
                auto_resize: 1,
            };
            let out = layout_text(face, &p);
            assert!(out.lines.len() > 1);
            for line in &out.lines {
                assert!(line.width <= p.width + 1e-6, "line '{}' overflows", line.text);
                let mut last_x = f64::MIN;
                for g in &line.glyphs {
                    assert!(g.x >= last_x - 1e-6);
                    last_x = g.x;
                }
            }
            assert!(out.total_height >= out.lines.len() as f64 * out.line_height_px - 1e-6);
        });
    }

    #[test]
    fn hard_break_splits_overlong_words() {
        // NOTE: mirrors a text.ts quirk — the hard break only fires for an
        // overlong word that FOLLOWS another word; a single-word text stays
        // one overlong line in both implementations.
        with_test_face(|face| {
            let p = LayoutParams {
                text: "a Antidisestablishmentarianism",
                size: 24.0,
                line_height: 1.2,
                letter_spacing: 0.0,
                width: 80.0,
                height: 100.0,
                align_h: 0,
                align_v: 0,
                auto_resize: 1,
            };
            let out = layout_text(face, &p);
            assert!(out.lines.len() > 1);
            for line in &out.lines {
                assert!(line.width <= p.width + 1e-6);
            }
        });
    }

    #[test]
    fn glyph_outline_is_y_down_and_closed() {
        with_test_face(|face| {
            let shaped = shape_run(face, "A");
            let gid = shaped[0].glyph_id as u16;
            let paths = glyph_sub_paths(face, gid);
            assert!(!paths.is_empty());
            let mut min_y = f64::MAX;
            for sp in &paths {
                assert!(sp.closed);
                assert!(sp.anchors.len() >= 3);
                for a in &sp.anchors {
                    min_y = min_y.min(a.p.y);
                }
            }
            // y-down: cap height sits above the baseline at negative y.
            assert!(min_y < 0.0);
        });
    }

    #[test]
    fn empty_text_yields_one_empty_line() {
        with_test_face(|face| {
            let p = LayoutParams {
                text: "",
                size: 16.0,
                line_height: 1.2,
                letter_spacing: 0.0,
                width: 100.0,
                height: 50.0,
                align_h: 0,
                align_v: 0,
                auto_resize: 0,
            };
            let out = layout_text(face, &p);
            assert_eq!(out.lines.len(), 1);
            assert!(out.lines[0].glyphs.is_empty());
            assert_eq!(out.total_width, 1.0);
        });
    }
}
