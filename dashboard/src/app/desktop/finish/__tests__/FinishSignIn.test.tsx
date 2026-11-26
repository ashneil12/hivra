/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import { useClerk } from "@clerk/nextjs";
import FinishSignIn from "../FinishSignIn";

jest.mock("@clerk/nextjs", () => ({ useClerk: jest.fn() }));

const create = jest.fn();
const signOut = jest.fn();
const setActive = jest.fn();

function clerkLoaded(session: unknown = null) {
  jest.mocked(useClerk).mockReturnValue({
    loaded: true,
    session,
    signOut,
    setActive,
    client: { signIn: { create } },
  } as never);
}

beforeEach(() => {
  create.mockResolvedValue({ status: "complete", createdSessionId: "sess_new" });
  signOut.mockResolvedValue(undefined);
  setActive.mockResolvedValue(undefined);
  clerkLoaded();
});

it("activates the ticket session through Clerk's decorated navigation", async () => {
  render(<FinishSignIn ticket="ticket_123" />);

  await waitFor(() => expect(create).toHaveBeenCalledWith({ strategy: "ticket", ticket: "ticket_123" }));
  await waitFor(() => expect(setActive).toHaveBeenCalledTimes(1));
  const params = setActive.mock.calls[0][0] as {
    session?: string;
    navigate?: (input: { session: unknown; decorateUrl: (url: string) => string }) => void;
  };
  expect(params.session).toBe("sess_new");
  expect(params.navigate).toEqual(expect.any(Function));

  const decorateUrl = jest.fn((url: string) => `decorated:${url}`);
  const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    params.navigate?.({ session: {}, decorateUrl });
  } finally {
    consoleError.mockRestore();
  }
  expect(decorateUrl).toHaveBeenCalledWith("/dashboard");
  expect(screen.queryByText("That sign-in link has expired")).not.toBeInTheDocument();
});

it("signs out an existing web-view session before using the ticket", async () => {
  clerkLoaded({ id: "sess_old" });
  render(<FinishSignIn ticket="ticket_123" />);

  await waitFor(() => expect(setActive).toHaveBeenCalled());
  expect(signOut).toHaveBeenCalledTimes(1);
  expect(signOut.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0]);
});

it.each([
  ["an incomplete attempt", { status: "needs_identifier", createdSessionId: null }],
  ["a missing session id", { status: "complete", createdSessionId: null }],
])("shows the expired-link recovery for %s", async (_name, attempt) => {
  create.mockResolvedValue(attempt);
  render(<FinishSignIn ticket="ticket_123" />);

  expect(await screen.findByRole("heading", { name: "That sign-in link has expired" })).toBeInTheDocument();
  expect(setActive).not.toHaveBeenCalled();
  expect(screen.getByRole("link", { name: "Sign in here instead" })).toHaveAttribute("href", "/sign-in");
});

it("shows the expired-link recovery when the ticket exchange fails", async () => {
  create.mockRejectedValue(new Error("invalid ticket"));
  render(<FinishSignIn ticket="ticket_123" />);

  expect(await screen.findByRole("heading", { name: "That sign-in link has expired" })).toBeInTheDocument();
  expect(setActive).not.toHaveBeenCalled();
});
