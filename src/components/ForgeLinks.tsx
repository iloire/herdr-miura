import {
  REVIEW_LABEL,
  actionsUrl,
  comparison,
  compareUrl,
  type ForgeStatus,
  type WebRepo,
} from "../changes/forge";
import type { CheckoutChanges } from "../changes/store";

/// A pushed branch's pages on the web: its open pull request, or Create PR
/// when it has none and is ahead of the default branch, the comparison with
/// that branch, and its CI runs. The pull request needs `gh`; without an answer
/// from it, neither the badge nor Create PR shows. Nothing is created from here:
/// Create PR opens the web form.
export function ForgeLinks({
  web,
  checkout,
  branch,
  status,
  open,
}: {
  web: WebRepo;
  checkout: CheckoutChanges;
  branch: string;
  status: ForgeStatus | null;
  open: (url: string) => void;
}) {
  const compared = comparison(checkout);
  const pr = status?.pr ?? null;
  return (
    <div className="forge-line">
      {pr && (
        <button
          className={`forge-pr forge-pr-${pr.draft ? "draft" : "open"}`}
          data-review={pr.review ?? undefined}
          title={`Open pull request #${pr.number}`}
          onClick={() => open(pr.url)}
        >
          #{pr.number}
          <span>{pr.draft ? "draft" : "open"}</span>
          {pr.review && <span>{REVIEW_LABEL[pr.review]}</span>}
        </button>
      )}
      {status && !pr && compared && (
        <button
          className="forge-link"
          title={`Open the form for a pull request of ${branch} into ${compared.base}`}
          onClick={() => open(compareUrl(web, compared.base, compared.branch, true))}
        >
          Create PR
        </button>
      )}
      {compared && (
        <button
          className="forge-link"
          title={`Compare ${branch} with ${compared.base}`}
          onClick={() => open(compareUrl(web, compared.base, compared.branch))}
        >
          Compare
        </button>
      )}
      <button className="forge-link" title={`CI runs of ${branch}`} onClick={() => open(actionsUrl(web, branch))}>
        {web.kind === "gitlab" ? "Pipelines" : "Actions"}
      </button>
    </div>
  );
}
