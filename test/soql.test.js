// Design 0006: pure SOQL helpers shared by validation, pre-fetch and the browser (shared/soql.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSoql, checkSoql, checkBuilder, selectFields, soqlSobject, sampleRows, normalizeRow, parseSoql, maxFetchFor, rekeyRow, addSelectField } from '../shared/soql.js';

test('buildSoql adds Id once, ORDER BY and LIMIT', () => {
  assert.equal(buildSoql({}), 'SELECT Id, Name FROM Account ORDER BY Id LIMIT 200');
  assert.equal(
    buildSoql({ sobject: 'Contact', fields: ['Name', 'id', 'Owner.Name'], where: "Email != null", orderBy: 'CreatedDate DESC', limit: 50 }),
    'SELECT Id, Name, Owner.Name FROM Contact WHERE Email != null ORDER BY CreatedDate DESC LIMIT 50',
  );
  assert.equal(buildSoql({ sobject: 'Lead', fields: 'Name\nCompany', orderBy: '' }), 'SELECT Id, Name, Company FROM Lead LIMIT 200');
  assert.equal(buildSoql({ mode: 'soql', soql: ' SELECT Id FROM User ; ' }), 'SELECT Id FROM User');
  assert.equal(maxFetchFor({ limit: 50 }, 2000), 50);
  assert.equal(maxFetchFor({ mode: 'soql', soql: 'SELECT Id FROM Account' }, 2000), 2000);
  assert.equal(maxFetchFor({ mode: 'soql', soql: 'SELECT Id FROM Account LIMIT 9000' }, 2000), 2000);
});

test('checkSoql rejects non-SELECT, FOR UPDATE and {{ }}; warns on ORDER BY, Id and subqueries', () => {
  const codes = (t) => checkSoql(t).map((i) => `${i.code}:${i.level}`);
  assert.deepEqual(codes('DELETE FROM Account'), ['notSelect:error']);
  assert.deepEqual(codes(''), ['notSelect:error']);
  assert.deepEqual(codes('SELECT Id, Name'), ['noFrom:error']);
  assert.deepEqual(codes('SELECT Id FROM Account ORDER BY Id FOR UPDATE'), ['forClause:error']);
  assert.deepEqual(codes('SELECT Id FROM Account FOR VIEW'), ['forClause:error']);
  assert.deepEqual(codes("SELECT Id FROM Account WHERE Id = '{{acc.Id}}' ORDER BY Id"), ['template:error']);
  assert.deepEqual(codes('SELECT Name FROM Account'), ['noOrderBy:warning', 'noId:warning']);
  assert.deepEqual(codes('SELECT Id, (SELECT Id FROM Contacts) FROM Account ORDER BY Id'), ['subquery:warning']);
  // Keywords inside string literals do not count.
  assert.deepEqual(codes("SELECT Id FROM Account WHERE Name = 'x FOR UPDATE' ORDER BY Id"), []);
  assert.equal(checkSoql('DELETE FROM Account')[0].message, 'SOQL phải bắt đầu bằng SELECT. Bước Query chỉ đọc dữ liệu.');
  assert.equal(checkSoql('SELECT Id FROM Account FOR UPDATE')[0].message, 'Bỏ FOR UPDATE / FOR VIEW / FOR REFERENCE: các lệnh này khóa hoặc đánh dấu bản ghi trong org.');
});

test('checkBuilder: {{ }} in WHERE / ORDER BY, and ORDER BY / LIMIT written inside WHERE', () => {
  assert.deepEqual(checkBuilder({ where: 'AccountId = {{acc.Id}}' }).map((i) => `${i.field}:${i.code}`), ['where:template']);
  assert.deepEqual(checkBuilder({ where: 'Industry != null LIMIT 5' }).map((i) => `${i.field}:${i.code}`), ['where:whereClause']);
  assert.deepEqual(checkBuilder({ where: "Name = 'LIMIT 5'", orderBy: 'Id LIMIT 3' }).map((i) => `${i.field}:${i.code}`), ['orderBy:orderByLimit']);
  assert.deepEqual(checkBuilder({ where: 'IsActive = true FOR UPDATE' }).map((i) => i.code), ['forClause']);
  assert.equal(checkBuilder({ where: 'x LIMIT 1' })[0].message, 'Đặt ORDER BY và LIMIT ở ô riêng, không viết trong "Điều kiện (WHERE)".');
});

