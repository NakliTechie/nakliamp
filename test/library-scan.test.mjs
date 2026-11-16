// Scan helpers: folder-art choice and the reparse rule.
import test from 'node:test';
import assert from 'node:assert/strict';

import { pickFolderArt, folderArtMime, needsReparse } from '../app/library/scan-core.mjs';
import { PARSER_VERSION } from '../app/library/metadata.mjs';

test('folder art prefers cover, then folder, front, album; case-insensitive', () => {
  assert.equal(pickFolderArt(['01.mp3', 'front.png', 'Folder.JPG']), 'Folder.JPG');
  assert.equal(pickFolderArt(['album.webp', 'FRONT.jpeg']), 'FRONT.jpeg');
  assert.equal(pickFolderArt(['cover.png', 'cover.jpg']), 'cover.jpg');
  assert.equal(pickFolderArt(['Cover.Webp']), 'Cover.Webp');
  assert.equal(pickFolderArt(['back.jpg', 'cover.gif', 'cover.jpg.bak', 'scan.png']), null);
  assert.equal(pickFolderArt([]), null);
});

test('folder art MIME follows the extension', () => {
  assert.equal(folderArtMime('a/Cover.PNG'), 'image/png');
  assert.equal(folderArtMime('front.jpeg'), 'image/jpeg');
  assert.equal(folderArtMime('album.webp'), 'image/webp');
});

test('an unchanged file is skipped unless its parser version is older', () => {
  const file = { size: 10, lastModified: 5 };
  assert.equal(needsReparse(null, file), true);
  assert.equal(needsReparse({ size: 10, lastModified: 5, parserVersion: PARSER_VERSION }, file), false);
  assert.equal(needsReparse({ size: 10, lastModified: 5, parserVersion: PARSER_VERSION - 1 }, file), true);
  assert.equal(needsReparse({ size: 10, lastModified: 5 }, file), true, 'a row with no version predates versioning');
  assert.equal(needsReparse({ size: 11, lastModified: 5, parserVersion: PARSER_VERSION }, file), true);
  assert.equal(needsReparse({ size: 10, lastModified: 6, parserVersion: PARSER_VERSION }, file), true);
});
