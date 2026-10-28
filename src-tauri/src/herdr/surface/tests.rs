use super::*;
use crate::herdr::wire::{PaneSurfacePane, PaneSurfacePatchRow, SurfaceGraphicsScene, SurfaceRect};

pub(crate) fn cell(symbol: &str) -> CellData {
    CellData {
        symbol: symbol.into(),
        fg: 0,
        bg: 0,
        modifier: 0,
        skip: false,
        hyperlink: None,
    }
}

fn rect(width: u16) -> SurfaceRect {
    SurfaceRect {
        x: 0,
        y: 0,
        width,
        height: 2,
    }
}

pub(crate) fn pane(pane_id: &str, width: u16) -> PaneSurfacePane {
    PaneSurfacePane {
        pane_id: pane_id.into(),
        content_revision: 1,
        rect: rect(width),
        inner_rect: rect(width),
        scrollbar_rect: None,
        scroll: None,
        focused: true,
        mouse_reporting: false,
        sgr_pixel_mouse: false,
        alternate_screen_active: false,
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// A 3x2 grid of `.` on boot `b`, revision 1 of projection 1.
pub(crate) fn surface() -> PaneSurfaceFrame {
    PaneSurfaceFrame {
        boot_id: "b".into(),
        projection_revision: 1,
        surface_revision: 1,
        frame: FrameData {
            cells: (0..6).map(|_| cell(".")).collect(),
            width: 3,
            height: 2,
            cursor: None,
            hyperlinks: Vec::new(),
            graphics: Vec::new(),
        },
        panes: vec![pane("p", 3)],
        splits: Vec::new(),
        popup: None,
        graphics: SurfaceGraphicsScene::default(),
    }
}

pub(crate) fn patch(rows: Vec<PaneSurfacePatchRow>) -> PaneSurfacePatch {
    PaneSurfacePatch {
        boot_id: "b".into(),
        projection_revision: 1,
        base_surface_revision: 1,
        surface_revision: 2,
        rows,
        panes: Vec::new(),
        cursor: None,
    }
}

fn row(x: u16, y: u16, text: &str) -> PaneSurfacePatchRow {
    PaneSurfacePatchRow {
        x,
        y,
        cells: text.chars().map(|c| cell(&c.to_string())).collect(),
    }
}

fn text(surface: &PaneSurfaceFrame) -> String {
    surface
        .frame
        .cells
        .iter()
        .map(|c| c.symbol.as_str())
        .collect()
}

#[test]
fn a_frame_must_fill_its_grid() {
    let mut frame = surface().frame;
    validate(&frame).unwrap();
    frame.cells.pop();
    assert_eq!(validate(&frame), Err(Error::CellCount));
}

#[test]
fn hyperlinks_and_cursor_must_point_inside() {
    let mut frame = surface().frame;
    frame.cells[0].hyperlink = Some(0);
    assert_eq!(validate(&frame), Err(Error::HyperlinkIndex));
    frame.hyperlinks.push("https://example.com".into());
    validate(&frame).unwrap();
    frame.cursor = Some(CursorState {
        x: 3,
        y: 0,
        visible: true,
        shape: 0,
    });
    assert_eq!(validate(&frame), Err(Error::CursorBounds));
    frame.cursor = Some(CursorState {
        x: 3,
        y: 0,
        visible: false,
        shape: 0,
    });
    validate(&frame).unwrap();
}

#[test]
fn a_patch_writes_its_rows_and_advances_the_revision() {
    let mut shown = surface();
    apply(&mut shown, patch(vec![row(1, 0, "ab"), row(0, 1, "c")])).unwrap();
    assert_eq!(text(&shown), ".abc..");
    assert_eq!(shown.surface_revision, 2);
}

#[test]
fn a_patch_for_another_revision_boot_or_projection_is_refused() {
    let mut wrong = vec![patch(Vec::new()); 4];
    wrong[0].boot_id = "other".into();
    wrong[1].base_surface_revision = 0;
    wrong[2].surface_revision = 3;
    wrong[3].projection_revision = 2;
    for patch in wrong {
        let mut shown = surface();
        assert_eq!(apply(&mut shown, patch), Err(Error::PatchIdentity));
        assert_eq!(shown, surface());
    }
}

#[test]
fn a_bad_row_leaves_the_whole_surface_untouched() {
    let mut shown = surface();
    let error = apply(&mut shown, patch(vec![row(0, 0, "ok"), row(2, 1, "xx")]));
    assert_eq!(error, Err(Error::RowBounds));
    assert_eq!(
        shown,
        surface(),
        "the first, valid row must not land either"
    );
    assert_eq!(
        apply(&mut shown, patch(vec![row(0, 2, "x")])),
        Err(Error::RowBounds)
    );
}

#[test]
fn a_patch_cannot_move_a_pane() {
    let mut shown = surface();
    let mut moved = patch(Vec::new());
    moved.panes = vec![pane("p", 2)];
    assert_eq!(apply(&mut shown, moved), Err(Error::PatchGeometry));
    let mut added = patch(Vec::new());
    added.panes = vec![pane("q", 3)];
    assert_eq!(apply(&mut shown, added), Err(Error::PatchGeometry));
}

#[test]
fn no_patch_applies_under_a_popup() {
    let mut shown = surface();
    shown.popup = Some(Box::new(crate::herdr::wire::ClientShellPopupSurface {
        terminal_id: "t".into(),
        title: String::new(),
        width: None,
        height: None,
        frame: surface().frame,
        mouse_reporting: false,
        sgr_pixel_mouse: false,
        pixel_width: 0,
        pixel_height: 0,
    }));
    assert_eq!(
        apply(&mut shown, patch(Vec::new())),
        Err(Error::PatchIdentity)
    );
}
