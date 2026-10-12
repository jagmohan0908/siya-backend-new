"""Read-only WA Chat Hub tools and trusted mobile cards. No model-selected patient IDs."""
import json
import re
from urllib.parse import urlencode, urlparse

import frappe
import requests
from wa_chat_hub.security import safe_ai_get_all, safe_ai_get_doc
from wa_chat_hub.mcp.patient_records import _verified_patient, get_verified_patient_drug_prescriptions


def _context(conversation):
    convo = safe_ai_get_doc("Chat Conversation", str(conversation or ""))
    accounts = frappe.conf.get("mobile_app_ai_channel_accounts") or {}
    app = next((app for app, account in accounts.items() if account == convo.channel_account), None)
    if app not in {"siya-ayurveda", "seedfit"}:
        frappe.throw("Mobile App channel is required.", frappe.PermissionError)
    return app, convo


def _patient(conversation, patient=None):
    _, convo = _context(conversation)
    linked = str(convo.linked_patient or "")
    if patient and str(patient) != linked:
        frappe.throw("Patient does not belong to this conversation.", frappe.PermissionError)
    return _verified_patient(patient=linked, conversation=conversation)


def _remember(conversation, cards):
    # This value exists only inside the current ERP AI job, never from user input.
    key = str(getattr(frappe.local, "wa_ai_reply_to_message", "") or "")
    if not key:
        return
    current = getattr(frappe.local, "mobile_app_reply_cards", None) or {}
    if current.get("conversation") != str(conversation) or current.get("message") != key:
        current = {"conversation": str(conversation), "message": key, "cards": []}
    for card in cards:
        if card not in current["cards"]:
            current["cards"].append(card)
    frappe.local.mobile_app_reply_cards = current


def reply_cards(conversation, message):
    current = getattr(frappe.local, "mobile_app_reply_cards", None) or {}
    if current.get("conversation") == str(conversation) and current.get("message") == str(message):
        return current.get("cards", [])[:6]
    return []


def stored_cards(raw):
    try:
        value = json.loads(raw or "{}") if isinstance(raw, str) else raw or {}
        cards = value.get("mobile_app_cards", [])
        return [c for c in cards if isinstance(c, dict) and c.get("type") in {"product", "shipment"}][:6]
    except (ValueError, TypeError, AttributeError):
        return []


def _secure(url, hosts):
    parsed = urlparse(str(url or ""))
    return str(url) if parsed.scheme == "https" and parsed.hostname in hosts and not parsed.username and not parsed.password else ""


def search_mobile_products(*, conversation, query, patient=None):
    """Search this app's published catalogue through ERP; no cross-store fallback."""
    app, _ = _context(conversation)
    config = (frappe.conf.get("mobile_app_shopify_stores") or {}).get(app) or {}
    domain = str(config.get("domain") or "").strip().lower()
    token = config.get("storefront_token")
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]+", domain) or not token:
        return {"available": False, "products": [], "reason": "This app's catalogue is not configured. Contact the care team."}
    query = str(query or "").strip()[:100]
    if not query:
        return {"products": [], "reason": "Ask which product or concern the user wants information about."}
    response = requests.post(f"https://{domain}/api/2026-07/graphql.json",
        headers={"X-Shopify-Storefront-Access-Token": token}, timeout=12, allow_redirects=False,
        json={"query": """query ChatProducts($query:String!) { products(first:3, query:$query) { nodes {
            id title description onlineStoreUrl availableForSale featuredImage { url }
            priceRange { minVariantPrice { amount currencyCode } }
        } } }""", "variables": {"query": query}})
    if response.status_code != 200:
        frappe.throw("Product catalogue is temporarily unavailable.")
    body = response.json()
    if body.get("errors"):
        frappe.throw("Product catalogue is temporarily unavailable.")
    hosts = {domain, str(config.get("storefront_domain") or "").lower()}
    hosts |= {"www." + host for host in list(hosts) if host}
    products, cards = [], []
    for product in body.get("data", {}).get("products", {}).get("nodes", []):
        url = _secure(product.get("onlineStoreUrl"), hosts)
        price = (product.get("priceRange") or {}).get("minVariantPrice") or {}
        item = {"id": product["id"], "title": product["title"],
                "description": str(product.get("description") or "")[:1200],
                "price": price.get("amount"), "currency": price.get("currencyCode"),
                "available": bool(product.get("availableForSale")), "url": url}
        products.append(item)
        cards.append({**item, "type": "product", "description": item["description"][:240],
                      "image_url": _secure((product.get("featuredImage") or {}).get("url"), {"cdn.shopify.com"}),
                      "button_label": "Buy now" if item["available"] and url else ""})
    _remember(conversation, cards)
    return {"products": products, "note": "Catalogue facts only, not a diagnosis or personal prescription. Product cards and buy buttons are attached automatically. Do not invent products, URLs or usage."}


