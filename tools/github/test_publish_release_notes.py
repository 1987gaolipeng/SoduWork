"""Publish localized prose without changing signed installer records."""
from __future__ import annotations

import copy
import urllib.error
import unittest
from unittest.mock import Mock

import publish_release_notes as publisher
from test_release_notes import example_record


CATALOG_ROUTE = '/api/v1/admin/client-releases'
NOTES_ROUTE = '/api/v1/admin/client-release-notes/1.2.3?channel=stable'


class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.record = example_record()
        self.catalog = {'releases': [
            {'id': 'current', 'version': '1.2.3', 'channel': 'stable', 'enabled': True,
             'notes': 'Immutable signed prose', 'signature': 'original-signature', 'sha256': 'a' * 64},
            {'id': 'previous', 'version': '1.2.2', 'channel': 'stable', 'enabled': True,
             'notes': 'Older immutable prose', 'signature': 'older-signature', 'sha256': 'b' * 64}]}
        self.current = {'version': '1.2.3', 'channel': 'stable', 'revision': 3,
                        'status': 'draft', 'locales': {'old': 'reviewed draft'}}
        self.requests = []

    def request(self, route, body=None):
        self.requests.append((route, copy.deepcopy(body)))
        if route == CATALOG_ROUTE:
            self.assertIsNone(body, 'Installer catalog must never be written')
            return copy.deepcopy(self.catalog)
        self.assertEqual(route, NOTES_ROUTE)
        if body is None:
            if self.current is None:
                error = urllib.error.HTTPError('https://example.test' + route, 404, 'Not Found', {}, None)
                self.addCleanup(error.close)
                raise error
            return copy.deepcopy(self.current)
        self.assertEqual(set(body), {'locales', 'status', 'expectedRevision'})
        self.assertEqual(body['expectedRevision'], self.current['revision'] if self.current else 0)
        self.current = {'version': '1.2.3', 'channel': 'stable', 'revision': body['expectedRevision'] + 1,
                        'status': body['status'], 'locales': copy.deepcopy(body['locales'])}
        return {'ok': True, 'revision': self.current['revision']}

    def test_unavailable_notes_skip_without_any_http_request(self):
        self.record.update(status='unavailable', locales={}, sources=[], omitted=[])
        request = Mock(side_effect=AssertionError('No network request is permitted'))
        result = publisher.publish(self.record, request)
        self.assertEqual(result, {'skipped': True, 'version': '1.2.3'})
        request.assert_not_called()

    def test_publishes_with_current_revision_and_preserves_signed_catalog(self):
        before = copy.deepcopy(self.catalog)
        result = publisher.publish(self.record, self.request)
        self.assertEqual(result['revision'], 4)
        self.assertTrue(result['installerCatalogUnchanged'])
        self.assertEqual(self.catalog, before)
        writes = [(route, body) for route, body in self.requests if body is not None]
        self.assertEqual(len(writes), 1)
        self.assertEqual(writes[0][0], NOTES_ROUTE)
        self.assertEqual(writes[0][1], {'expectedRevision': 3, 'status': 'published',
                                      'locales': self.record['locales']})
        self.assertEqual(self.requests[0][0], CATALOG_ROUTE)
        self.assertEqual(self.requests[-1][0], CATALOG_ROUTE)

    def test_missing_metadata_is_created_with_revision_zero(self):
        self.current = None
        result = publisher.publish(self.record, self.request)
        self.assertEqual(result['revision'], 1)
        write = next(body for route, body in self.requests if body is not None)
        self.assertEqual(write['expectedRevision'], 0)

    def test_conflicting_revision_does_not_retry_or_write_installers(self):
        conflict = urllib.error.HTTPError('https://example.test', 409, 'Conflict', {}, None)
        self.addCleanup(conflict.close)
        def request(route, body=None):
            if body is not None:
                self.requests.append((route, copy.deepcopy(body)))
                raise conflict
            return self.request(route)
        with self.assertRaises(urllib.error.HTTPError) as raised:
            publisher.publish(self.record, request)
        self.assertIs(raised.exception, conflict)
        writes = [(route, body) for route, body in self.requests if body is not None]
        self.assertEqual(len(writes), 1)
        self.assertEqual(writes[0][0], NOTES_ROUTE)
        self.assertEqual(self.current['revision'], 3)

    def test_no_matching_enabled_stable_installer_prevents_notes_write(self):
        for change in [{'enabled': False}, {'channel': 'beta'}, {'version': '1.2.4'}]:
            with self.subTest(change=change):
                self.catalog['releases'][0] = {**self.catalog['releases'][0],
                    'enabled': True, 'channel': 'stable', 'version': '1.2.3', **change}
                self.requests = []
                with self.assertRaisesRegex(ValueError, 'matching installer'):
                    publisher.publish(self.record, self.request)
                self.assertEqual(self.requests, [(CATALOG_ROUTE, None)])

    def test_readback_prose_mismatch_is_detected(self):
        def request(route, body=None):
            response = self.request(route, body)
            if route == NOTES_ROUTE and body is None and self.current['revision'] == 4:
                response['locales']['en-US']['summary'] = 'Unexpected content'
            return response
        with self.assertRaisesRegex(ValueError, 'Published notes differ'):
            publisher.publish(self.record, request)

    def test_readback_draft_status_is_detected(self):
        def request(route, body=None):
            response = self.request(route, body)
            if route == NOTES_ROUTE and body is None and self.current['revision'] == 4:
                response['status'] = 'draft'
            return response
        with self.assertRaisesRegex(ValueError, 'Published notes differ'):
            publisher.publish(self.record, request)

    def test_concurrent_signed_catalog_change_is_detected(self):
        reads = 0
        def request(route, body=None):
            nonlocal reads
            response = self.request(route, body)
            if route == CATALOG_ROUTE:
                reads += 1
                if reads == 2:
                    response['releases'][0]['signature'] = 'unexpected-change'
            return response
        with self.assertRaisesRegex(ValueError, 'Installer catalog changed'):
            publisher.publish(self.record, request)
        self.assertEqual(self.catalog['releases'][0]['signature'], 'original-signature')

    def test_notes_read_permission_errors_are_not_treated_as_missing_metadata(self):
        denied = urllib.error.HTTPError('https://example.test', 403, 'Forbidden', {}, None)
        self.addCleanup(denied.close)
        def request(route, body=None):
            if route == NOTES_ROUTE:
                raise denied
            return self.request(route, body)
        with self.assertRaises(urllib.error.HTTPError) as raised:
            publisher.publish(self.record, request)
        self.assertIs(raised.exception, denied)
        self.assertEqual(self.requests, [(CATALOG_ROUTE, None)])


if __name__ == '__main__':
    unittest.main()
