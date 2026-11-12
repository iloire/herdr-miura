import { Fragment, useEffect, useRef, type CSSProperties, type MouseEvent, type MutableRefObject } from "react";
import type { ChangedFile, RecentCommit } from "../changes/store";
import { formatMoment } from "../app/time";
import { authorHue, groupByDay, initials, lineBar, rowTime } from "../changes/commitRows";
import { MAX_REF_LABELS, refLabels } from "../changes/refLabels";
import { CHECKS_LABEL, type Checks } from "../changes/forge";

const MARK_LABEL: Record<string, string> = {
  "?": "Untracked",
  A: "Added",
  D: "Deleted",
  M: "Modified",
  R: "Renamed",
  U: "Conflicted",
};

export function FileRow({
  file,
  current,
  onOpen,
  onMenu,
  tick,
}: {
  file: ChangedFile;
  current: boolean;
  onOpen: () => void;
  /// A commit's own files have nothing to act on, so they have no menu.
  onMenu?: (event: MouseEvent) => void;
  /// The row's tick box, where it can be committed.
  tick?: { checked: boolean; onChange: () => void };
}) {
  return (
    <li className={tick ? "file-tickable" : undefined}>
      {tick && (
        <input
          type="checkbox"
          className="file-tick"
          aria-label={`Include ${file.path} in the commit`}
          checked={tick.checked}
          onChange={tick.onChange}
        />
      )}
      <button
        className="file"
        aria-current={current ? "true" : undefined}
        onClick={onOpen}
        onContextMenu={onMenu}
        title={`${MARK_LABEL[file.mark] ?? file.mark}: ${file.path}`}
      >
        <span className={`mark mark-${file.mark === "?" ? "untracked" : file.mark}`}>{file.mark}</span>
        <span className="file-name">
          <span className="base">{file.path.split("/").pop()}</span>
          <span className="dir">{file.path.split("/").slice(0, -1).join("/")}</span>
        </span>
        {file.additions !== null && (
          <span className="lines">
            <span className="plus">+{file.additions}</span> <span className="minus">−{file.deletions}</span>
          </span>
        )}
      </button>
    </li>
  );
}

/// What every list of commits shares: the one open, and the pick. `listed`
/// holds the list it was picked from, for stepping along it.
export interface CommitRows {
  openCommit: string | null;
  listed: MutableRefObject<RecentCommit[]>;
  onToggle: (commit: RecentCommit) => void;
  onMenu: (commit: RecentCommit, event: MouseEvent) => void;
}

/// Commits as one-line rows under day separators. Each row has its author's
/// initials, since several machines and agents commit to one checkout, its
/// branches and tags, and a bar of the lines it changed. Picking one opens it in
/// the main area. `checks` marks one commit with its CI state.
export function CommitList({
  commits,
  rows,
  checks,
}: {
  commits: RecentCommit[];
  rows: CommitRows;
  checks?: { sha: string; state: Checks };
}) {
  const { openCommit, listed, onToggle, onMenu } = rows;
  const openRow = useRef<HTMLButtonElement>(null);
  const holdsOpen = commits.some((commit) => commit.sha === openCommit);
  useEffect(() => {
    if (holdsOpen) listed.current = commits;
  }, [holdsOpen, commits, listed]);
  // Arrow keys step from the main area, so the row must follow them here.
  useEffect(() => openRow.current?.scrollIntoView({ block: "nearest" }), [openCommit]);
  const groups = groupByDay(commits, new Date());
  return (
    <ul className="commit-list">
      {groups.map((group, index) => (
        <Fragment key={`${index}-${group.day}`}>
          <li className="commit-day" role="presentation">
            {group.day}
          </li>
          {group.commits.map((commit) => {
            const open = openCommit === commit.sha;
            const labels = refLabels(commit.refs);
            const names = labels.filter((label) => label.kind !== "tag");
            const tags = labels.filter((label) => label.kind === "tag");
            // A tag takes one of the label places, so the subject keeps its room.
            const shownNames = names.slice(0, tags.length > 0 ? MAX_REF_LABELS - 1 : MAX_REF_LABELS);
            const hidden = names.length - shownNames.length + Math.max(0, tags.length - 1);
            const bar = lineBar(commit.additions, commit.deletions);
            return (
              <li key={commit.sha}>
                <button
                  ref={open ? openRow : undefined}
                  className="commit"
                  aria-current={open ? "true" : undefined}
                  onClick={() => onToggle(commit)}
                  onContextMenu={(event) => onMenu(commit, event)}
                  title={[
                    commit.sha,
                    `${commit.author}, ${formatMoment(commit.time * 1000)}`,
                    commit.additions !== null ? `+${commit.additions} −${commit.deletions}` : "",
                    ...commit.refs.map((ref) => ref.name),
                  ]
                    .filter(Boolean)
                    .join("\n")}
                >
                  <span
                    className="author"
                    style={{ "--author-hue": authorHue(commit.author) } as CSSProperties}
                    aria-label={commit.author}
                  >
                    {initials(commit.author)}
                  </span>
                  <span className="sha">{commit.short}</span>
                  <span className="subject">
                    {shownNames.map((label) => (
                      <span key={label.name} className={`commit-ref commit-ref-${label.kind}`} data-current={label.current}>
                        {label.name}
                        {label.remotes.map((remote) => (
                          <span key={remote} className="commit-ref-also">
                            {remote}
                          </span>
                        ))}
                      </span>
                    ))}
                    {tags[0] && <span className="commit-ref commit-ref-tag">{tags[0].name}</span>}
                    {hidden > 0 && <span className="commit-ref">+{hidden}</span>}
                    {commit.subject}
                  </span>
                  {checks?.sha === commit.sha && (
                    <span className={`ci ci-${checks.state}`} role="img" aria-label={CHECKS_LABEL[checks.state]} title={CHECKS_LABEL[checks.state]} />
                  )}
                  <span className="line-bar" aria-hidden="true">
                    {bar && (
                      <>
                        <span className="line-bar-plus" style={{ width: bar.plus }} />
                        <span className="line-bar-minus" style={{ width: bar.minus }} />
                      </>
                    )}
                  </span>
                  <span className="when">{rowTime(commit.time, group.day)}</span>
                </button>
              </li>
            );
          })}
        </Fragment>
      ))}
    </ul>
  );
}
