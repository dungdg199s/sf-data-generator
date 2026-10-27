// Inserts generated records into an org, resolving { $ref } lookup placeholders.
//
// Records are inserted in "waves": a record is ready once every record it references has an
// Id. Parents therefore land before children, and self-lookups (Account.ParentId) work across
// waves. A child whose parent failed is reported as failed without being sent.

const BATCH_SIZE = 200; // sObject Collections limit; batching here also drives progress reporting.

export function collectRefs(fields) {
  const refs = [];
  for (const v of Object.values(fields)) if (v && typeof v === 'object' && typeof v.$ref === 'string') refs.push(v.$ref);
  return refs;
}

/** Field values as sent to Salesforce (jsforce adds the sObject `attributes`). */
export function toSObject(record, idByRef) {
  const out = {};
  for (const [name, v] of Object.entries(record.fields)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object' && '$ref' in v) out[name] = idByRef.get(v.$ref);
    else if (typeof v === 'object' && 'latitude' in v && 'longitude' in v) {
      const base = name.replace(/__c$/i, '');
      out[`${base}__Latitude__s`] = v.latitude;
      out[`${base}__Longitude__s`] = v.longitude;
    } else out[name] = v;
  }
  return out;
}

export async function insertRecords(client, target, records, { onProgress } = {}) {
  const idByRef = new Map();
  const errors = []; // { ref, sobject, message }
  const failedRefs = new Set();
  let pending = records;
  let inserted = 0;

  while (pending.length) {
    const ready = [];
    const waiting = [];
    for (const r of pending) {
      const deps = collectRefs(r.fields);
      const failedDep = deps.find((d) => failedRefs.has(d));
      if (failedDep) {
        failedRefs.add(r.ref);
        errors.push({ ref: r.ref, sobject: r.sobject, message: `Bỏ qua vì bản ghi cha ${failedDep} lỗi.` });
      } else if (deps.every((d) => idByRef.has(d))) ready.push(r);
      else waiting.push(r);
    }
    if (!ready.length) {
      for (const r of waiting) {
        failedRefs.add(r.ref);
        errors.push({ ref: r.ref, sobject: r.sobject, message: 'Không xác định được Id bản ghi cha.' });
      }
      break;
    }

    const bySobject = new Map();
    for (const r of ready) {
      if (!bySobject.has(r.sobject)) bySobject.set(r.sobject, []);
      bySobject.get(r.sobject).push(r);
    }
    for (const [sobject, group] of bySobject) {
      for (let i = 0; i < group.length; i += BATCH_SIZE) {
        const chunk = group.slice(i, i + BATCH_SIZE);
        let results;
        try {
          results = await client.create(target, sobject, chunk.map((r) => toSObject(r, idByRef)));
        } catch (e) {
          results = chunk.map(() => ({ success: false, errors: [{ message: e.message }] }));
        }
        chunk.forEach((r, idx) => {
          const res = results[idx];
          if (res?.success) {
            idByRef.set(r.ref, res.id);
            inserted++;
          } else {
            failedRefs.add(r.ref);
            const msg = (res?.errors ?? []).map((er) => `${er.statusCode ? er.statusCode + ': ' : ''}${er.message}${er.fields?.length ? ` [${er.fields.join(', ')}]` : ''}`).join('; ');
            errors.push({ ref: r.ref, sobject: r.sobject, message: msg || 'Lỗi không rõ.' });
          }
        });
        onProgress?.({ inserted, failed: errors.length, total: records.length });
      }
    }
    pending = waiting;
  }

  return { inserted, failed: errors.length, errors, ids: Object.fromEntries(idByRef) };
}
