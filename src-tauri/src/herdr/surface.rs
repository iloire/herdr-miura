//! What makes a surface safe to show: a grid whose cells, hyperlinks, and
//! cursor agree with its size, and patches that apply whole or not at all.

use super::wire::{CellData, CursorState, FrameData, PaneSurfaceFrame, PaneSurfacePatch};

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("a frame's cells do not fill its grid")]
    CellCount,
    #[error("a cell names a hyperlink the frame does not have")]
    HyperlinkIndex,
    #[error("the cursor is outside the grid")]
    CursorBounds,
    #[error("a patch is not the next revision of the surface on screen")]
    PatchIdentity,
    #[error("a patch row is outside the grid")]
    RowBounds,
    #[error("a patch moves or adds a pane")]
    PatchGeometry,
}

fn hyperlinks_fit(cells: &[CellData], hyperlinks: usize) -> bool {
    cells.iter().all(|cell| {
        cell.hyperlink
            .is_none_or(|index| (index as usize) < hyperlinks)
    })
}

fn cursor_fits(cursor: Option<&CursorState>, width: u16, height: u16) -> bool {
    cursor.is_none_or(|c| !c.visible || (c.x < width && c.y < height))
}

pub fn validate(frame: &FrameData) -> Result<(), Error> {
    if frame.cells.len() != usize::from(frame.width) * usize::from(frame.height) {
        return Err(Error::CellCount);
    }
    if !hyperlinks_fit(&frame.cells, frame.hyperlinks.len()) {
        return Err(Error::HyperlinkIndex);
    }
    if !cursor_fits(frame.cursor.as_ref(), frame.width, frame.height) {
        return Err(Error::CursorBounds);
    }
    Ok(())
}

pub fn validate_surface(surface: &PaneSurfaceFrame) -> Result<(), Error> {
    validate(&surface.frame)?;
    surface
        .popup
        .as_ref()
        .map_or(Ok(()), |popup| validate(&popup.frame))
}

/// Applies `patch` to `surface`, or leaves it untouched and says why. A patch
/// is only for the revision right after the one shown, on the same boot and
/// projection, and never while a popup covers the grid; those arrive whole.
pub fn apply(surface: &mut PaneSurfaceFrame, patch: PaneSurfacePatch) -> Result<(), Error> {
    if patch.boot_id != surface.boot_id
        || patch.projection_revision != surface.projection_revision
        || patch.base_surface_revision != surface.surface_revision
        || surface.surface_revision.checked_add(1) != Some(patch.surface_revision)
        || surface.popup.is_some()
    {
        return Err(Error::PatchIdentity);
    }
    let frame = &surface.frame;
    for row in &patch.rows {
        if row.y >= frame.height || usize::from(row.x) + row.cells.len() > usize::from(frame.width)
        {
            return Err(Error::RowBounds);
        }
        if !hyperlinks_fit(&row.cells, frame.hyperlinks.len()) {
            return Err(Error::HyperlinkIndex);
        }
    }
    // A patch updates panes in place; a new layout comes as a whole surface.
    if !patch.panes.iter().all(|pane| {
        surface.panes.iter().any(|p| {
            p.pane_id == pane.pane_id && p.rect == pane.rect && p.inner_rect == pane.inner_rect
        })
    }) {
        return Err(Error::PatchGeometry);
    }
    if !cursor_fits(patch.cursor.as_ref(), frame.width, frame.height) {
        return Err(Error::CursorBounds);
    }
    let width = usize::from(surface.frame.width);
    for row in patch.rows {
        let start = usize::from(row.y) * width + usize::from(row.x);
        surface.frame.cells[start..start + row.cells.len()].clone_from_slice(&row.cells);
    }
    for pane in patch.panes {
        if let Some(existing) = surface.panes.iter_mut().find(|p| p.pane_id == pane.pane_id) {
            *existing = pane;
        }
    }
    surface.frame.cursor = patch.cursor;
    surface.surface_revision = patch.surface_revision;
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
pub(crate) mod tests;
