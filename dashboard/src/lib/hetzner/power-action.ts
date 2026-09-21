import { z } from "zod";

const Id = z.number().int().positive().safe();
export const HetznerPowerKind = z.enum(["start", "stop", "restart"]);
export type HetznerPowerKind = z.infer<typeof HetznerPowerKind>;
export const HetznerPowerRequest = z.object({ serverId: Id, kind: HetznerPowerKind }).strict();
export const HetznerPowerObservation = HetznerPowerRequest.extend({ actionId: Id });

export const HETZNER_POWER_ACTIONS = {
  start: { path: "poweron", command: "start_server" },
  stop: { path: "shutdown", command: "shutdown_server" },
  restart: { path: "reboot", command: "reboot_server" },
} as const;

const Action = z.object({
  id: Id,
  command: z.enum(["start_server", "shutdown_server", "reboot_server"]),
  status: z.enum(["running", "success", "error"]),
  resources: z.array(z.object({ id: Id, type: z.literal("server") })).length(1),
});
export type HetznerPowerAction = z.infer<typeof Action>;

/** Retain only the exact original action identity, never provider messages or
 * percentages. Even a terminal ACPI acknowledgement is not proof of shutdown
 * or reboot: the lifecycle coordinator must separately observe the computer.
 */
export function parseHetznerPowerAction(raw: unknown, expected: z.infer<typeof HetznerPowerRequest> & { actionId?: number }): HetznerPowerAction {
  const request = HetznerPowerRequest.parse({ serverId: expected.serverId, kind: expected.kind });
  const action = Action.parse(raw);
  if ((expected.actionId !== undefined && action.id !== Id.parse(expected.actionId))
    || action.command !== HETZNER_POWER_ACTIONS[request.kind].command
    || action.resources[0].id !== request.serverId) throw new Error("Provider power action identity changed");
  return action;
}
