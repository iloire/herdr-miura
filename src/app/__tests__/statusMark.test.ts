import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusMark } from "../../components/StatusMark";

describe("StatusMark", () => {
  it("draws an agent that needs you in the blocked gold, with what to do on hover", () => {
    const html = renderToStaticMarkup(createElement(StatusMark, { status: "blocked", note: "run deploy.sh prod" }));
    expect(html).toContain("mark-blocked");
    expect(html).toContain('title="Needs you: run deploy.sh prod"');
  });

  it("says plainly that it needs you when no note came", () => {
    expect(renderToStaticMarkup(createElement(StatusMark, { status: "blocked", note: "" }))).toContain('title="Needs you"');
  });
});
