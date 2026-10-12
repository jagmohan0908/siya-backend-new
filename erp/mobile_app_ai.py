"""Authenticated bridge to WA Chat Hub's Mobile App transport.

Deploy to sriaas_clinic/api/mobile_app_ai.py along with the WA Chat Hub patch.
All messages, AI replies, routing and prompts are owned by WA Chat Hub.
"""
import frappe
from wa_chat_hub.api import mobile_app


def _readiness(result):
    settings = frappe.get_single("WA Chat Hub Settings")
    user = str(settings.service_user or "").strip()
    result["data"]["ai_ready"] = bool(
        settings.enable_ai_autopilot
        and settings.autopilot_mode == "Limited Auto Reply"
        and user not in {"", "Guest", "Administrator"}
        and frappe.db.get_value("User", user, "enabled")
    )
    return result


@frappe.whitelist(methods=["POST"])
def open_session(external_id, app_id):
    return _readiness(mobile_app.open_session(external_id, app_id=app_id))


@frappe.whitelist(methods=["GET"])
def get_messages(external_id, app_id, conversation, after=None, limit=100):
    return _readiness(mobile_app.get_messages(external_id, conversation,
        after=after, limit=limit, app_id=app_id))


@frappe.whitelist(methods=["POST"])
def send_message(external_id, app_id, conversation, message, client_message_id):
    return mobile_app.send_message(external_id, conversation, message,
        client_message_id, app_id=app_id)


@frappe.whitelist(methods=["POST"])
def escalate(external_id, app_id, conversation):
    return mobile_app.escalate(external_id, conversation, app_id=app_id)