test('selectFields parses relationship fields and ignores subqueries', () => {
  const q = { mode: 'soql', soql: 'SELECT Id, UnitPrice, Product2.Name, (SELECT Id FROM Things__r), toLabel(Status__c), COUNT(Id) n FROM PricebookEntry WHERE IsActive = true ORDER BY Id LIMIT 500' };
  assert.deepEqual(selectFields(q), { fields: ['Id', 'UnitPrice', 'Product2.Name', 'Status__c', 'n'], open: false });
  assert.equal(soqlSobject(q), 'PricebookEntry');
  assert.equal(parseSoql(q.soql).limit, 500);
  assert.equal(selectFields({ mode: 'soql', soql: 'SELECT FIELDS(STANDARD) FROM Account' }).open, true);
  assert.deepEqual(selectFields({ fields: ['Name', 'Name'] }).fields, ['Id', 'Name']);
});

test('sampleRows is deterministic and nests relationship fields', () => {
  const c = { sobject: 'Contact', fields: ['Name', 'Owner.Name', 'Email'], limit: 200 };
  const a = sampleRows(c, 'cons');
  assert.deepEqual(a, sampleRows(c, 'cons'));
  assert.equal(a.length, 5);
  assert.deepEqual(a[0], { Id: 'mẫu:cons#1', Name: 'Contact mẫu 1', Owner: { Name: 'Owner.Name mẫu 1' }, Email: 'Email mẫu 1' });
  assert.equal(sampleRows({ ...c, limit: 1 }, 'pb').length, 1);
});

test('normalizeRow drops attributes recursively and subquery results', () => {
  const row = { attributes: { type: 'Account' }, Id: '001', Owner: { attributes: { type: 'User' }, Name: 'Lan' }, Contacts: { totalSize: 1, done: true, records: [] }, Phone: null };
  assert.deepEqual(normalizeRow(row), { Id: '001', Owner: { Name: 'Lan' }, Phone: null });
});

// ---------- review fixes (0006 "Sửa sau review") ----------

test('read-only check: UPDATE VIEWSTAT / TRACKING, FOR … inside parentheses and ";" are refused (raw and builder)', () => {
  const errors = (t) => checkSoql(t).filter((i) => i.level === 'error').map((i) => i.code);
  assert.deepEqual(errors("SELECT Id FROM KnowledgeArticleVersion WHERE PublishStatus='Online' AND Language='en_US' UPDATE VIEWSTAT"), ['update']);
  assert.deepEqual(errors("SELECT Id FROM FAQ__kav WHERE PublishStatus='Online' WITH DATA CATEGORY Geography__c AT usa__c UPDATE TRACKING"), ['update']);
  assert.deepEqual(errors('SELECT Id FROM Account update   viewstat'), ['update']);
  assert.deepEqual(errors('SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM Contact FOR VIEW)'), ['forClause']);
  assert.deepEqual(errors('SELECT Id, (SELECT Id FROM Contacts FOR REFERENCE) FROM Account'), ['forClause']);
  assert.deepEqual(errors('SELECT Id FROM Account\nFOR\tUPDATE'), ['forClause']);
  assert.deepEqual(errors('SELECT Id FROM Account; DELETE FROM Account'), ['semicolon']);
  assert.deepEqual(errors('SELECT Id FROM Account;'), ['semicolon']);
  // Inside string literals the words and ";" are data.
  assert.deepEqual(errors("SELECT Id FROM Account WHERE Name = 'x; UPDATE VIEWSTAT FOR VIEW' ORDER BY Id"), []);
  assert.deepEqual(errors("SELECT Id FROM Account WHERE Name = 'x\\' FOR VIEW' ORDER BY Id"), []);
  assert.equal(checkSoql('SELECT Id FROM Account UPDATE VIEWSTAT').find((i) => i.code === 'update').message,
    'Bỏ UPDATE (UPDATE VIEWSTAT / UPDATE TRACKING): lệnh này ghi số liệu vào org. Bước Query chỉ đọc dữ liệu.');
  const builder = (c) => checkBuilder(c).map((i) => `${i.field}:${i.code}`);
  assert.deepEqual(builder({ where: "Name='x' UPDATE VIEWSTAT" }), ['where:update']);
  assert.deepEqual(builder({ orderBy: 'Id UPDATE TRACKING' }), ['orderBy:update']);
  assert.deepEqual(builder({ where: 'Id IN (SELECT AccountId FROM Contact FOR VIEW)' }), ['where:forClause']);
  assert.deepEqual(builder({ where: "Name = 'a'; DELETE" }), ['where:semicolon']);
  assert.deepEqual(builder({ orderBy: 'Id) FROM Lead' }), ['orderBy:parens']);
  assert.deepEqual(builder({ where: "Name = 'a;b' AND Note__c = 'update'" }), []);
});

