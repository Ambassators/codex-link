import test from 'node:test';
import assert from 'node:assert/strict';
import { Updates } from '../src/updates.mjs';

test('update queue bounds batches and cancels revoked recipients', () => {
  const queue = new Updates(), connections = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
  for (let n = 0; n < 50; n++) queue.add({ grantId: 'a', text: String(n) }, connections);
  assert.throws(() => queue.add({ grantId: 'b', text: 'full' }, connections), /full/);
  assert.equal(queue.take('b').length, 0);
  assert.deepEqual(queue.take('a').map(i => i.text), Array.from({ length: 10 }, (_, n) => String(n)));
  assert.equal(queue.take('a')[0].text, '10');
  queue.list([connections[1]]);
  assert.equal(queue.take('a').length, 0);
  for (let n = 0; n < 120; n++) { queue.add({ grantId: 'b', text: String(n) }, connections); queue.take('b'); }
  assert.equal(queue.list(connections).length, 100);
});
