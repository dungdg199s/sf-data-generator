// Maps an sObject describe result to record-node field specs with sensible defaults,
// so importing an object from the org gives a working node in one click.

const SKIP_TYPES = new Set(['id', 'address', 'anyType', 'base64', 'complexvalue', 'json']);

const NAME_HINTS = {
  firstname: { mode: 'firstName' },
  lastname: { mode: 'lastName' },
  city: { mode: 'city' },
  billingcity: { mode: 'city' },
  shippingcity: { mode: 'city' },
  mailingcity: { mode: 'city' },
};

export function mapDescribe(describe) {
  const fields = [];
  for (const f of describe.fields ?? []) {
    if (!f.createable || f.calculated || f.autoNumber || SKIP_TYPES.has(f.type)) continue;
    // Compound geolocation parts are created through the parent field.
    if (f.compoundFieldName && describe.fields.some((p) => p.name === f.compoundFieldName && p.type === 'location')) continue;
    const spec = mapField(f, describe.name);
    if (!spec) continue;
    const required = !f.nillable && !f.defaultedOnCreate && f.type !== 'boolean';
    fields.push({ ...spec, label: f.label, required, referenceTo: f.referenceTo?.length ? f.referenceTo : undefined });
  }
  // Required first, then alphabetical, so the import dialog's pre-selected rows sit on top.
  fields.sort((a, b) => Number(b.required) - Number(a.required) || a.name.localeCompare(b.name));
  return { sobject: describe.name, label: describe.label, fields };
}

function mapField(f, sobject) {
  const name = f.name;
  const o = {};
  switch (f.type) {
    case 'string':
    case 'combobox': {
      o.maxLength = Math.min(f.length || 255, 255);
      const hint = NAME_HINTS[name.toLowerCase()];
      if (hint) Object.assign(o, hint);
      else if (name === 'Name') o.mode = sobject === 'Account' ? 'company' : 'name';
      if (f.unique) o.unique = true;
      return { name, type: 'text', options: o };
    }
    case 'textarea': {
      const kind = f.extraTypeInfo === 'richtextarea' ? 'richtextarea' : f.length > 255 ? 'longtextarea' : 'textarea';
      o.maxLength = f.length || 255;
      return { name, type: kind, options: o };
    }
    case 'encryptedstring':
      return { name, type: 'encryptedtext', options: { maxLength: Math.min(f.length || 175, 175) } };
    case 'email':
      return { name, type: 'email', options: o };
    case 'phone':
      return { name, type: 'phone', options: o };
    case 'url':
      return { name, type: 'url', options: o };
    case 'int':
    case 'long':
    case 'double':
    case 'currency':
    case 'percent': {
      const scale = f.scale ?? 0;
      const intDigits = Math.max(1, (f.precision || 18) - scale);
      const type = f.type === 'currency' ? 'currency' : f.type === 'percent' ? 'percent' : 'number';
      o.scale = scale;
      o.min = 0;
      o.max = type === 'percent' ? 100 : Math.min(10 ** Math.min(intDigits, 9) - 1, type === 'currency' ? 100000 : 1000);
      if (f.unique) o.unique = true;
      return { name, type, options: o };
    }
    case 'boolean':
      return { name, type: 'checkbox', options: o };
    case 'date':
      return { name, type: 'date', options: o };
    case 'datetime':
      return { name, type: 'datetime', options: o };
    case 'time':
      return { name, type: 'time', options: o };
    case 'picklist':
    case 'multipicklist': {
      o.values = (f.picklistValues ?? []).filter((v) => v.active).map((v) => v.value);
      if (!o.values.length) return null;
      return { name, type: f.type, options: o };
    }
    case 'reference': {
      if (!f.referenceTo?.length) return null;
      const isMasterDetail = f.relationshipOrder !== null && f.relationshipOrder !== undefined;
      // Parent alias is unknown until the user picks it; referenceTo narrows the "Bản ghi cha" list.
      return { name, type: isMasterDetail ? 'masterdetail' : 'lookup', options: { mode: 'current', ref: '', referenceTo: [...f.referenceTo] } };
    }
    case 'location':
      return { name, type: 'geolocation', options: { scale: f.scale ?? 6 } };
    default:
      return null;
  }
}
