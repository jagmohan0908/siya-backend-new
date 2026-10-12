import importlib.util
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch


class ToolsTests(unittest.TestCase):
    def setUp(self):
        self.frappe = MagicMock()
        self.frappe.PermissionError = PermissionError
        self.frappe.throw.side_effect = lambda message, error=ValueError: (_ for _ in ()).throw(error(message))
        self.frappe.local = SimpleNamespace(wa_ai_reply_to_message="m1")
        self.frappe.conf = {"mobile_app_ai_channel_accounts": {"siya-ayurveda": "Siya", "seedfit": "Seedfit"}}
        self.security = MagicMock()
        self.records = MagicMock()
        self.requests = MagicMock()
        with patch.dict(sys.modules, {"frappe": self.frappe, "requests": self.requests,
                "wa_chat_hub": MagicMock(), "wa_chat_hub.security": self.security,
                "wa_chat_hub.mcp": MagicMock(), "wa_chat_hub.mcp.patient_records": self.records}):
            spec = importlib.util.spec_from_file_location("chat_tools", Path(__file__).with_name("mobile_app_ai_tools.py"))
            self.api = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(self.api)
        self.convo = SimpleNamespace(channel_account="Siya", linked_patient="patient-a")
        self.security.safe_ai_get_doc.return_value = self.convo
        self.records._verified_patient.return_value = "patient-a"

    def test_patient_from_message_cannot_override_linked_patient(self):
        with self.assertRaises(PermissionError):
            self.api.get_mobile_order_details(conversation="c1", patient="patient-b")
        self.security.safe_ai_get_all.assert_not_called()

    def test_unverified_patient_cannot_read_prescriptions(self):
        self.records._verified_patient.side_effect = PermissionError("not verified")
        with self.assertRaises(PermissionError):
            self.api.get_mobile_prescription(conversation="c1")
        self.records.get_verified_patient_drug_prescriptions.assert_not_called()

    def test_cards_are_bound_to_conversation_and_inbound_message(self):
        self.api._remember("c1", [{"type": "shipment"}])
        self.assertEqual(len(self.api.reply_cards("c1", "m1")), 1)
        self.assertEqual(self.api.reply_cards("c2", "m1"), [])
        self.assertEqual(self.api.reply_cards("c1", "m2"), [])
        self.frappe.local.wa_ai_reply_to_message = "m2"
        self.api._remember("c1", [{"type": "product"}])
        self.assertEqual(self.api.reply_cards("c1", "m2"), [{"type": "product"}])

    def test_seedfit_never_uses_siya_catalogue(self):
        self.frappe.conf["mobile_app_shopify_stores"] = {"siya-ayurveda": {"domain": "store.myshopify.com", "storefront_token": "test"}}
        self.convo.channel_account = "Seedfit"
        result = self.api.search_mobile_products(conversation="c1", query="acne")
        self.assertFalse(result["available"])
        self.requests.post.assert_not_called()

    def test_empty_orders_do_not_fabricate_tracking(self):
        self.security.safe_ai_get_all.return_value = []
        result = self.api.get_mobile_order_details(conversation="c1", invoice="someone-elses-invoice")
        self.assertEqual(result["orders"], [])
        self.assertEqual(self.security.safe_ai_get_all.call_args.kwargs["filters"]["patient"], "patient-a")
        self.assertEqual(self.api.reply_cards("c1", "m1"), [])

    def test_missing_encounter_returns_no_invented_prescription(self):
        self.records.get_verified_patient_drug_prescriptions.return_value = {"encounter": None, "drug_prescription": []}
        result = self.api.get_mobile_prescription(conversation="c1")
        self.assertIsNone(result["encounter"])
        self.assertEqual(result["drug_prescription"], [])

    def test_prescription_resolves_recorded_instruction_without_changing_dose(self):
        self.records.get_verified_patient_drug_prescriptions.return_value = {
            "encounter": "test-encounter", "encounter_date": "2026-10-12",
            "drug_prescription": [{"drug_name": "Recorded medicine", "dosage": "Recorded dose",
                                   "sr_drug_instruction": "instruction-1"}]}
        instruction = MagicMock()
        instruction.get.side_effect = {"sr_description": "Recorded after-meal instruction"}.get
        self.security.safe_ai_get_doc.side_effect = [self.convo, instruction]
        result = self.api.get_mobile_prescription(conversation="c1")
        row = result["drug_prescription"][0]
        self.assertEqual(row["dosage"], "Recorded dose")
        self.assertEqual(row["recorded_instruction"], "Recorded after-meal instruction")

    def test_linked_shipment_is_checked_and_awb_encoded(self):
        class Doc(SimpleNamespace):
            def get(self, key):
                return getattr(self, key, None)
        invoice = Doc(name="invoice-1", patient="patient-a", customer="customer-a", docstatus=1,
                      is_return=0, posting_date="2026-10-12", status="Paid", currency="INR", grand_total=100, items=[])
        shipment = Doc(name="shipment-1", sales_invoice="invoice-1", patient="patient-a",
                       customer="customer-a", shipkia_awb_number="AWB/123", shipkia_status="Shipped")
        self.security.safe_ai_get_all.side_effect = [[Doc(name="invoice-1")], [Doc(name="shipment-1")]]
        self.security.safe_ai_get_doc.side_effect = [self.convo, invoice, shipment]
        result = self.api.get_mobile_order_details(conversation="c1")
        self.assertEqual(result["orders"][0]["tracking_url"], "https://shipkia.com/tracking_result.html?tracking_id=AWB%2F123")
        self.assertEqual(len(self.api.reply_cards("c1", "m1")), 1)
        shipment.patient = "patient-b"
        self.frappe.local.mobile_app_reply_cards = None
        self.security.safe_ai_get_all.side_effect = [[Doc(name="invoice-1")], [Doc(name="shipment-1")]]
        self.security.safe_ai_get_doc.side_effect = [self.convo, invoice, shipment]
        result = self.api.get_mobile_order_details(conversation="c1")
        self.assertEqual(result["orders"][0]["tracking_url"], "")
        self.assertEqual(self.api.reply_cards("c1", "m1"), [])

    def test_only_https_catalogue_urls_are_allowed(self):
        for url in ["http://siyaayurveda.com/products/x", "https://siyaayurveda.com.evil/x", "https://evil@siyaayurveda.com/x"]:
            self.assertEqual(self.api._secure(url, {"siyaayurveda.com"}), "")


if __name__ == "__main__":
    unittest.main()
