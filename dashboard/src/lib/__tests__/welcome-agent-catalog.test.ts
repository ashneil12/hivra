import { getWelcomeAgentTypeDefinition } from "../welcome-agent-catalog";

it("keeps Agent Zero computer launch separate from optional model setup", () => {
  const agent = getWelcomeAgentTypeDefinition("agent-zero")!;
  const guidance = [agent.description, ...agent.features, agent.deployCard.summary, ...agent.deployCard.included].join(" ");
  expect(guidance).not.toMatch(/managed model (is )?(seeded|pre-seeded)|works immediately|runs out of the box/i);
  expect(agent.deployCard.summary).toContain("Model access must be configured before you can run a task");
  expect(agent.deployCard.summary).toContain("your own provider in Settings");
});