test('LIMIT 0 gives maxFetch 0 (the caller then skips jsforce, whose 0 would mean its default)', () => {
  assert.equal(maxFetchFor({ mode: 'soql', soql: 'SELECT Id FROM Account LIMIT 0' }, 2000), 0);
  assert.deepEqual(sampleRows({ mode: 'soql', soql: 'SELECT Id FROM Account LIMIT 0' }, 'a'), []);
});

test('rekeyRow and sampleRows use the spelling of the SELECT list, case-insensitively, through relationships', () => {
  const row = { Id: '001', Name: 'Acme', Owner: { Name: 'Lan', Email: 'l@x' }, Industry: 'Banking' };
  assert.deepEqual(rekeyRow(row, ['id', 'name', 'owner.name', 'Owner.email']), { id: '001', name: 'Acme', owner: { name: 'Lan', email: 'l@x' }, Industry: 'Banking' });
  const sample = sampleRows({ mode: 'soql', soql: 'SELECT id, name, owner.Name, OWNER.Email FROM Contact LIMIT 1' }, 'cons')[0];
  assert.deepEqual(sample, { id: 'mẫu:cons#1', name: 'Contact mẫu 1', owner: { Name: 'owner.Name mẫu 1', Email: 'OWNER.Email mẫu 1' } });
});

// Design 0012 F1: "Thêm <Field> vào SELECT" on hand-written SOQL.
test('addSelectField appends to the outer SELECT list of plain SOQL', () => {
  assert.equal(addSelectField('SELECT Id, Name FROM Account', 'Industry'), 'SELECT Id, Name, Industry FROM Account');
  // WHERE / ORDER BY / LIMIT and the spacing (a newline before FROM) are kept.
  assert.equal(
    addSelectField("SELECT Id, Name\nFROM Account WHERE Name LIKE 'A FROM%' ORDER BY Id LIMIT 10", 'Owner.Email'),
    "SELECT Id, Name, Owner.Email\nFROM Account WHERE Name LIKE 'A FROM%' ORDER BY Id LIMIT 10",
  );
  assert.equal(addSelectField('select Id from Contact', 'Email'), 'select Id, Email from Contact');
  assert.equal(addSelectField('SELECT Id, toLabel(Status) FROM Case', 'Subject'), 'SELECT Id, toLabel(Status), Subject FROM Case');
  // A parenthesised WHERE (a semi-join) is not a SELECT-list subquery.
  assert.equal(
    addSelectField('SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM Contact)', 'Name'),
    'SELECT Id, Name FROM Account WHERE Id IN (SELECT AccountId FROM Contact)',
  );
});

test('addSelectField: field already there is unchanged; subquery, FIELDS(ALL), broken SOQL → null', () => {
  assert.equal(addSelectField('SELECT Id, industry FROM Account', 'Industry'), 'SELECT Id, industry FROM Account');
  assert.equal(addSelectField('SELECT Id, (SELECT Id FROM Contacts) FROM Account', 'Name'), null);
  assert.equal(addSelectField('SELECT FIELDS(ALL) FROM Account LIMIT 200', 'Name'), null);
  assert.equal(addSelectField('SELECT TYPEOF What WHEN Account THEN Name END FROM Task', 'Subject'), null);
  assert.equal(addSelectField('SELECT Id FROM', 'Name'), null);
  assert.equal(addSelectField('DELETE FROM Account', 'Name'), null);
  assert.equal(addSelectField('SELECT Id FROM Account FOR UPDATE', 'Name'), null);
  assert.equal(addSelectField('SELECT Id FROM Account WHERE Id = {{acc.Id}}', 'Name'), null);
  assert.equal(addSelectField('SELECT Id FROM Account', 'bad field'), null);
  assert.equal(addSelectField('', 'Name'), null);
});
