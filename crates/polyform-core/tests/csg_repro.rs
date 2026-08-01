// Repro probe for the fuzz-found 3-child INTERSECT divergence (case 16).
// Ground truth: per-child membership via fine flattening + nonzero winding.

use polyform_core::booleans::{boolean_rings, BoolOp};
use polyform_core::geometry::{
    apply_mat, node_local_matrix, point_in_polygon_rings, vec2, Mat, Vec2,
};
use polyform_core::shapes::{
    ellipse_path, flatten_sub_path, polygon_path, rounded_rect_path, SubPath,
};

fn transform(sp: &SubPath, m: Mat) -> SubPath {
    let mut out = sp.clone();
    for a in &mut out.anchors {
        a.p = apply_mat(m, a.p);
        a.cp_in = a.cp_in.map(|c| apply_mat(m, c));
        a.cp_out = a.cp_out.map(|c| apply_mat(m, c));
    }
    out
}

fn children() -> Vec<SubPath> {
    let e = transform(
        &ellipse_path(210.39229708490893, 219.7389481868595),
        node_local_matrix(
            87.66849264502525,
            117.69110630266368,
            210.39229708490893,
            219.7389481868595,
            57.253798241727054,
        ),
    );
    let r = transform(
        &rounded_rect_path(79.52884296886623, 153.92721193144098, 0.0, 0.0, 0.0, 0.0),
        node_local_matrix(
            4.450154537335038,
            5.353227071464062,
            79.52884296886623,
            153.92721193144098,
            0.0,
        ),
    );
    let p = transform(
        &polygon_path(181.4340677158907, 216.778450619895, 3.0),
        node_local_matrix(
            -30.98589894361794,
            76.16069484502077,
            181.4340677158907,
            216.778450619895,
            60.86340964771807,
        ),
    );
    vec![e, r, p]
}

fn agreement(rings: &[Vec<Vec2>], child_rings: &[Vec<Vec2>], which: &[usize]) -> f64 {
    // sample grid over the union bbox of participating children
    let (mut min_x, mut min_y, mut max_x, mut max_y) =
        (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for &i in which {
        for p in &child_rings[i] {
            min_x = min_x.min(p.x);
            min_y = min_y.min(p.y);
            max_x = max_x.max(p.x);
            max_y = max_y.max(p.y);
        }
    }
    let mut agree = 0usize;
    let mut counted = 0usize;
    let steps = 60;
    for gy in 0..steps {
        for gx in 0..steps {
            let p = vec2(
                min_x + (gx as f64 + 0.5) / steps as f64 * (max_x - min_x),
                min_y + (gy as f64 + 0.5) / steps as f64 * (max_y - min_y),
            );
            // truth: intersection of participating children
            let truth = which.iter().all(|&i| {
                point_in_polygon_rings(p, std::slice::from_ref(&child_rings[i]), false)
            });
            // skip near-edge band
            let near = which.iter().any(|&i| near_edge(p, &child_rings[i], 1.0));
            if near {
                continue;
            }
            counted += 1;
            if point_in_polygon_rings(p, rings, true) == truth {
                agree += 1;
            }
        }
    }
    agree as f64 / counted as f64
}

fn near_edge(p: Vec2, ring: &[Vec2], dist: f64) -> bool {
    let n = ring.len();
    for i in 0..n {
        let a = ring[i];
        let b = ring[(i + 1) % n];
        if polyform_core::geometry::dist_to_segment(p, a, b) <= dist {
            return true;
        }
    }
    false
}

#[test]
fn case16_pairwise_and_threeway() {
    let kids = children();
    let child_rings: Vec<Vec<Vec2>> =
        kids.iter().map(|sp| flatten_sub_path(sp, 0.05)).collect();

    // pairwise intersects
    for (a, b, label) in [(0usize, 1usize, "ellipse∩rect"), (0, 2, "ellipse∩tri"), (1, 2, "rect∩tri")] {
        let rings = boolean_rings(
            &[vec![kids[a].clone()], vec![kids[b].clone()]],
            BoolOp::Intersect,
            0.01,
            0.25,
        );
        let ag = agreement(&rings, &child_rings, &[a, b]);
        println!("{label}: rings={} agreement={:.4}", rings.len(), ag);
    }

    // three-way
    let rings = boolean_rings(
        &[vec![kids[0].clone()], vec![kids[1].clone()], vec![kids[2].clone()]],
        BoolOp::Intersect,
        0.01,
        0.25,
    );
    let ag = agreement(&rings, &child_rings, &[0, 1, 2]);
    println!("three-way: rings={} agreement={:.4}", rings.len(), ag);
    assert!(ag >= 0.99, "three-way agreement {ag}");
}
