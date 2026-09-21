/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import SourceLink from "../SourceLink";

const published = { status: "published" as const, href: "https://github.com/example/verified-project" as const };

test("the unverified public repository stays disabled without an invented star count or private URL", () => {
  const { container } = render(<SourceLink />);
  expect(screen.getByRole("button", { name: "GitHub public repository coming soon" })).toBeDisabled();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
  expect(container.textContent).toBe("GitHubSoon");
  expect(container.querySelector("svg")).toHaveAttribute("viewBox", "0 0 98 96");
});

test("a verified repository works when the API star count is unavailable", () => {
  render(<SourceLink repository={{ ...published, stars: null }} />);
  const link = screen.getByRole("link", { name: "Hivra on GitHub" });
  expect(link).toHaveAttribute("href", published.href);
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
  expect(link).toHaveTextContent(/^GitHub$/);
});

test.each([0, 1432])("a verified snapshot of %i stars is rendered, including a real zero", (count) => {
  render(<SourceLink repository={{ ...published, stars: { count, checkedAt: "2026-09-09T12:00:00Z" } }} />);
  const link = screen.getByRole("link", { name: `Hivra on GitHub, ${count.toLocaleString("en-US")} stars` });
  expect(link).toHaveAttribute("title", "GitHub stars checked 2026-09-09");
});

test.each([
  { count: -1, checkedAt: "2026-09-09" },
  { count: Number.NaN, checkedAt: "2026-09-09" },
  { count: 12, checkedAt: "invalid" },
])("invalid star metadata never becomes a public count", (stars) => {
  render(<SourceLink repository={{ ...published, stars }} />);
  expect(screen.getByRole("link", { name: "Hivra on GitHub" })).toHaveTextContent(/^GitHub$/);
});
