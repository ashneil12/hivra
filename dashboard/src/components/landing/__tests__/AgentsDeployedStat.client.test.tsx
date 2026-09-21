/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import AgentsDeployedStatClient from "../AgentsDeployedStat.client";
import { useAgentsDeployedPolling } from "@/hooks/useAgentsDeployedPolling";
jest.mock("@/hooks/useAgentsDeployedPolling",()=>({useAgentsDeployedPolling:jest.fn()}));
test("relaunch shows one static verified public count without a daily delta or polling",()=>{
 render(<AgentsDeployedStatClient />);
 expect(screen.getByRole("link")).toHaveTextContent("2,034");
 expect(screen.getByRole("link")).not.toHaveTextContent(/today|\+/);
 expect(useAgentsDeployedPolling).not.toHaveBeenCalled();
});
