// "Thiếu n field bắt buộc" (design 0012 F2): which required fields of an sObject's describe a
// Record step does not have yet. Pure, no imports: test/required-fields.test.js runs it in Node.

/**
 * Required fields of `described` (mapDescribe: `{ sobject, fields: [{ name, required, … }] }`) that
 * are not in `fields` (the step's field list; API names compared ignoring case), in describe order.
 */
export function missingRequired(fields, described) {
  const have = new Set((Array.isArray(fields) ? fields : []).map((f) => String(f?.name ?? '').trim().toLowerCase()).filter(Boolean));
  return (described?.fields ?? []).filter((f) => f?.required && f.name && !have.has(f.name.toLowerCase()));
}

/** `Thiếu 2 field bắt buộc của Opportunity trong dev-sb: StageName, CloseDate.` */
export function requiredHintText(missing, sobject, org) {
  return `Thiếu ${missing.length} field bắt buộc của ${sobject} trong ${org}: ${missing.map((f) => f.name).join(', ')}.`;
}
