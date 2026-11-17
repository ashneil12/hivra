/**
 * What the free sandbox bridge needs from Hivra's own side, as interfaces: the pool servers, the gVisor adapter on
 * each, the archive storage, the account directory and the bridge's own records (the `free_sandbox_*` tables). The
 * bridge is written against these so tests run it whole against fakes; the real ones are wired where it is deployed.
 */

/** One pool server as the bridge places on it. Counts of free people come from the bridge's own records. */
export interface PoolServer {
  id: string;
  /** Cores the free pool may use on it (the base the CPU overcommit multiplies). */
  cpus: number;
  /** The server still has room for the paid reserve after one more free person. */
  paidReserveIntact: boolean;
  /** A paid computer waits for room here: Free takes nobody new. */
  paidWaiting: boolean;
}

/** A sandbox as the adapter names it: its own ids and its owner's digest, never a person's details. */
export interface SandboxRef {
  sandboxId: string;
  computerId: string;
  ownerHash: string;
}

/** What one free sandbox gets (from the free settings). */
export interface SandboxSpec {
  cpus: number;
  memoryMb: number;
  storageMb: number;
  cpuOvercommit: number;
}

/** The gVisor adapter's operations on one pool server (`hivra-gvisor-adapter.py`, `sandboxClass: "free"`). */
export interface SandboxHost {
  create(serverId: string, sandbox: SandboxRef, spec: SandboxSpec): Promise<void>;
  start(serverId: string, sandbox: SandboxRef, spec: SandboxSpec): Promise<void>;
  stop(serverId: string, sandbox: SandboxRef): Promise<void>;
  /** The code reaches the adapter's input only; it is never logged or kept. */
  enroll(serverId: string, sandbox: SandboxRef, enrollCode: string, serverUrl: string): Promise<void>;
  /** A stopped sandbox's workspace as a local archive, read back and checked. */
  pack(serverId: string, sandbox: SandboxRef): Promise<{ sha256: string; bytes: number }>;
  /** Removes the sandbox and its local archive, only when that archive still reads back to `sha256`. */
  release(serverId: string, sandbox: SandboxRef, sha256: string): Promise<void>;
  /** Back from an archive already on this server, checked against `sha256` first; it comes back stopped. */
  restore(serverId: string, sandbox: SandboxRef, spec: SandboxSpec, sha256: string): Promise<void>;
  /** Erasure only (the person deleted their account or workspace, or moved to a paid computer). */
  remove(serverId: string, sandbox: SandboxRef): Promise<void>;
}

export interface ArchiveCopy {
  location: string;
  sha256: string;
  bytes: number;
}

/** Off-server storage for packed sandboxes. */
export interface ArchiveStore {
  /** Copies the server's local archive into storage and reads it back there; resolves only once it matches. */
  upload(serverId: string, sandbox: SandboxRef, sha256: string): Promise<ArchiveCopy>;
  /** Puts a stored archive on a server for `restore`, checked against its digest. */
  fetch(serverId: string, sandbox: SandboxRef, copy: ArchiveCopy): Promise<void>;
  /** Erasure, or a copy a newer verified one replaced. */
  erase(copy: ArchiveCopy): Promise<void>;
}

/** Hivra's accounts, by a verified address only. */
export interface AccountDirectory {
  hivraUserIdForEmail(email: string): Promise<string | null>;
}

export type PlacementState = "placing" | "awake" | "stopped" | "packing" | "packed" | "restoring" | "flagged";

/** One free workspace's sandbox, as the bridge records it. Nothing about the person beyond the workspace id. */
export interface Placement {
  orgId: string;
  sandbox: SandboxRef;
  /** The app's id for the workspace's computer, once issued. */
  machineId: string | null;
  /** Where it is now; null while packed. */
  serverId: string | null;
  state: PlacementState;
  placedAt: Date;
  stateAt: Date;
  /** The verified copy in storage, once packed at least once. */
  archive: ArchiveCopy | null;
  /** Why it is flagged (a failed step), for an operator; never a code or a token. */
  problem: string | null;
}

/** The bridge's own records (`free_sandbox_placements`, `free_sandbox_wakes`, `free_sandbox_state`). */
export interface BridgeStore {
  servers(): Promise<PoolServer[]>;
  placement(orgId: string): Promise<Placement | null>;
  placements(): Promise<Placement[]>;
  save(placement: Placement): Promise<void>;
  remove(orgId: string): Promise<void>;
  /** The events feed's cursor. */
  cursor(): Promise<string | null>;
  setCursor(cursor: string | null): Promise<void>;
  /** Wakes that wait for room, oldest first. */
  wakes(): Promise<{ orgId: string; wantedAt: Date }[]>;
  addWake(orgId: string, wantedAt: Date): Promise<void>;
  removeWake(orgId: string): Promise<void>;
  /** A server's free replies on one UTC day (`YYYY-MM-DD`). */
  aiDay(serverId: string, day: string): Promise<{ answered: number; refused: number; failed: number }>;
  countAi(serverId: string, day: string, kind: "answered" | "refused" | "failed"): Promise<void>;
  /** Workspaces told to wait for a place. */
  waitlist(): Promise<string[]>;
  setWaitlisted(orgId: string, waiting: boolean): Promise<void>;
}
