import { assert, id } from './util.mjs';

// Ephemeral, connection-scoped owner messages. Never broadcast between grants.
export class Updates {
  constructor() { this.items = []; }
  list(connections) {
    const active = new Set(connections.map(c => c.id));
    for (const item of this.items) if (item.status === 'queued' && !active.has(item.grantId)) item.status = 'cancelled';
    return [...this.items].reverse().map(item => ({ ...item }));
  }
  add(body, connections) {
    assert(body && typeof body.text === 'string' && body.text.trim().length > 0 && body.text.length <= 4000, 'Update must contain 1–4000 characters');
    const connection = connections.find(c => c.id === body.grantId);
    assert(connection, 'Choose an active connection');
    this.list(connections);
    assert(this.items.filter(i => i.status === 'queued').length < 50, 'Update queue is full; wait for delivery or cancel an update', 429);
    const item = { id: id(), grantId: connection.id, connectionName: connection.name || 'MCP client', text: body.text.trim(), createdAt: new Date().toISOString(), status: 'queued' };
    this.items.push(item);
    while (this.items.length > 100) this.items.splice(this.items.findIndex(i => i.status !== 'queued'), 1);
    return { ...item };
  }
  cancel(updateId) {
    const item = this.items.find(i => i.id === updateId);
    assert(item, 'Unknown update', 404);
    assert(item.status === 'queued', 'Update is no longer queued', 409);
    item.status = 'cancelled';
    return { ...item };
  }
  take(grantId) {
    // Bound the response size; remaining messages accompany later calls.
    return this.items.filter(i => i.grantId === grantId && i.status === 'queued').slice(0, 10).map(item => {
      item.status = 'returned';
      return { id: item.id, createdAt: item.createdAt, text: item.text };
    });
  }
}
