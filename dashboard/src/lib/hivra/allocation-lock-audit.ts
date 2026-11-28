export function allocationLockAcquired(operation: string, mode: "shared" | "exclusive" = "exclusive", operationId?: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(operation)) throw new Error("Invalid allocation lock operation");
  const id = operationId && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(operationId) ? ` operation_id=${operationId}` : "";
  return `command timeout -k 1 1 logger --socket-errors=off -t hivra-allocation-lock -- "event=acquired mode=${mode} operation=${operation} holder_pid=$BASHPID${id}" </dev/null >/dev/null 2>&1 8>&- 9>&- || :`;
}

export const allocationLockAuditPython = String.raw`
def allocation_lock_acquired(operation):
    import socket
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as log:
            log.setblocking(False)
            message = f"<14>hivra-allocation-lock: event=acquired mode=exclusive operation={operation} holder_pid={os.getpid()}"
            log.sendto(message.encode("ascii"), "/dev/log")
    except OSError:
        pass
`;
