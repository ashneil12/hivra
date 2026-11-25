/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { HolderSwitchNotice } from "@/components/claim/HolderSwitchNotice";
import WalletLayout from "../layout";

jest.mock("@/components/claim/HolderSwitchNotice", () => ({ HolderSwitchNotice: jest.fn() }));

it("renders the shared holder notice alongside the wallet", () => {
  (HolderSwitchNotice as jest.Mock).mockImplementation(() => <aside>Holder access</aside>);
  render(<WalletLayout><h1>Wallet</h1></WalletLayout>);
  expect(screen.getByRole("complementary")).toHaveTextContent("Holder access");
  expect(screen.getByRole("heading", { name: "Wallet" })).toBeVisible();
});

it("shows the wallet immediately while the holder check is pending", () => {
  const pending = new Promise(() => {});
  (HolderSwitchNotice as jest.Mock).mockImplementation(() => { throw pending; });
  render(<WalletLayout><h1>Wallet</h1></WalletLayout>);
  expect(screen.getByRole("heading", { name: "Wallet" })).toBeVisible();
  expect(screen.queryByRole("complementary")).toBeNull();
});
