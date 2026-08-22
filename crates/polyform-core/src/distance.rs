//! Signed Euclidean distance fields — the Rust twin of
//! `src/renderer/src/engine/materials/edt.ts`.
//!
//! Felzenszwalb & Huttenlocher's exact two-pass squared transform, in the
//! same arithmetic order and the same f64 intermediates as the TS reference.
//! Must stay BIT-IDENTICAL to it: the differential fuzz in
//! `wasm-parity.test.ts` compares the two output arrays with exact equality,
//! the contract every twinned module here lives under.

const INF: f64 = 1e20;

/// One 1-D squared-distance pass (the parabola lower envelope).
fn transform_1d(f: &[f64], n: usize, d: &mut [f64], v: &mut [i32], z: &mut [f64]) {
    let mut k: usize = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for q in 1..n {
        let qf = q as f64;
        let mut vk = v[k] as f64;
        let mut s = (f[q] + qf * qf - (f[v[k] as usize] + vk * vk)) / (2.0 * qf - 2.0 * vk);
        while s <= z[k] {
            k -= 1;
            vk = v[k] as f64;
            s = (f[q] + qf * qf - (f[v[k] as usize] + vk * vk)) / (2.0 * qf - 2.0 * vk);
        }
        k += 1;
        v[k] = q as i32;
        z[k] = s;
        z[k + 1] = INF;
    }
    k = 0;
    for q in 0..n {
        while z[k + 1] < q as f64 {
            k += 1;
        }
        let dq = q as f64 - v[k] as f64;
        d[q] = dq * dq + f[v[k] as usize];
    }
}

/// 2-D squared EDT in place: columns, then rows.
fn transform_2d(grid: &mut [f64], width: usize, height: usize) {
    let n = width.max(height);
    let mut f = vec![0.0f64; n];
    let mut d = vec![0.0f64; n];
    let mut v = vec![0i32; n];
    let mut z = vec![0.0f64; n + 1];

    for x in 0..width {
        for y in 0..height {
            f[y] = grid[y * width + x];
        }
        transform_1d(&f, height, &mut d, &mut v, &mut z);
        for y in 0..height {
            grid[y * width + x] = d[y];
        }
    }
    for y in 0..height {
        let row = y * width;
        for x in 0..width {
            f[x] = grid[row + x];
        }
        transform_1d(&f, width, &mut d, &mut v, &mut z);
        for x in 0..width {
            grid[row + x] = d[x];
        }
    }
}

/// mask: width*height coverage bytes, inside = value > 127. Returns f32
/// distances in pixels: negative inside, positive outside.
pub fn signed_distance_field(mask: &[u8], width: usize, height: usize) -> Vec<f32> {
    let size = width * height;
    let mut outside = vec![0.0f64; size];
    let mut inside = vec![0.0f64; size];
    for i in 0..size {
        let solid = mask[i] > 127;
        outside[i] = if solid { 0.0 } else { INF };
        inside[i] = if solid { INF } else { 0.0 };
    }
    transform_2d(&mut outside, width, height);
    transform_2d(&mut inside, width, height);
    let mut out = vec![0.0f32; size];
    for i in 0..size {
        out[i] = (outside[i].sqrt() - inside[i].sqrt()) as f32;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_free_field_is_all_positive_infinityish() {
        let mask = vec![0u8; 16];
        let d = signed_distance_field(&mask, 4, 4);
        assert!(d.iter().all(|&v| v > 1e9));
    }

    #[test]
    fn solid_rect_center_is_most_negative() {
        // 8x8 with a 4x4 solid block in the middle.
        let mut mask = vec![0u8; 64];
        for y in 2..6 {
            for x in 2..6 {
                mask[y * 8 + x] = 255;
            }
        }
        let d = signed_distance_field(&mask, 8, 8);
        // Centre pixels are the deepest inside.
        let center = d[3 * 8 + 3];
        assert!(center < 0.0);
        assert!(d.iter().cloned().fold(f32::INFINITY, f32::min) == center);
        // A far corner is clearly outside and farther than an adjacent pixel.
        assert!(d[0] > d[8 + 1]);
    }
}
