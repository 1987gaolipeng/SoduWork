"""Shared protocol errors; importable by the packaged Runner without Hub dependencies."""


class RunnerIdentityConflict(ValueError, ConnectionError):
    code = "RUNNER_IDENTITY_CONFLICT"

    def __init__(self, message="执行机身份已绑定另一台设备，正在恢复本机连接"):
        super().__init__(message)
