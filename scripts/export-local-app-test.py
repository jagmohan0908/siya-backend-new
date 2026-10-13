"""Run inside the local bench's sites directory. Exports only the named test account.

The output contains personal test data and belongs outside the Git repository.
No credentials, sessions, chat history, or global integration settings are exported.
"""
import base64
import json
import frappe

frappe.init(site="localhost")
frappe.connect()
account = "gid://shopify/Customer/8971995087157"
patient = "SAD-PAT-9"
documents = {}

def add(dt, name):
    if (dt, name) not in documents:
        documents[(dt, name)] = frappe.get_doc(dt, name).as_dict()
    return documents[(dt, name)]

add("Patient", patient)
add("Mobile App User", account)
add("Customer", documents[("Patient", patient)].customer)
for dt, filters in [
    ("Sales Invoice", {"patient": patient, "name": ["in", ["ACC-SINV-2026-00006", "ACC-SINV-2026-00007"]]}),
    ("Patient Encounter", {"patient": patient}),
    ("Mobile App Assessment", {"account": account}),
    ("Support Ticket", {"user_id": account}),
    ("Siya Mobile Record", {"account": account, "kind": ["in", ["identity", "profile", "habits"]]}),
]:
    for row in frappe.get_all(dt, filters=filters):
        add(dt, row.name)
add("Diet Chart", "Vitiligo Diet Chart")
for name in ["Dr Neha Tiwari", "Dr Megha Chaturvedi"]:
    practitioner = add("Healthcare Practitioner", name)
    for row in practitioner.practitioner_schedules:
        add("Practitioner Schedule", row.schedule)

# Only product/master dependencies of these records. Never recursively copy patients/users.
allowed = {"Item", "Item Group", "Item Group Template", "Medical Department", "SR Practitioner Pathy", "DPT Disease", "SR Encounter Place", "SR Sales Type", "SR Encounter Status", "SR Lead Source"}
while True:
    before = len(documents)
    for doc in list(documents.values()):
        def inspect(row):
            for f in frappe.get_meta(row.doctype).fields:
                if f.fieldtype == "Link" and f.options in allowed and row.get(f.fieldname):
                    add(f.options, row[f.fieldname])
                elif f.fieldtype in ("Table", "Table MultiSelect"):
                    for child in row.get(f.fieldname) or []:
                        inspect(child)
        inspect(doc)
    if len(documents) == before:
        break

selected = {
    "Patient": ["sr_patient_id", "sr_medical_department"],
    "Sales Invoice": ["sr_si_patient_id", "sr_si_mobile", "sr_si_order_source"] + [f.fieldname for f in frappe.get_meta("Sales Invoice").fields if f.fieldname.startswith("si_shipkia_") and f.fieldtype not in ("Section Break", "Column Break", "Tab Break")],
    "Diet Chart": ["custom_items", "custom_diet_chart_pdf"],
    "Healthcare Practitioner": ["sr_diseases", "sr_qualification", "sr_reg_no", "custom_about_doctor", "custom_accept_online_appointments", "custom_accept_opd_appointments"],
    "Patient Encounter": ["diet_chart", "pe_practitioner", "sr_pe_instruction", "custom_appointment_status"],
}
schemas = {}
custom_fields = []
field_keys = ["fieldname", "label", "fieldtype", "options", "reqd", "in_list_view", "read_only", "allow_on_submit"]
def schema(dt):
    if dt in schemas:
        return
    meta = frappe.get_meta(dt)
    schemas[dt] = {"name": dt, "module": "Custom", "custom": 1, "istable": meta.istable,
                   "autoname": meta.autoname, "fields": [{k: f.get(k) for k in field_keys if f.get(k) is not None} for f in meta.fields]}
    if not meta.istable:
        schemas[dt]["permissions"] = [{"role": "System Manager", "read": 1, "write": 1, "create": 1, "delete": 1}]
    for f in meta.fields:
        if f.fieldtype in ("Table", "Table MultiSelect"):
            schema(f.options)
schema("SR Encounter Place")
for dt, names in selected.items():
    meta = frappe.get_meta(dt)
    for name in names:
        f = meta.get_field(name)
        if not f:
            continue
        custom_fields.append({"dt": dt, **{k: f.get(k) for k in field_keys if f.get(k) is not None}})
        if f.fieldtype in ("Table", "Table MultiSelect"):
            schema(f.options)

files = []
for doc in documents.values():
    for field in ["custom_diet_chart_pdf", "image"]:
        url = doc.get(field)
        if url and url.startswith(("/files/", "/private/files/")):
            found = frappe.get_all("File", filters={"file_url": url}, limit_page_length=1)
            if found:
                file = frappe.get_doc("File", found[0].name)
                content = file.get_content()
                if isinstance(content, str): content = content.encode()
                files.append({"doctype": doc.doctype, "name": doc.name, "field": field, "url": url,
                              "filename": file.file_name, "content": base64.b64encode(content).decode()})

pack = {"source": "localhost", "account": account, "patient": patient, "documents": list(documents.values()),
        "schemas": list(schemas.values()), "custom_fields": custom_fields, "files": files}
with open("/tmp/siya-local-app-test.json", "w") as output:
    json.dump(pack, output, default=str)
print(json.dumps({"exported": len(documents), "files": len(files), "schemas": len(schemas), "output": "/tmp/siya-local-app-test.json"}))
frappe.destroy()
