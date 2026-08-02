//! Color conversions — Rust twin of src/renderer/src/engine/color.ts (P4).
//! Pure arithmetic mirrors the TS source exactly (same clamp order, same
//! JS `%` fmod semantics, same rounding on the positive-only paths) so the
//! parity suite can demand exact equality.

/// Mirrors `rgbaToCss`: components in 0..1, css `rgba(R, G, B, A)` with the
/// alpha printed to 4 decimals (JS `toFixed(4)` equivalent).
pub fn rgba_to_css(r: f64, g: f64, b: f64, a: f64, extra_opacity: f64) -> String {
    let alpha = (a * extra_opacity).clamp(0.0, 1.0);
    format!(
        "rgba({}, {}, {}, {:.4})",
        (r * 255.0).round() as i64,
        (g * 255.0).round() as i64,
        (b * 255.0).round() as i64,
        alpha
    )
}

fn hex_component(v: f64) -> String {
    format!("{:02X}", (v.clamp(0.0, 1.0) * 255.0).round() as u32)
}

/// Mirrors `rgbaToHex`: uppercase RRGGBB without the leading '#'.
pub fn rgba_to_hex(r: f64, g: f64, b: f64) -> String {
    format!("{}{}{}", hex_component(r), hex_component(g), hex_component(b))
}

/// Mirrors `hexToRgba`: accepts RGB / RRGGBB with optional '#', else None.
pub fn hex_to_rgba(hex: &str, alpha: f64) -> Option<[f64; 4]> {
    let s = hex.trim();
    let s = s.strip_prefix('#').unwrap_or(s);
    let expanded: String = if s.len() == 3 && s.chars().all(|c| c.is_ascii_hexdigit()) {
        s.chars().flat_map(|c| [c, c]).collect()
    } else {
        s.to_string()
    };
    if expanded.len() != 6 || !expanded.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let channel = |i: usize| -> f64 {
        u8::from_str_radix(&expanded[i..i + 2], 16).unwrap_or(0) as f64 / 255.0
    };
    Some([channel(0), channel(2), channel(4), alpha])
}

/// Mirrors `hsvToRgb`: h in [0, 360), s/v in [0, 1].
pub fn hsv_to_rgb(h: f64, s: f64, v: f64) -> (f64, f64, f64) {
    let c = v * s;
    let x = c * (1.0 - (((h / 60.0) % 2.0) - 1.0).abs());
    let m = v - c;
    let (r, g, b) = if h < 60.0 {
        (c, x, 0.0)
    } else if h < 120.0 {
        (x, c, 0.0)
    } else if h < 180.0 {
        (0.0, c, x)
    } else if h < 240.0 {
        (0.0, x, c)
    } else if h < 300.0 {
        (x, 0.0, c)
    } else {
        (c, 0.0, x)
    };
    (r + m, g + m, b + m)
}

/// Mirrors `rgbToHsv`.
pub fn rgb_to_hsv(r: f64, g: f64, b: f64) -> (f64, f64, f64) {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let d = max - min;
    let mut h = 0.0;
    if d != 0.0 {
        if max == r {
            h = 60.0 * (((g - b) / d) % 6.0);
        } else if max == g {
            h = 60.0 * ((b - r) / d + 2.0);
        } else {
            h = 60.0 * ((r - g) / d + 4.0);
        }
    }
    if h < 0.0 {
        h += 360.0;
    }
    let s = if max == 0.0 { 0.0 } else { d / max };
    (h, s, max)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn css_formatting_matches_js_shape() {
        assert_eq!(rgba_to_css(1.0, 0.5, 0.0, 1.0, 1.0), "rgba(255, 128, 0, 1.0000)");
        assert_eq!(rgba_to_css(0.0, 0.0, 0.0, 0.5, 0.5), "rgba(0, 0, 0, 0.2500)");
    }

    #[test]
    fn hex_roundtrip() {
        let c = hex_to_rgba("#3FA0C8", 1.0).unwrap();
        assert_eq!(rgba_to_hex(c[0], c[1], c[2]), "3FA0C8");
        assert_eq!(hex_to_rgba("abc", 1.0), hex_to_rgba("#AABBCC", 1.0));
        assert!(hex_to_rgba("nope", 1.0).is_none());
        assert!(hex_to_rgba("12345", 1.0).is_none());
    }

    #[test]
    fn hsv_roundtrip_is_stable() {
        for &(r, g, b) in &[(0.2, 0.7, 0.4), (1.0, 0.0, 0.0), (0.5, 0.5, 0.5), (0.0, 0.3, 0.9)] {
            let (h, s, v) = rgb_to_hsv(r, g, b);
            let (r2, g2, b2) = hsv_to_rgb(h, s, v);
            assert!((r - r2).abs() < 1e-12 && (g - g2).abs() < 1e-12 && (b - b2).abs() < 1e-12);
        }
    }
}
