//! Static R-tree over world-space AABBs — the Rust twin of
//! `src/renderer/src/engine/spatial-index.ts` (rbush). The scene walk that
//! collects entries stays host-side; this holds the tree and answers
//! intersection queries.
//!
//! Parity notes vs rbush:
//! - both use inclusive (<=) edge-touching intersection;
//! - result ORDER is unspecified in both — we sort ascending by entry index
//!   so output is deterministic; callers treat results as a set;
//! - query boxes must be normalized (min <= max): rstar would silently
//!   normalize inverted corners where rbush does not.

use rstar::primitives::{GeomWithData, Rectangle};
use rstar::{RTree, AABB};

type Entry = GeomWithData<Rectangle<[f64; 2]>, u32>;

#[derive(Default)]
pub struct SpatialIndex {
    tree: RTree<Entry>,
}

impl SpatialIndex {
    pub fn new() -> Self {
        Self { tree: RTree::new() }
    }

    /// Bulk-load from [minX, minY, maxX, maxY]* — entry id = chunk position.
    /// A trailing partial chunk is ignored.
    pub fn load(&mut self, boxes: &[f64]) {
        let entries: Vec<Entry> = boxes
            .chunks_exact(4)
            .enumerate()
            .map(|(i, c)| {
                GeomWithData::new(Rectangle::from_corners([c[0], c[1]], [c[2], c[3]]), i as u32)
            })
            .collect();
        self.tree = RTree::bulk_load(entries);
    }

    pub fn search(&self, min_x: f64, min_y: f64, max_x: f64, max_y: f64) -> Vec<u32> {
        if min_x > max_x || min_y > max_y {
            return Vec::new();
        }
        let env = AABB::from_corners([min_x, min_y], [max_x, max_y]);
        let mut out: Vec<u32> =
            self.tree.locate_in_envelope_intersecting(&env).map(|e| e.data).collect();
        out.sort_unstable();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inclusive_edge_touch_matches_rbush() {
        let mut idx = SpatialIndex::new();
        // one box [0,0,10,10]
        idx.load(&[0.0, 0.0, 10.0, 10.0]);
        // touching at x=10 counts (rbush uses <=)
        assert_eq!(idx.search(10.0, 5.0, 20.0, 6.0), vec![0]);
        // fully outside
        assert!(idx.search(10.1, 5.0, 20.0, 6.0).is_empty());
    }

    #[test]
    fn bulk_load_and_query() {
        let mut idx = SpatialIndex::new();
        let mut boxes = Vec::new();
        for i in 0..100 {
            let x = (i % 10) as f64 * 20.0;
            let y = (i / 10) as f64 * 20.0;
            boxes.extend_from_slice(&[x, y, x + 10.0, y + 10.0]);
        }
        idx.load(&boxes);
        let hits = idx.search(0.0, 0.0, 30.0, 30.0);
        assert_eq!(hits, vec![0, 1, 10, 11]);
    }
}
