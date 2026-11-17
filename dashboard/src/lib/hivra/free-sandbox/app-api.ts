/**
 * What the bridge needs from the agent app's operator API. An interface only, until the app's contract is fixed;
 * the bridge is written against this so a fake can stand in for tests and the real client lands later.
 */

/** One workspace waiting for a computer. */
export interface MachineRequest {
  orgId: string;
  /** The workspace owner's verified email (the bridge maps it to a Hivra account). */
  ownerEmail: string | null;
  createdAt: string;
}

export type ComputerState = "preparing" | "waiting" | "problem" | "ready" | "stored" | "restoring";

export interface ProvisioningReport {
  state: ComputerState;
  step?: string;
  reason?: "capacity" | "server_unavailable";
  /** When a stored computer is expected back. */
  expectedReadyAt?: string;
}

export interface AppEvent {
  kind: "machine.wake_wanted" | "machine.person_activity" | string;
  orgId: string;
  machineId?: string;
  at: string;
}

export interface CapacitySignal {
  open: boolean;
  placesLeft: number;
}

export interface AppProvisioningApi {
  listMachineRequests(cursor?: string): Promise<{ requests: MachineRequest[]; next: string | null }>;
  reportProvisioning(orgId: string, report: ProvisioningReport): Promise<void>;
  /** A single-use enroll code for the workspace's managed computer. Never logged. */
  issueEnrollCode(orgId: string): Promise<{ machineId: string; enrollCode: string; expiresAt: string }>;
  removeMachine(orgId: string, machineId: string): Promise<void>;
  /** The last time a person (not a scheduled job) used the computer. */
  personActivityAt(orgId: string, machineId: string): Promise<Date | null>;
  listEvents(cursor?: string): Promise<{ events: AppEvent[]; next: string | null }>;
  setCapacity(signal: CapacitySignal): Promise<void>;
}
