use super::*;
use crate::herdr::wire::SurfaceGraphicsScene;

fn cell(symbol: &str) -> CellData {
    CellData {
        symbol: symbol.into(),
        fg: 0,
        bg: 0,
        modifier: 0,
        skip: false,
        hyperlink: None,
    }
}

fn surface(boot_id: &str, width: u16, text: &str) -> PaneSurfaceFrame {
    let cells: Vec<_> = text.chars().map(|c| cell(&c.to_string())).collect();
    let height = cells.len().checked_div(usize::from(width)).unwrap_or(0) as u16;
    PaneSurfaceFrame {
        boot_id: boot_id.into(),
        projection_revision: 1,
        surface_revision: 1,
        frame: FrameData {
            cells,
            width,
            height,
            cursor: None,
            hyperlinks: Vec::new(),
            graphics: Vec::new(),
        },
        panes: Vec::new(),
        splits: Vec::new(),
        popup: None,
        graphics: SurfaceGraphicsScene::default(),
    }
}

fn row_ys(update: &FrameUpdate<'_>) -> Vec<u16> {
    update.rows.iter().map(|row| row.y).collect()
}

#[test]
fn first_frame_sends_every_row() {
    let next = surface("a", 2, "abcdef");
    let update = update(None, &next);
    assert!(update.full);
    assert_eq!(row_ys(&update), [0, 1, 2]);
    assert_eq!(update.rows[1].cells, [Cell("c", 0, 0, 0, false), Cell("d", 0, 0, 0, false)]);
}

#[test]
fn unchanged_rows_are_left_out() {
    let previous = surface("a", 2, "abcdef");
    let next = surface("a", 2, "abXdef");
    let update = update(Some(&previous), &next);
    assert!(!update.full);
    assert_eq!(row_ys(&update), [1]);
}

#[test]
fn identical_frame_sends_no_rows() {
    let previous = surface("a", 2, "abcd");
    let update = update(Some(&previous), &previous);
    assert!(!update.full);
    assert!(update.rows.is_empty());
}

#[test]
fn resize_resends_everything() {
    let previous = surface("a", 2, "abcd");
    let next = surface("a", 4, "abcd");
    let update = update(Some(&previous), &next);
    assert!(update.full);
    assert_eq!(row_ys(&update), [0]);
}

#[test]
fn new_boot_resends_everything() {
    // A restarted daemon's grid is unrelated to the old one, even at one size.
    let previous = surface("a", 2, "abcd");
    let next = surface("b", 2, "abcd");
    assert!(update(Some(&previous), &next).full);
}

#[test]
fn empty_grid_has_no_rows() {
    let next = surface("a", 0, "");
    assert!(update(None, &next).rows.is_empty());
}

#[test]
fn cells_serialize_positionally() {
    let json = serde_json::to_string(&Cell("x", 1, 2, 3, true)).unwrap_or_default();
    assert_eq!(json, r#"["x",1,2,3,true]"#);
}
