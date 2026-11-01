//! Clearing an agent's outcome by hand, for a note dealt with outside its
//! session, so no prompt will clear it.
//!
//! Herdr does not advertise `pane.report_metadata` to GUI clients, so this runs
//! the `herdr` CLI. Herdr keeps a pane's metadata per source, so it has to speak
//! as `herdr-outcome`, the external script that reported the token.

use crate::tab_move::{Error, checked, herdr, run};

fn clear_args(pane: &str) -> [&str; 7] {
    [
        "pane",
        "report-metadata",
        pane,
        "--source",
        "herdr-outcome",
        "--clear-token",
        "attn_outcome",
    ]
}

/// Drops the outcome of each of `panes`. Blocking: run off the main thread.
pub fn clear(panes: &[String]) -> Result<(), Error> {
    for pane in panes {
        checked(pane)?;
    }
    let cli = herdr()?;
    for pane in panes {
        run(&cli, &clear_args(pane))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_clears_as_the_source_that_reported_the_token() {
        assert_eq!(
            clear_args("w1:p2"),
            ["pane", "report-metadata", "w1:p2", "--source", "herdr-outcome", "--clear-token", "attn_outcome"],
        );
    }

    #[test]
    fn a_pane_id_that_could_be_an_option_is_refused() {
        assert!(matches!(clear(&["--source".to_owned()]), Err(Error::InvalidId(_))));
    }
}
