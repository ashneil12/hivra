export {
  AGENT_COMPUTER_ACTIONS,
  AGENT_COMPUTER_COMMAND_ACTIONS,
  AGENT_COMPUTER_CONTRACT_VERSION,
  AGENT_COMPUTER_DESIRED_STATES,
  AGENT_COMPUTER_HEALTH_STATES,
  AGENT_COMPUTER_OBSERVED_STATES,
  AGENT_COMPUTER_OPERATION_STATES,
  AGENT_COMPUTER_SOURCE_KINDS,
  AGENT_COMPUTER_SURFACES,
  AgentComputerCapabilitiesSchema,
  AgentComputerCommandResultSchema,
  AgentComputerCommandSchema,
  AgentComputerCompatibilitySchema,
  AgentComputerOperationSchema,
  AgentComputerSchema,
  AgentComputerSourceIdentitySchema,
  AgentComputerStateSchema,
} from "./contracts";
export type {
  AgentComputer,
  AgentComputerAction,
  AgentComputerCapabilities,
  AgentComputerCommand,
  AgentComputerCommandAction,
  AgentComputerCommandResult,
  AgentComputerDesiredState,
  AgentComputerHealthState,
  AgentComputerObservedState,
  AgentComputerOperation,
  AgentComputerOperationState,
  AgentComputerSourceIdentity,
  AgentComputerState,
  AgentComputerSurface,
} from "./contracts";

export { projectHermesInstance, projectHivraAgent } from "./projectors";

export {
  createAgentComputerAdapter,
  dispatchAgentComputerCommand,
} from "./dispatcher";
export type {
  AgentComputerAdapter,
  AgentComputerAuthority,
  AgentComputerAuthorityInput,
} from "./dispatcher";

export { createLegacyInstanceAuthority } from "./legacy-instance-authority";
export type { LegacyCreateInstance } from "./legacy-instance-authority";

export {
  CANONICAL_AGENT_COMPUTER_CONTRACT_VERSION,
  CANONICAL_COMPUTER_ACTIONS,
  CanonicalAgentIdentitySchema,
  CanonicalCapacityReferenceSchema,
  CanonicalComputerCapabilitiesSchema,
  CanonicalComputerSchema,
  CanonicalComputerStateSchema,
  CanonicalLegacySourceSchema,
  CanonicalPrimaryAgentBindingSchema,
  CanonicalResourceShadowSchema,
  CanonicalRuntimeInstallationSchema,
  CanonicalSourceMappingSchema,
  legacyComputerAlias,
  projectCanonicalHermesShadow,
  projectCanonicalHivraShadow,
} from "./canonical-shadow";
export type {
  CanonicalAgentIdentity,
  CanonicalComputer,
  CanonicalHermesShadowRecord,
  CanonicalHivraShadowRecord,
  CanonicalPrimaryAgentBinding,
  CanonicalResourceShadow,
  CanonicalRuntimeInstallation,
  CanonicalShadowProjectionOptions,
  CanonicalShadowIds,
  CanonicalSourceMapping,
} from "./canonical-shadow";
