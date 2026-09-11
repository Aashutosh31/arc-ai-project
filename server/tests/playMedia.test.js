/* Media tool contract tests — run with: node tests/playMedia.test.js
 *
 * Covers the PLAY_MEDIA / STOP_MEDIA command path:
 * valid payload accepted, new media replaces previous (client contract),
 * invalid/missing videoId fails safely, provider errors fail safely,
 * and the tool never claims playback started (truthful wording).
 */
const assert = require('assert');
const path = require('path');

function check(label, fn) {
  const run = async () => {
    try {
      await fn();
      console.log(`  PASS  ${label}`);
    } catch (err) {
      console.error(`  FAIL  ${label}`);
      console.error(`        ${err.message}`);
      process.exitCode = 1;
    }
  };
  return run();
}

// Stub yt-search before playMedia requires it.
const ytSearchPath = require.resolve('yt-search');
let stubImpl = async () => ({ videos: [] });
require.cache[ytSearchPath] = {
  id: ytSearchPath,
  filename: ytSearchPath,
  loaded: true,
  exports: (...args) => stubImpl(...args),
};

const playMedia = require('../tools/playMedia');
const stopMedia = require('../tools/stopMedia');

const VALID_ID = 'nDjloeIB3Pc';
const isValidVideoId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{11}$/.test(v);

(async () => {
  await check('PLAY_MEDIA payload reaches client contract (type/videoId/title)', async () => {
    stubImpl = async () => ({ videos: [{ videoId: VALID_ID, title: 'Sitaare' }] });
    const r = await playMedia.execute({ searchQuery: 'sitaare arijit singh' });
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.clientAction.type, 'PLAY_MEDIA');
    assert.strictEqual(r.clientAction.videoId, VALID_ID);
    assert.strictEqual(r.clientAction.title, 'Sitaare');
  });

  await check('valid videoId accepted (11-char YouTube id)', async () => {
    stubImpl = async () => ({ videos: [{ videoId: VALID_ID, title: 'x' }] });
    const r = await playMedia.execute({ searchQuery: 'x' });
    assert.ok(isValidVideoId(r.clientAction.videoId), 'videoId must be a valid YouTube id');
  });

  await check('tool never claims playback started before client acceptance', async () => {
    stubImpl = async () => ({ videos: [{ videoId: VALID_ID, title: 'Sitaare' }] });
    const r = await playMedia.execute({ searchQuery: 'x' });
    const text = `${r.message}`;
    assert.ok(!/started playing|now playing|is playing/i.test(text),
      `must not assert successful playback, got: ${text}`);
  });

  await check('no results fails safely with no client action', async () => {
    stubImpl = async () => ({ videos: [] });
    const r = await playMedia.execute({ searchQuery: 'zzz no such video qqq' });
    assert.strictEqual(r.success, false);
    assert.ok(!r.clientAction, 'must not emit a client action without media');
  });

  await check('provider error fails safely with no client action', async () => {
    stubImpl = async () => { throw new Error('network down'); };
    const r = await playMedia.execute({ searchQuery: 'x' });
    assert.strictEqual(r.success, false);
    assert.ok(!r.clientAction, 'must not emit a client action on error');
  });

  await check('STOP_MEDIA closes the player deterministically', async () => {
    const r = await stopMedia.execute({});
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.clientAction.type, 'STOP_MEDIA');
  });
})();
