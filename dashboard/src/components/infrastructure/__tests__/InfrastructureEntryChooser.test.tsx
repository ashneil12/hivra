/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { InfrastructureEntryChooser } from "../InfrastructureEntryChooser";

function setup(selfHosted = false) {
  const callbacks = { onChooseHivraCloud: jest.fn(), onConnectHetzner: jest.fn(), onConnectExisting: jest.fn() };
  render(<InfrastructureEntryChooser firstConnection hivraCloud={null} selfHosted={selfHosted} {...callbacks} />);
  return callbacks;
}

describe("guided infrastructure paths", () => {
  it("tells a new user what Free includes before any plan is chosen", () => {
    setup();
    expect(screen.getByText(/Start free: 0.5 CPU and 1 GB of Hivra Cloud, enough for one small agent/)).toBeInTheDocument();
    expect(screen.getByText("Free needs no card. Paid plans show their price before payment.")).toBeInTheDocument();
  });

  it("explains generic provider SSH support without invoking connection actions on navigation", () => {
    const callbacks = setup();
    fireEvent.click(screen.getByRole("button", { name: /Choose cloud provider/i }));
    expect(screen.getByText(/AWS, Google Cloud, Azure, DigitalOcean, OVHcloud/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Use an existing server/i }));
    expect(screen.getByRole("heading", { name: "Connect an existing server" })).toHaveFocus();
    const support = screen.getByText("What can this machine run?");
    expect(support.closest("details")).not.toHaveAttribute("open");
    fireEvent.click(support);
    expect(support.closest("details")).toHaveAttribute("open");
    expect(screen.getByText(/do not provide a desktop or Windows/)).toBeVisible();
    expect(screen.getByText(/A cloud VM needs nested KVM/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "Which cloud account do you use?" })).toHaveFocus();
    Object.values(callbacks).forEach((callback) => expect(callback).not.toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /Start with Hetzner/i }));
    expect(callbacks.onConnectHetzner).toHaveBeenCalledTimes(1);
  });

  it("offers DigitalOcean Managed Agents as a no-terminal cloud path only when the page can connect it", () => {
    const onConnectDigitalOcean = jest.fn();
    render(<InfrastructureEntryChooser firstConnection hivraCloud={null} selfHosted={false}
      onChooseHivraCloud={jest.fn()} onConnectHetzner={jest.fn()} onConnectExisting={jest.fn()} onConnectDigitalOcean={onConnectDigitalOcean} />);
    fireEvent.click(screen.getByRole("button", { name: /Choose cloud provider/i }));
    expect(screen.getByRole("heading", { name: "DigitalOcean Managed Agents" })).toBeInTheDocument();
    expect(screen.getByText(/No server to set up and no terminal/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Start with DigitalOcean/i }));
    expect(onConnectDigitalOcean).toHaveBeenCalledTimes(1);
  });

  it("does not show the DigitalOcean path when no connect handler is provided", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /Choose cloud provider/i }));
    expect(screen.queryByRole("heading", { name: "DigitalOcean Managed Agents" })).not.toBeInTheDocument();
  });

  it("blocks the hosted local-network path and offers reachable remote capacity", () => {
    const callbacks = setup();
    fireEvent.click(screen.getByRole("button", { name: /Choose my machine/i }));
    fireEvent.click(screen.getByRole("button", { name: /On my local network/i }));
    expect(screen.getByText("Hosted Hivra cannot connect to your local network.")).toBeInTheDocument();
    expect(screen.getByText(/192.168.x.x or localhost is not reachable/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Connect a server you already have/i })).not.toBeInTheDocument();
    expect(screen.queryByText("Set up local network access")).not.toBeInTheDocument();
    expect(callbacks.onConnectExisting).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Use a remote server instead/i }));
    fireEvent.click(screen.getByRole("button", { name: /Connect a server you already have/i }));
    expect(callbacks.onConnectExisting).toHaveBeenCalledTimes(1);
  });

  // The remote path opens the setup command (slice 13): its checklist asks
  // for a terminal with sudo, not an address, key file and fingerprint.
  it("prepares the owner for the setup command on the remote path", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /Choose my machine/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Remote server/i }));
    expect(screen.getByText(/Ubuntu 22\.04 or 24\.04 on x86, with a public IPv4 address/)).toBeInTheDocument();
    expect(screen.getByText(/as root or a user who can use sudo\. You paste one command there/)).toBeInTheDocument();
    expect(screen.queryByText(/Have a key file ready/)).not.toBeInTheDocument();
    expect(screen.getByText(/The next step also lets you connect with SSH details instead\./)).toBeInTheDocument();
  });

  it("explains explicit self-hosted network opt-in without changing network policy", () => {
    const callbacks = setup(true);
    expect(screen.getByRole("link", { name: /Open Hivra Cloud/i })).toHaveAttribute("href", "https://hivra.cloud/dashboard/infrastructure");
    fireEvent.click(screen.getByRole("button", { name: /Choose my machine/i }));
    fireEvent.click(screen.getByRole("button", { name: /On my local network/i }));
    expect(screen.getByText(/Private network connections require the self-hosted operator’s explicit network opt-in/)).toBeInTheDocument();
    expect(screen.getByText(/localhost address refers to the Hivra server/)).toBeInTheDocument();
    const networkGuide = screen.getByText("Set up local network access");
    expect(networkGuide.closest("details")).not.toHaveAttribute("open");
    fireEvent.click(networkGuide);
    expect(networkGuide.closest("details")).toHaveAttribute("open");
    expect(screen.getByText("HIVRA_INFRA_ALLOW_PRIVATE_NETWORKS=true")).toBeVisible();
    expect(screen.getByText(/Do not use localhost or a loopback address/)).toBeVisible();
    expect(screen.getByText(/does not create a network connection or change your firewall/)).toBeVisible();
    expect(callbacks.onConnectExisting).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "Where is your machine?" })).toHaveFocus();
  });
});
