/** @jest-environment jsdom */
import fs from "fs";
import path from "path";
import React from "react";
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

// The view module reaches the server-only geo modules; only its pure helper is used here.
jest.mock("@/lib/compliance/token-geo-page", () => ({ resolveTokenGeoBlockForPage: jest.fn() }));

import { tokenSurfacesVisible, type TokenSurfaceView } from "@/lib/compliance/token-surface-view";
import TokenSurfaceGateDefault, { TokenSurfaceGate } from "../TokenSurfaceGate";

const SHOWN: TokenSurfaceView = { tokenSurfaces: true, geoBlocked: false };
const SWITCH_OFF: TokenSurfaceView = { tokenSurfaces: false, geoBlocked: false };
const BLOCKED: TokenSurfaceView = { tokenSurfaces: true, geoBlocked: true };

describe("TokenSurfaceGate", () => {
  it("renders its children when the switch is on and the viewer is not blocked", () => {
    render(<TokenSurfaceGate view={SHOWN}><p>Token sentence</p></TokenSurfaceGate>);
    expect(screen.getByText("Token sentence")).toBeInTheDocument();
  });

  it("renders nothing when the switch is off", () => {
    const { container } = render(<TokenSurfaceGate view={SWITCH_OFF}><p>Token sentence</p></TokenSurfaceGate>);
    expect(screen.queryByText("Token sentence")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for a geo-blocked viewer even with the switch on", () => {
    const { container } = render(<TokenSurfaceGate view={BLOCKED}><p>Token sentence</p></TokenSurfaceGate>);
    expect(screen.queryByText("Token sentence")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the fallback in place of hidden children, and only then", () => {
    const { rerender } = render(<TokenSurfaceGate view={BLOCKED} fallback={<p>Plain sentence</p>}><p>Token sentence</p></TokenSurfaceGate>);
    expect(screen.getByText("Plain sentence")).toBeInTheDocument();
    expect(screen.queryByText("Token sentence")).not.toBeInTheDocument();
    rerender(<TokenSurfaceGate view={SHOWN} fallback={<p>Plain sentence</p>}><p>Token sentence</p></TokenSurfaceGate>);
    expect(screen.getByText("Token sentence")).toBeInTheDocument();
    expect(screen.queryByText("Plain sentence")).not.toBeInTheDocument();
  });

  it("agrees with tokenSurfacesVisible for every combination, so metadata and markup cannot disagree", () => {
    for (const tokenSurfaces of [true, false]) {
      for (const geoBlocked of [true, false]) {
        const view = { tokenSurfaces, geoBlocked };
        const { container, unmount } = render(<TokenSurfaceGate view={view}><span>shown</span></TokenSurfaceGate>);
        expect({ view, rendered: container.textContent === "shown" }).toEqual({ view, rendered: tokenSurfacesVisible(view) });
        unmount();
      }
    }
  });

  it("is also the default export", () => {
    expect(TokenSurfaceGateDefault).toBe(TokenSurfaceGate);
  });

  it("imports only a type from the server-side view, so a client bundle never pulls in next/headers", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "TokenSurfaceGate.tsx"), "utf8");
    const imports = [...source.matchAll(/^import\s+(type\s+)?[^;]*from\s+"([^"]+)";/gm)];
    const fromView = imports.filter((match) => match[2] === "@/lib/compliance/token-surface-view");
    expect(fromView.length).toBeGreaterThan(0);
    for (const match of fromView) expect(match[1]).toBeTruthy();
    expect(imports.map((match) => match[2]).filter((specifier) => /token-geo|next\/headers/.test(specifier))).toEqual([]);
  });
});
