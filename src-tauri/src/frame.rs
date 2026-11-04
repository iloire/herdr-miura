//! Turns each complete surface the client reconstructs into what the webview
//! needs to repaint: the whole grid after a size or boot change, otherwise only
//! the rows whose cells changed. Graphics are not forwarded yet.

use crate::herdr::wire::{
    CellData, ClientShellPopupSize, CursorState, FrameData, PaneSurfaceFrame, PaneSurfacePane,
    PaneSurfaceSplit,
};
use serde::ser::SerializeTuple;
use serde::{Serialize, Serializer};

/// `[symbol, fg, bg, modifier, skip]`, then the cell's OSC 8 link only if it has
/// one: positional, because a full 300x80 grid is 24k of these and field names
/// would triple the payload.
#[derive(Debug, PartialEq)]
pub struct Cell<'a>(&'a str, u32, u32, u16, bool, Option<&'a str>);

impl Serialize for Cell<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut tuple = serializer.serialize_tuple(if self.5.is_some() { 6 } else { 5 })?;
        tuple.serialize_element(self.0)?;
        tuple.serialize_element(&self.1)?;
        tuple.serialize_element(&self.2)?;
        tuple.serialize_element(&self.3)?;
        tuple.serialize_element(&self.4)?;
        if let Some(link) = self.5 {
            tuple.serialize_element(link)?;
        }
        tuple.end()
    }
}

/// The cell with its link read from the frame's table, as each frame numbers
/// its links afresh.
fn cell<'a>(cell: &'a CellData, hyperlinks: &'a [String]) -> Cell<'a> {
    let link = cell.hyperlink.and_then(|index| hyperlinks.get(index as usize));
    Cell(&cell.symbol, cell.fg, cell.bg, cell.modifier, cell.skip, link.map(String::as_str))
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Row<'a> {
    pub y: u16,
    pub cells: Vec<Cell<'a>>,
}

#[derive(Debug, Serialize)]
pub struct Popup<'a> {
    terminal_id: &'a str,
    title: &'a str,
    width: Option<ClientShellPopupSize>,
    height: Option<ClientShellPopupSize>,
    cols: u16,
    rows: Vec<Row<'a>>,
    cursor: Option<&'a CursorState>,
    mouse_reporting: bool,
}

#[derive(Debug, Serialize)]
pub struct FrameUpdate<'a> {
    pub boot_id: &'a str,
    pub surface_revision: u64,
    pub width: u16,
    pub height: u16,
    /// Every row is present and the webview drops what it had.
    pub full: bool,
    pub rows: Vec<Row<'a>>,
    pub cursor: Option<&'a CursorState>,
    pub panes: &'a [PaneSurfacePane],
    pub splits: &'a [PaneSurfaceSplit],
    pub popup: Option<Popup<'a>>,
}

fn rows(frame: &FrameData) -> impl Iterator<Item = (u16, &[CellData])> {
    // `chunks` with a zero width would panic; an empty grid has no rows.
    let width = usize::from(frame.width.max(1));
    (0..frame.height).zip(frame.cells.chunks(width))
}

fn all_rows(frame: &FrameData) -> Vec<Row<'_>> {
    rows(frame)
        .map(|(y, cells)| Row {
            y,
            cells: cells.iter().map(|c| cell(c, &frame.hyperlinks)).collect(),
        })
        .collect()
}

/// The update that brings a webview showing `previous` to `next`.
pub fn update<'a>(previous: Option<&PaneSurfaceFrame>, next: &'a PaneSurfaceFrame) -> FrameUpdate<'a> {
    let base = previous.filter(|previous| {
        previous.boot_id == next.boot_id
            && previous.frame.width == next.frame.width
            && previous.frame.height == next.frame.height
            && previous.frame.cells.len() == next.frame.cells.len()
    });
    let rows = match base {
        None => all_rows(&next.frame),
        Some(base) => rows(&next.frame)
            .zip(rows(&base.frame))
            .filter_map(|((y, now), (_, then))| {
                let cells: Vec<_> = now.iter().map(|c| cell(c, &next.frame.hyperlinks)).collect();
                let same = then.len() == cells.len()
                    && then.iter().zip(&cells).all(|(c, now)| cell(c, &base.frame.hyperlinks) == *now);
                (!same).then_some(Row { y, cells })
            })
            .collect(),
    };
    FrameUpdate {
        boot_id: &next.boot_id,
        surface_revision: next.surface_revision,
        width: next.frame.width,
        height: next.frame.height,
        full: base.is_none(),
        rows,
        cursor: next.frame.cursor.as_ref(),
        panes: &next.panes,
        splits: &next.splits,
        popup: next.popup.as_deref().map(|popup| Popup {
            terminal_id: &popup.terminal_id,
            title: &popup.title,
            width: popup.width,
            height: popup.height,
            cols: popup.frame.width,
            rows: all_rows(&popup.frame),
            cursor: popup.frame.cursor.as_ref(),
            mouse_reporting: popup.mouse_reporting,
        }),
    }
}

#[cfg(test)]
mod tests;
