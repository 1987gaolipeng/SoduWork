"""Bounded TCP ONC RPC transport for the MIT pyNfsClient NFSv3 codecs.

The upstream RPC transport is deliberately unused: it retries privileged binds
indefinitely, swallows network exceptions and does not handle partial reads.
"""
import secrets
import socket
import struct
import time

from pyNfsClient import NFSv3
from pyNfsClient.pack import nfs_pro_v3Packer, nfs_pro_v3Unpacker
from pyNfsClient.rtypes import nfs_fh3, write3args

PORTMAPPER_PORT = 111
MAX_RECORD = 2 * 1024 * 1024
MAX_FRAGMENTS = 256


def opaque(value):
    return struct.pack("!I", len(value)) + value + b"\0" * (-len(value) % 4)


class ProtocolError(OSError):
    pass


class MountError(OSError):
    def __init__(self, status):
        super().__init__("NFS mountd rejected the export request")
        self.status = status


class AuthenticationError(PermissionError):
    pass


class Rpc:
    def __init__(self, host, port, timeout, uid, gid):
        self.timeout, self.uid, self.gid = timeout, uid, gid
        self.socket = socket.create_connection((host, port), timeout=timeout)

    def close(self):
        if self.socket is not None:
            self.socket.close()
            self.socket = None

    def _exact(self, count, deadline):
        data = bytearray()
        while len(data) < count:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("NFS RPC deadline exceeded")
            self.socket.settimeout(remaining)
            chunk = self.socket.recv(count - len(data))
            if not chunk:
                raise ProtocolError("NFS RPC connection closed before complete reply")
            data.extend(chunk)
        return bytes(data)

    def request(self, program, version, procedure, payload=b"", timeout=None):
        if self.socket is None:
            raise ProtocolError("NFS RPC connection is closed")
        xid = secrets.randbits(32)
        machine = b"soduwork-library"
        auth = struct.pack("!I", int(time.time()) & 0xffffffff) + opaque(machine)
        auth += struct.pack("!3I", self.uid, self.gid, 0)
        call = struct.pack("!6I", xid, 0, 2, program, version, procedure)
        call += struct.pack("!I", 1) + opaque(auth) + struct.pack("!2I", 0, 0) + payload
        if len(call) > MAX_RECORD:
            raise ProtocolError("NFS RPC request too large")
        deadline = time.monotonic() + (self.timeout if timeout is None else timeout)
        try:
            self.socket.settimeout(max(.001, deadline - time.monotonic()))
            self.socket.sendall(struct.pack("!I", len(call) | 0x80000000) + call)
            data = bytearray()
            for _ in range(MAX_FRAGMENTS):
                header = struct.unpack("!I", self._exact(4, deadline))[0]
                length = header & 0x7fffffff
                if len(data) + length > MAX_RECORD:
                    raise ProtocolError("NFS RPC reply exceeds maximum record size")
                data.extend(self._exact(length, deadline))
                if header & 0x80000000:
                    break
            else:
                raise ProtocolError("NFS RPC fragment limit exceeded")
            if len(data) < 24:
                raise ProtocolError("NFS RPC reply header is incomplete")
            received, message, reply, flavor, verifier_size = struct.unpack_from("!5I", data)
            status_offset = 20 + verifier_size + (-verifier_size % 4)
            if received != xid or message != 1 or reply != 0 or status_offset + 4 > len(data):
                raise ProtocolError("NFS RPC reply identity/authentication mismatch")
            accepted = struct.unpack_from("!I", data, status_offset)[0]
            if accepted:
                raise ProtocolError("NFS RPC procedure was rejected")
            return bytes(data[status_offset + 4:])
        except BaseException:
            self.close()
            raise


class Protocol(NFSv3):
    def __init__(self, rpc, host, port, timeout):
        super().__init__(host, port, timeout, auth={})
        self.rpc = rpc

    def nfs_request(self, procedure, args, auth):
        return self.rpc.request(100003, 3, procedure, args)

    def write(self, file_handle, offset, count, content, stable_how, auth=None):
        # Upstream's str_to_bytes(bytes) produces the textual b'...' repr.
        # Feed the original bytes directly to its generated XDR codec.
        packer = nfs_pro_v3Packer()
        packer.pack_write3args(write3args(file=nfs_fh3(file_handle), offset=offset,
                                         count=count, stable=stable_how, data=content))
        return nfs_pro_v3Unpacker(self.nfs_request(7, packer.get_buffer(), auth)).unpack_write3res()


class Connection:
    def __init__(self, config):
        self.config = config
        self.mount = self.rpc = None
        self.mounted = False
        self.root = None
        self.read_size = self.write_size = 65536
        try:
            mount_port = config["mount_port"]
            if not mount_port:
                portmap = self._connect(PORTMAPPER_PORT)
                try:
                    response = portmap.request(100000, 2, 3, struct.pack("!4I", 100005, 3, 6, 0))
                    if len(response) != 4:
                        raise ProtocolError("Invalid NFS mountd port response")
                    mount_port = struct.unpack("!I", response)[0]
                    if not 1 <= mount_port <= 65535:
                        raise ProtocolError("NFSv3 mountd TCP service is unavailable")
                finally:
                    portmap.close()
            self.mount = self._connect(mount_port)
            response = self.mount.request(100005, 3, 1, opaque(config["export"].encode("utf-8")))
            result = nfs_pro_v3Unpacker(response).unpack_mountres3()
            if result.get("status"):
                raise MountError(result["status"])
            self.root = result["mountinfo"]["fhandle"]
            self.mounted = True
            if 1 not in result["mountinfo"]["auth_flavors"]:
                raise AuthenticationError("NFS export does not support AUTH_SYS")
            self.rpc = self._connect(config["port"])
            self.nfs = Protocol(self.rpc, config["host"], config["port"], config["timeout"])
        except BaseException:
            self.close()
            raise

    def _connect(self, port):
        cfg = self.config
        return Rpc(cfg["host"], port, cfg["timeout"], cfg["uid"], cfg["gid"])

    def close(self):
        if self.rpc:
            self.rpc.close()
        if self.mount:
            if self.mounted:
                self.mounted = False
                try:
                    self.mount.request(100005, 3, 3, opaque(self.config["export"].encode("utf-8")),
                                       timeout=min(1, self.config["timeout"]))
                except Exception:
                    pass
            self.mount.close()
