// The one parsing rule for list options (`kind: 'list'`; review 0013 N4): shared by the form
// (client/js/forms.js), the generator option coercion (server/generators/common.js toList) and
// the values of a Lặp "Mỗi giá trị trong danh sách" (shared/scope.js valueList). Pure.
//
// One value per line: a comma is part of the value ("Hot, cold" stays one value), spaces around a
// value are trimmed, empty lines are dropped. An array is taken item by item the same way.
// (Lists of field names — Query "Field cần lấy" — also accept commas: field names cannot hold one,
// see shared/soql.js. `kind: 'numberList'` still splits on commas and semicolons.)

/** Values of a list option: trimmed strings, empty ones dropped. */
export function splitList(raw) {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split('\n') : raw === undefined || raw === null ? [] : [raw];
  return list.map((v) => String(v ?? '').trim()).filter((v) => v !== '');
}
