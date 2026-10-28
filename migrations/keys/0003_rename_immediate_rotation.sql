UPDATE rotation_actions
  SET action = 'rotation.immediate' || substr(action, length('rotation.emergency') + 1)
  WHERE action = 'rotation.emergency' OR action LIKE 'rotation.emergency.%';
UPDATE rotation_evidence
  SET evidence_json = json_set(json_remove(evidence_json, '$.emergency'), '$.immediate', json_extract(evidence_json, '$.emergency'))
  WHERE json_valid(evidence_json) AND json_type(evidence_json, '$.emergency') IS NOT NULL;
