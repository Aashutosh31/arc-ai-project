/* Theme catalog integrity — run with: node tests/themeCatalog.test.js
 *
 * Verifies the single source of truth (shared/themes.json):
 * stable ids present, unique ids, picker metadata complete, and the
 * changeTheme tool enum/validation derived from the same catalog.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

function check(label, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => console.log(`  PASS  ${label}`),
        (err) => { console.error(`  FAIL  ${label}\n        ${err.message}`); process.exitCode = 1; }
      );
    }
    console.log(`  PASS  ${label}`);
  } catch (err) {
    console.error(`  FAIL  ${label}\n        ${err.message}`);
    process.exitCode = 1;
  }
}

const catalogPath = path.join(__dirname, '..', '..', 'shared', 'themes.json');
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const changeTheme = require('../tools/changeTheme');

(async () => {
  check('catalog has default id and 9 themes', () => {
    assert.strictEqual(catalog.defaultId, 'default');
    assert.strictEqual(catalog.themes.length, 9);
  });

  check('stable legacy ids preserved (default/hacker/alert/arc-light)', () => {
    const ids = catalog.themes.map((t) => t.id);
    for (const id of ['default', 'hacker', 'alert', 'arc-light']) {
      assert.ok(ids.includes(id), `missing ${id}`);
    }
  });

  check('ids unique; every theme has name/description/preview/colorScheme', () => {
    const ids = catalog.themes.map((t) => t.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'duplicate ids');
    for (const t of catalog.themes) {
      assert.ok(t.name && t.description, `${t.id} missing name/description`);
      assert.ok(Array.isArray(t.preview) && t.preview.length >= 3, `${t.id} missing preview`);
      assert.ok(['dark', 'light'].includes(t.colorScheme), `${t.id} bad colorScheme`);
    }
  });

  check('changeTheme enum matches catalog ids exactly', () => {
    const enumIds = changeTheme.schema.function.parameters.properties.theme.enum;
    assert.deepStrictEqual([...enumIds].sort(), [...catalog.themes.map((t) => t.id)].sort());
  });

  check('changeTheme accepts every catalog id', async () => {
    for (const t of catalog.themes) {
      const r = await changeTheme.execute({ theme: t.id });
      assert.strictEqual(r.success, true, t.id);
      assert.strictEqual(r.clientAction.theme, t.id);
    }
  });

  await check('changeTheme rejects unknown id with validation error', async () => {
    const r = await changeTheme.execute({ theme: 'dracula-2' });
    assert.strictEqual(r.success, false);
    assert.ok(!r.clientAction, 'must not emit a client action for unknown theme');
  });
})();
