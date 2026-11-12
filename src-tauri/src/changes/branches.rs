//! A checkout's local branches for the panel's branch list: newest commit
//! first, each with ahead/behind against its upstream, and the ones merged
//! into the default branch that `git branch -d` could delete. Reads only;
//! switching and deleting are in `branch_ops.rs`.

use super::{DEADLINE, Error, checkout_root, default_branch, parse};
use crate::{git, herdr::Target, host_fs};
use parse::Branch;
use serde::Serialize;
use std::time::Instant;

/// Branches listed; the rest are only counted.
const MAX_BRANCHES: usize = 100;

#[derive(Debug, Serialize)]
pub struct BranchesView {
    branches: Vec<Branch>,
    total: usize,
    /// What `merged` was measured against: the remote's default branch, else a
    /// local `main` or `master`.
    base: Option<String>,
    /// Branches merged into `base` that a delete may offer.
    merged: Vec<String>,
}

pub fn read_branches(target: &Target, directory: &str) -> Result<BranchesView, Error> {
    let deadline = host_fs::deadline(target, DEADLINE);
    let root = checkout_root(target, directory, deadline)?;
    let mut branches = local_branches(target, &root, None, deadline)?;
    let base = merge_base(target, &root, deadline);
    let merged = match &base {
        Some(base) => deletable(&local_branches(target, &root, Some(base), deadline)?, base),
        None => Vec::new(),
    };
    let total = branches.len();
    branches.truncate(MAX_BRANCHES);
    Ok(BranchesView {
        branches,
        total,
        base,
        merged,
    })
}

/// Local branches, newest commit first; with `merged_into`, only those whose
/// commits it already holds.
pub fn local_branches(
    target: &Target,
    root: &str,
    merged_into: Option<&str>,
    deadline: Instant,
) -> Result<Vec<Branch>, git::Error> {
    let merged = merged_into.map(|base| format!("--merged={base}"));
    let mut args = vec!["for-each-ref", "--sort=-committerdate", parse::BRANCH_FORMAT];
    args.extend(merged.as_deref());
    args.push("refs/heads");
    Ok(parse::branches(&git::text_on(target, root, &args, "list the branches", deadline)?))
}

/// The branch the others merge into: the remote's default branch as last
/// fetched, else a local `main` or `master`.
pub fn merge_base(target: &Target, root: &str, deadline: Instant) -> Option<String> {
    default_branch(target, root, deadline).or_else(|| {
        ["main", "master"].into_iter().find_map(|name| {
            let reference = format!("refs/heads/{name}");
            git::text_on(
                target,
                root,
                &["rev-parse", "--verify", "--quiet", &reference],
                "find the default branch",
                deadline,
            )
            .ok()
            .map(|_| name.to_owned())
        })
    })
}

/// Of the branches merged into `base`, those a delete may offer: not the one
/// HEAD is on, not one checked out in any worktree, and not the local branch
/// of `base` itself.
pub fn deletable(merged: &[Branch], base: &str) -> Vec<String> {
    let base = base.strip_prefix("origin/").unwrap_or(base);
    merged
        .iter()
        .filter(|branch| !branch.current && branch.worktree.is_none() && branch.name != base)
        .map(|branch| branch.name.clone())
        .collect()
}
