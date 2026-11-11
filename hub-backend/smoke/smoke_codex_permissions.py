"""Native ACP inputs and explicit session grants with isolated local brokers."""
import unittest


if __name__ == '__main__':
    suite = unittest.defaultTestLoader.loadTestsFromNames([
        'test_acp_permission_inputs', 'test_access_command_scope', 'test_acp_other_permissions',
    ])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(0 if result.wasSuccessful() else 1)
