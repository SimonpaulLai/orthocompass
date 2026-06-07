from datetime import datetime, timezone


def build_fhir_bundle(data: dict) -> dict:
    now = datetime.now(timezone.utc).isoformat()

    condition = {
        "resourceType": "Condition",
        "clinicalStatus": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/condition-clinical", "code": "active"}]},
        "verificationStatus": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/condition-ver-status", "code": "unconfirmed"}]},
        "recordedDate": now,
    }
    if data.get("body_site"):
        condition["bodySite"] = [{"text": data["body_site"]}]
    if data.get("key_finding"):
        condition["note"] = [{"text": data["key_finding"]}]

    components = []
    if data.get("pain_score") is not None:
        components.append({"code": {"text": "Pain Score (NRS)"}, "valueInteger": data["pain_score"]})
    if data.get("weight_bearing") and data["weight_bearing"] != "unknown":
        components.append({"code": {"text": "Weight Bearing"}, "valueString": data["weight_bearing"].capitalize()})
    if data.get("mechanism"):
        components.append({"code": {"text": "Mechanism of Injury"}, "valueString": data["mechanism"]})
    if data.get("key_finding"):
        components.append({"code": {"text": "Key Finding"}, "valueString": data["key_finding"]})
    if data.get("ottawa_result") and data["ottawa_result"] != "untested":
        components.append({"code": {"text": "Ottawa Rules"}, "valueString": data["ottawa_result"].capitalize()})
    for test in (data.get("special_tests") or []):
        components.append({"code": {"text": "Special Test"}, "valueString": test})
    if data.get("neuro_intact") is not None:
        components.append({"code": {"text": "Neurological Intact"}, "valueBoolean": data["neuro_intact"]})
    for flag in (data.get("red_flags") or []):
        components.append({"code": {"text": "Red Flag"}, "valueString": flag})

    observation = {
        "resourceType": "Observation",
        "status": "final" if data.get("assessment_complete") else "preliminary",
        "code": {"text": "Musculoskeletal Triage Assessment"},
        "effectiveDateTime": now,
        "component": components,
    }

    entries = [{"resource": condition}, {"resource": observation}]

    for site in (data.get("additional_sites") or []):
        entries.append({"resource": {
            "resourceType": "Condition",
            "clinicalStatus": condition["clinicalStatus"],
            "verificationStatus": condition["verificationStatus"],
            "bodySite": [{"text": site}],
            "note": [{"text": "Additional injury site — awaiting full assessment"}],
            "recordedDate": now,
        }})

    return {
        "resourceType": "Bundle",
        "type": "collection",
        "timestamp": now,
        "entry": entries,
    }


SEVERITY_LABELS = {
    1: ("沒事", "繼續觀察即可，若有不適再就醫。"),
    2: ("小傷自理", "建議冰敷、清潔傷口，至藥局購買所需用品。"),
    3: ("建議就醫", "建議 48 小時內至骨科或診所確認。"),
    4: ("需要就醫", "建議今天前往急診，如有可能請人陪同。"),
    5: ("緊急送醫", "請立即聯絡 119 或請旁人協助送醫。"),
}


def build_summary_card(data: dict, evidence: dict = None) -> dict:
    severity = data.get("severity", 1)
    label, advice = SEVERITY_LABELS.get(severity, SEVERITY_LABELS[1])
    return {
        "body_site":          data.get("body_site"),
        "pain_score":         data.get("pain_score"),
        "weight_bearing":     data.get("weight_bearing", "unknown"),
        "mechanism":          data.get("mechanism"),
        "key_finding":        data.get("key_finding"),
        "severity":           severity,
        "severity_label":     label,
        "advice":             advice,
        "assessment_complete": data.get("assessment_complete", False),
        "ottawa_result":       data.get("ottawa_result", "untested"),
        "special_tests":       data.get("special_tests") or [],
        "neuro_intact":        data.get("neuro_intact"),
        "red_flags":           data.get("red_flags") or [],
        "additional_sites":    data.get("additional_sites") or [],
        "evidence":            evidence or {},
    }
