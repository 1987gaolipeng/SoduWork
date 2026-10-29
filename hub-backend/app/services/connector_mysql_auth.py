"""Adapt PyMySQL's supported authentication hook without patching shared driver globals."""


class CachingSha2Authentication:
    """Preserve the consumed terminal packet after the driver's RSA authentication path.

    PyMySQL 1.2.3's built-in RSA branch consumes and validates OK but returns None.
    Its authentication state machine explicitly supports that result for custom
    handlers. The driver still implements all cryptography and server error checks.
    """

    def __init__(self, connection):
        self.connection = connection

    def authenticate(self, packet):
        from pymysql._auth import caching_sha2_password_auth
        return caching_sha2_password_auth(self.connection, packet)
