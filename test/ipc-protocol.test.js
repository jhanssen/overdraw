// Pure-unit tests for the JSON-RPC 2.0 protocol layer (src/ipc/protocol.ts).
// No socket / no I/O; just message classification + serialization helpers.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseMessage, isRequest, ok, err, notify, encode, JSONRPC_ERRORS,
} from '../packages/core/dist/ipc/protocol.js';

// --- parseMessage ---------------------------------------------------------

test('parseMessage: returns the parsed object', () => {
  assert.deepEqual(parseMessage('{"jsonrpc":"2.0","id":1,"method":"x"}'),
    { jsonrpc: '2.0', id: 1, method: 'x' });
});

test('parseMessage: throws on invalid JSON', () => {
  assert.throws(() => parseMessage('not json'), SyntaxError);
});

// --- isRequest ------------------------------------------------------------

test('isRequest: valid request returns true', () => {
  assert.equal(isRequest({ jsonrpc: '2.0', id: 1, method: 'x' }), true);
  assert.equal(isRequest({ jsonrpc: '2.0', id: 'a', method: 'x', params: { y: 1 } }), true);
});

test('isRequest: missing jsonrpc -> false', () => {
  assert.equal(isRequest({ id: 1, method: 'x' }), false);
});

test('isRequest: wrong jsonrpc version -> false', () => {
  assert.equal(isRequest({ jsonrpc: '1.0', id: 1, method: 'x' }), false);
});

test('isRequest: missing id -> false (notification)', () => {
  assert.equal(isRequest({ jsonrpc: '2.0', method: 'x' }), false);
});

test('isRequest: missing method -> false', () => {
  assert.equal(isRequest({ jsonrpc: '2.0', id: 1 }), false);
});

test('isRequest: empty method -> false', () => {
  assert.equal(isRequest({ jsonrpc: '2.0', id: 1, method: '' }), false);
});

test('isRequest: non-string method -> false', () => {
  assert.equal(isRequest({ jsonrpc: '2.0', id: 1, method: 42 }), false);
});

test('isRequest: null / array / non-object -> false', () => {
  assert.equal(isRequest(null), false);
  assert.equal(isRequest([]), false);
  assert.equal(isRequest('string'), false);
});

// --- ok / err / notify ----------------------------------------------------

test('ok: builds a success response', () => {
  assert.deepEqual(ok(1, 42), { jsonrpc: '2.0', id: 1, result: 42 });
  assert.deepEqual(ok('abc', null), { jsonrpc: '2.0', id: 'abc', result: null });
  assert.deepEqual(ok(null, [1, 2]), { jsonrpc: '2.0', id: null, result: [1, 2] });
});

test('err: builds an error response without data', () => {
  assert.deepEqual(err(1, -32601, 'Method not found'),
    { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } });
});

test('err: builds an error response WITH data', () => {
  assert.deepEqual(err(1, -32000, 'Action failed', { kind: 'boom' }),
    { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Action failed', data: { kind: 'boom' } } });
});

test('err: id may be null (parse error before id was readable)', () => {
  assert.deepEqual(err(null, -32700, 'Parse error'),
    { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
});

test('notify: builds a one-way notification (no id)', () => {
  assert.deepEqual(notify('event', { subscription: 's1', name: 'window.map', payload: null }),
    { jsonrpc: '2.0', method: 'event', params: { subscription: 's1', name: 'window.map', payload: null } });
});

// --- encode ---------------------------------------------------------------

test('encode: serializes + terminates with newline', () => {
  assert.equal(encode(ok(1, 42)), '{"jsonrpc":"2.0","id":1,"result":42}\n');
});

test('encode: each message ends in exactly one newline', () => {
  const wire = encode(notify('event', { x: 1 }));
  assert.match(wire, /\n$/);
  assert.equal(wire.split('\n').length, 2);   // body + ""
});

// --- error code constants -------------------------------------------------

test('error codes match the JSON-RPC 2.0 spec', () => {
  assert.equal(JSONRPC_ERRORS.PARSE_ERROR, -32700);
  assert.equal(JSONRPC_ERRORS.INVALID_REQUEST, -32600);
  assert.equal(JSONRPC_ERRORS.METHOD_NOT_FOUND, -32601);
  assert.equal(JSONRPC_ERRORS.INVALID_PARAMS, -32602);
  assert.equal(JSONRPC_ERRORS.INTERNAL_ERROR, -32603);
});

test('implementation-defined error codes are in the reserved server range', () => {
  // Per spec: -32000 to -32099 reserved for implementation server errors.
  assert.ok(JSONRPC_ERRORS.ACTION_FAILED <= -32000 && JSONRPC_ERRORS.ACTION_FAILED >= -32099);
  assert.ok(JSONRPC_ERRORS.SUBSCRIPTION_UNKNOWN <= -32000 && JSONRPC_ERRORS.SUBSCRIPTION_UNKNOWN >= -32099);
});