def get_mobile_order_details(*, conversation, patient=None, invoice=None):
    verified = _patient(conversation, patient)
    filters = {"patient": verified, "docstatus": 1, "is_return": 0}
    if invoice:
        filters["name"] = str(invoice)[:140]
    rows = safe_ai_get_all("Sales Invoice", filters=filters, fields=["name"],
                           order_by="posting_date desc, creation desc", limit_page_length=3)
    orders, cards = [], []
    for row in rows:
        doc = safe_ai_get_doc("Sales Invoice", row.name)
        if doc.patient != verified or doc.docstatus != 1 or doc.is_return:
            continue
        shipment = None
        if frappe.db.exists("DocType", "Shipment Tracking Shipment"):
            matches = safe_ai_get_all("Shipment Tracking Shipment", filters={"sales_invoice": doc.name}, fields=["name"], limit_page_length=2)
            if len(matches) == 1:
                candidate = safe_ai_get_doc("Shipment Tracking Shipment", matches[0].name)
                if (candidate.sales_invoice == doc.name
                        and (not candidate.get("patient") or candidate.patient == verified)
                        and (not candidate.get("customer") or candidate.customer == doc.customer)
                        and (not doc.get("si_shipkia_shipment") or doc.si_shipkia_shipment == candidate.name)
                        and (not doc.get("si_shipkia_order_id") or doc.si_shipkia_order_id == candidate.shipkia_order_id)):
                    shipment = candidate
        shipping = lambda field, fallback: (shipment.get(field) if shipment else None) or doc.get(fallback)
        awb = str(shipping("shipkia_awb_number", "si_shipkia_awb_number") or "").strip()
        tracking = "https://shipkia.com/tracking_result.html?" + urlencode({"tracking_id": awb}) if awb else ""
        order = {"invoice": doc.name, "date": str(doc.posting_date), "status": doc.status,
                 "currency": doc.currency, "total": doc.grand_total,
                 "items": [{"name": r.item_name, "code": r.item_code, "quantity": r.qty} for r in doc.items],
                 "courier": shipping("delivery_partner", "si_shipkia_delivery_partner"), "awb": awb,
                 "shipping_status": shipping("shipkia_status", "si_shipkia_status") or doc.get("si_shipkia_shipment_status"),
                 "tracking_url": tracking}
        orders.append(order)
        if tracking:
            cards.append({"type": "shipment", "title": doc.name, "awb": awb,
                          "description": str(order["shipping_status"] or "Tracking available"),
                          "url": tracking, "button_label": "Track shipment"})
    _remember(conversation, cards)
    return {"orders": orders, "note": "Only this verified patient's submitted invoices. If tracking_url is blank, tracking is not available; never invent an AWB or status. Tracking buttons are attached automatically."}


def get_mobile_prescription(*, conversation, patient=None):
    verified = _patient(conversation, patient)
    result = get_verified_patient_drug_prescriptions(patient=verified, conversation=conversation)
    if not result.get("encounter"):
        # Encounters may contain a clinician's instruction without a drug table.
        rows = safe_ai_get_all("Patient Encounter", filters={"patient": verified, "docstatus": ["!=", 2]},
                               fields=["name"], order_by="encounter_date desc, encounter_time desc, modified desc", limit_page_length=1)
        for row in rows:
            encounter = safe_ai_get_doc("Patient Encounter", row.name)
            if encounter.get("patient") == verified and encounter.get("sr_pe_instruction"):
                result.update(encounter=encounter.name, encounter_date=encounter.get("encounter_date"),
                              practitioner_name=encounter.get("practitioner_name"), instructions=encounter.get("sr_pe_instruction"))
    for field in ("drug_prescription", "sr_homeopathy_drug_prescription", "sr_allopathy_drug_prescription"):
        for row in result.get(field) or []:
            instruction = row.get("sr_drug_instruction")
            if instruction and frappe.db.exists("SR Instruction", instruction):
                doc = safe_ai_get_doc("SR Instruction", instruction)
                row["recorded_instruction"] = doc.get("sr_description") or doc.get("sr_title") or instruction
    result["note"] = "Explain only recorded clinician instructions, naming the encounter date. An invoice is not a prescription. If the requested medicine, dose, duration or instructions are missing, say they are not recorded and offer Contact care team. Never infer a dose from a product description."
    return result
