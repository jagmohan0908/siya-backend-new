"""Run: python -m unittest discover -s erp -p 'test_*.py'."""
import importlib.util
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.frappe = MagicMock()
        self.frappe.whitelist.side_effect = lambda **_: lambda fn: fn
        self.transport = MagicMock()
        self.settings = SimpleNamespace(service_user="service@example.test", enable_ai_autopilot=1,
                                        autopilot_mode="Limited Auto Reply")
        self.frappe.get_single.return_value = self.settings
        self.frappe.db.get_value.return_value = 1
        parent = MagicMock(mobile_app=self.transport)
        with patch.dict(sys.modules, {"frappe": self.frappe, "wa_chat_hub": MagicMock(), "wa_chat_hub.api": parent}):
            spec = importlib.util.spec_from_file_location("bridge", Path(__file__).with_name("mobile_app_ai.py"))
            self.api = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(self.api)

    def test_open_uses_channel_transport_with_explicit_app(self):
        self.transport.open_session.return_value = {"success": True, "data": {"conversation_id": "1"}}
        result = self.api.open_session("verified-user", "siya-ayurveda")
        self.transport.open_session.assert_called_once_with("verified-user", app_id="siya-ayurveda")
        self.assertTrue(result["data"]["ai_ready"])

    def test_polling_preserves_cursor_and_app_scope(self):
        self.transport.get_messages.return_value = {"success": True, "data": {"messages": []}}
        self.api.get_messages("verified-user", "seedfit", "2", after="message", limit=50)
        self.transport.get_messages.assert_called_once_with("verified-user", "2", after="message", limit=50, app_id="seedfit")

    def test_send_uses_existing_autopilot_transport_and_retry_id(self):
        self.api.send_message("user", "siya-ayurveda", "1", "Hello", "retry-id")
        self.transport.send_message.assert_called_once_with("user", "1", "Hello", "retry-id", app_id="siya-ayurveda")

    def test_handoff_uses_the_same_conversation_and_app(self):
        self.api.escalate("user", "seedfit", "2")
        self.transport.escalate.assert_called_once_with("user", "2", app_id="seedfit")

    def test_missing_runtime_user_disables_ai_without_hiding_history(self):
        self.settings.service_user = ""
        self.transport.open_session.return_value = {"success": True, "data": {"messages": [{"id": "1"}]}}
        result = self.api.open_session("user", "siya-ayurveda")
        self.assertFalse(result["data"]["ai_ready"])
        self.assertEqual(len(result["data"]["messages"]), 1)

    def test_transport_permission_failures_are_not_swallowed(self):
        self.transport.get_messages.side_effect = PermissionError("Not owned")
        with self.assertRaises(PermissionError):
            self.api.get_messages("user", "seedfit", "foreign")


if __name__ == "__main__":
    unittest.main()
