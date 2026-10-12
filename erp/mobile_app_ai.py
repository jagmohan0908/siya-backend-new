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


def setup_new_chat():
    """Install once during ERP deployment; retain a retry-safe session chain."""
    frappe.only_for("System Manager")
    from frappe.custom.doctype.custom_field.custom_field import create_custom_fields
    create_custom_fields({"Chat Conversation": [{
        "fieldname": "custom_mobile_previous_chat", "label": "Previous Mobile App Chat",
        "fieldtype": "Link", "options": "Chat Conversation", "read_only": 1,
        "no_copy": 1, "unique": 1,
    }]})
    frappe.db.commit()


@frappe.whitelist(methods=["POST"])
def new_session(external_id, app_id, conversation):
    mobile_app._require_backend_token()
    context = mobile_app._resolve_context(external_id, app_id=app_id)
    previous = mobile_app._assert_conversation_owner(conversation, context)
    # A retry for the same previous chat returns the same new chat. Lock before
    # lookup/insert so two devices cannot create competing empty conversations.
    frappe.db.get_value("Chat Conversation", previous.name, "name", for_update=True)
    existing = frappe.db.get_value("Chat Conversation", {"custom_mobile_previous_chat": previous.name}, "name")
    if existing:
        fresh = mobile_app._assert_conversation_owner(existing, context)
    else:
        fresh = frappe.get_doc({
            "doctype": "Chat Conversation", "channel_account": context["account"],
            "contact": previous.contact, "department": previous.department,
            "medical_department": previous.medical_department, "status": "Open",
            "custom_mobile_previous_chat": previous.name,
        }).insert(ignore_permissions=True)
        if context["patient"]:
            from wa_chat_hub.identity import reconcile_conversation_identity
            reconcile_conversation_identity(fresh.name, patient=context["patient"],
                                            source="authenticated_mobile_app", verified=True)
            fresh.reload()
    frappe.db.commit()
    return _readiness({"success": True, "data": mobile_app._session_payload(fresh, context)})
