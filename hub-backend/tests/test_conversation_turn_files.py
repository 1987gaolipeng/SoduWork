import base64
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch, AsyncMock
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from app.conversation_handoff_models import ConversationHandoff, ConversationMessageReceipt
from app.services import conversation_turn_files as material
from app.services import conversation_message_receipts as receipts
from app.services import ai_exec, ai_remote, ai_local, runner_comments
from app.services import cloud_message_recovery


def packet(value=b'actual file content', name='result.txt'):
    return [{'name': name, 'data': base64.b64encode(value).decode(), 'contentType': 'text/plain'}]


class FileValidationTests(unittest.TestCase):
    def test_runner_digest_preserves_content_identity_across_uploads(self):
        from app.services.runner_admission import comment_digest
        original = {'text':'read', 'files':{'transfer':'one', 'items':[
            {'filename':'proof.txt', 'size':3, 'sha256':'aaa', 'contentType':'text/plain'}]}}
        again = {**original, 'files':{**original['files'], 'transfer':'two'}}
        changed = {**original, 'files':{'transfer':'three', 'items':[
            {**original['files']['items'][0], 'sha256':'bbb'}]}}
        self.assertEqual(comment_digest('ref', original), comment_digest('ref', again))
        self.assertNotEqual(comment_digest('ref', original), comment_digest('ref', changed))

    def test_files_remain_binary_and_content_change_changes_manifest(self):
        files, first = material.decode(packet())
        self.assertEqual(files[0], ('result.txt', b'actual file content', 'text/plain'))
        self.assertNotEqual(first, material.decode(packet(b'changed'))[1])

    def test_bad_paths_duplicates_and_malformed_bytes_are_rejected(self):
        for value in (packet(name='../a.txt'), packet(name='CON.txt'), packet()+packet(),
                      [{'name':'a.txt', 'data':'bad!'}], packet(b''), {'name':'a'}):
            with self.subTest(value=str(value)[:60]), self.assertRaises(HTTPException):
                material.decode(value)

    def test_oversize_rejected_before_decode(self):
        with patch.object(material, 'LIMIT', 3), self.assertRaises(HTTPException):
            material.decode(packet(b'12345678'))

    def test_remote_transport_uploads_material_only_to_the_original_runner(self):
        runner = SimpleNamespace(id='personal-pc', caps=['turnFiles1'])
        calls=[]
        def rpc(target, op, body, **kw):
            self.assertIs(target, runner); calls.append((op, body))
            return {'ok':True, 'data':{'ok':True}}
        files, _ = material.decode(packet())
        with patch.object(ai_remote, '_runner_of_ref', return_value=runner), patch.object(ai_remote.runner_hub, 'call_sync', rpc):
            result=ai_remote.comment_sync({'_turnFiles':files, '_messageId':'stable-id'}, 'original-ref', 'read')
        self.assertTrue(result['ok'])
        self.assertEqual([op for op,_ in calls], ['input.chunk','job.comment'])
        body=calls[-1][1]
        self.assertNotIn('_turnFiles',body['cfg'])
        self.assertEqual(body['files']['items'][0]['filename'],'result.txt')
        self.assertEqual(body['turnId'],'stable-id')


class FileDeliveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_receipt_hash_fences_changed_material_and_retries_do_not_send_twice(self):
        engine=create_async_engine('sqlite+aiosqlite:///:memory:')
        async with engine.begin() as connection:
            # Sending checks whether this is a read-only acceptance conversation.
            await connection.run_sync(ConversationHandoff.__table__.create)
            await connection.run_sync(ConversationMessageReceipt.__table__.create)
        try:
            async with async_sessionmaker(engine,expire_on_commit=False)() as session:
                client=SimpleNamespace(id='phone', user_ref='')
                manifest=material.decode(packet())[1]
                with patch.object(ai_exec,'say_sync',return_value={'ok':True}) as send, \
                        patch.object(cloud_message_recovery, 'envelope', AsyncMock(return_value=None)):
                    await receipts.send(session,client,'task','ref','read','one',{},file_manifest=manifest)
                    result=await receipts.send(session,client,'task','ref','read','one',{},file_manifest=manifest)
                    self.assertTrue(result['duplicate']); self.assertEqual(send.call_count,1)
                    with self.assertRaises(HTTPException) as error:
                        await receipts.send(session,client,'task','ref','read','one',{},file_manifest=material.decode(packet(b'changed'))[1])
                    self.assertEqual(error.exception.status_code,409)
                    self.assertEqual(send.call_count,1)
        finally:
            await engine.dispose()

    async def test_runner_stages_actual_file_and_records_it_before_the_same_native_turn(self):
        from app.services import local_stream, runtime_images
        meta={'filename':'result.txt','contentType':'text/plain'}
        read=AsyncMock()
        with tempfile.TemporaryDirectory() as root, patch.object(ai_local,'_store_dir',return_value=root), \
                patch.object(local_stream,'record_user_sync') as record, \
                patch.object(runtime_images,'prepare',side_effect=lambda cfg,*_:cfg), \
                patch.object(local_stream,'comment_sync',return_value={'ok':True}) as send:
            result=await runner_comments.comment(SimpleNamespace(), {
                'ref':'existing','turnId':'turn-id','_admitted':True,'text':'read actual file','recordUser':True,
                'files':{'transfer':'upload','items':[meta]}}, None,
                lambda p,label:[(meta,b'actual bytes')], read)
            self.assertTrue(result['ok'])
            self.assertEqual((Path(root)/'inputs/result.txt').read_bytes(),b'actual bytes')
            self.assertEqual(record.call_args.args[1],'read actual file')
            self.assertEqual(record.call_args.args[2][0]['contentType'],'text/plain')
            self.assertIn('result.txt',send.call_args.args[2])
            read.assert_awaited_once_with('upload')

    async def test_corrupt_packet_never_reaches_native_send(self):
        from app.services import local_stream
        def corrupt(*_): raise ValueError('checksum mismatch')
        with patch.object(local_stream,'comment_sync') as send:
            result=await runner_comments.comment(SimpleNamespace(), {
                'ref':'existing','turnId':'turn-id','_admitted':True,'text':'read',
                'files':{'transfer':'upload','items':[{}]}},None,corrupt,AsyncMock())
            self.assertFalse(result['ok']); send.assert_not_called()
