import http.client
import socket
from contextlib import closing


class TerminalConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(1)
        self.sock.connect("/tmp/hivra-claude-terminal.sock")


try:
    with closing(TerminalConnection("localhost", timeout=1)) as connection:
        connection.request("GET", "/terminal/")
        raise SystemExit(0 if connection.getresponse().status == 200 else 1)
except (OSError, http.client.HTTPException):
    raise SystemExit(1)
