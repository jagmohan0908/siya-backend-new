"""Run with python -m unittest discover -s erp -p 'test_*.py'. No live ERP writes."""
import importlib.util
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch


class ChatTests(unittest.TestCase):
    def setUp(self):
        self.frappe = MagicMock()
        self.frappe.whitelist.side_effect = lambda **_: lambda fn: fn
        self.frappe.PermissionError = PermissionError
        self.frappe.throw.side_effect = lambda message, error=RuntimeError: (_ for _ in ()).throw(error(message))
        self.frappe.session.user = 'backend@example.test'
        self.frappe.get_roles.return_value = ['System Manager']
        self.user = SimpleNamespace(name='user-1', is_active=1)
        self.frappe.get_doc.return_value = self.user
        self.requests = MagicMock()
        self.requests.RequestException = OSError
        with patch.dict(sys.modules, {'frappe': self.frappe, 'frappe.utils': MagicMock(), 'requests': self.requests}):
            spec = importlib.util.spec_from_file_location('tested_mobile_ai', Path(__file__).with_name('mobile_app_ai.py'))
            self.api = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(self.api)

    def test_backend_role_required_before_reading_account(self):
        for user, roles in [('Guest', ['System Manager']), ('staff', ['Employee'])]:
            self.frappe.session.user = user
            self.frappe.get_roles.return_value = roles
            with self.assertRaises(PermissionError):
                self.api._account('user-1', 'siya-ayurveda')
        self.frappe.get_doc.assert_not_called()

    def test_app_and_owner_must_match_before_reading_chat(self):
        conversation = self.api._key(self.user, 'siya-ayurveda')
        for user, app in [(self.user, 'seedfit'), (SimpleNamespace(name='other'), 'siya-ayurveda')]:
            with self.assertRaises(PermissionError):
                self.api._owned(user, app, conversation)
        self.frappe.get_doc.assert_not_called()

    def test_message_cursor_cannot_reference_another_conversation(self):
        row = SimpleNamespace(name='one', sender_type='Customer', message='Hello', created_at='today')
        chat = SimpleNamespace(messages=[row])
        self.assertEqual(self.api._messages(chat)[0]['message'], 'Hello')
        self.assertEqual(self.api._messages(chat, 'one'), [])
        with self.assertRaises(PermissionError):
            self.api._messages(chat, 'foreign')

    def test_writes_load_the_current_chat_and_children_under_a_lock(self):
        name = self.api._key(self.user, 'siya-ayurveda')
        self.frappe.get_doc.return_value = SimpleNamespace(mobile_app_user=self.user.name, app='Siya Ayurveda')
        self.api._owned(self.user, 'siya-ayurveda', name, lock=True)
        self.frappe.get_doc.assert_called_once_with(self.api.CHAT, name, for_update=True)

    def test_retry_does_not_generate_another_reply(self):
        row = SimpleNamespace(name='message-1', client_message_id='retry', message='Hello', sender_type='Customer')
        chat = SimpleNamespace(name='chat-1', messages=[row])
        with patch.object(self.api, '_owned', return_value=chat), patch.object(self.api, '_reply') as reply:
            result = self.api.send_message('user-1', 'siya-ayurveda', 'chat-1', 'Hello', 'retry')
            self.assertTrue(result['data']['duplicate'])
            reply.assert_not_called()
            with self.assertRaises(RuntimeError):
                self.api.send_message('user-1', 'siya-ayurveda', 'chat-1', 'Different text', 'retry')

    def test_provider_failure_does_not_persist_half_a_turn(self):
        chat = MagicMock(messages=[])
        with patch.object(self.api, '_owned', return_value=chat), patch.object(self.api, '_reply', side_effect=RuntimeError('Unavailable')):
            with self.assertRaises(RuntimeError):
                self.api.send_message('user-1', 'siya-ayurveda', 'chat-1', 'Hello', 'retry')
        chat.append.assert_not_called()
        chat.save.assert_not_called()

    def test_provider_receives_only_chat_and_keeps_secret_inside_erp(self):
        provider = SimpleNamespace(model_name='configured-model', get_password=lambda *a, **k: 'test-secret')
        self.requests.post.return_value = SimpleNamespace(status_code=200, json=lambda: {'choices':[{'message':{'content':'Hello'}}]})
        chat = SimpleNamespace(messages=[])
        with patch.object(self.api, '_provider', return_value=(provider, 'https://ai.example.test/chat/completions')):
            self.assertEqual(self.api._reply(chat, 'Help', 'seedfit'), 'Hello')
        args = self.requests.post.call_args.kwargs
        self.assertIn('Seedfit', args['json']['messages'][0]['content'])
        self.assertFalse(args['json']['store'])
        self.assertFalse(args['allow_redirects'])
        self.assertEqual(args['json']['messages'][-1], {'role':'user', 'content':'Help'})
        self.assertNotIn('tools', args['json'])
        self.assertNotIn('test-secret', str(args['json']))

    def test_provider_failure_does_not_expose_response_or_credentials(self):
        provider = SimpleNamespace(model_name='model', get_password=lambda *a, **k: 'test-secret')
        self.requests.post.return_value = SimpleNamespace(status_code=401, text='sensitive provider response')
        with patch.object(self.api, '_provider', return_value=(provider, 'https://ai.example.test')):
            with self.assertRaisesRegex(RuntimeError, '^AI reply is temporarily unavailable'):
                self.api._reply(SimpleNamespace(messages=[]), 'Hello', 'siya-ayurveda')
        self.frappe.log_error.assert_not_called()


if __name__ == '__main__':
    unittest.main()
