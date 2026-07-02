import { marshall } from '@aws-sdk/util-dynamodb';

// Shared send mock; the gate constructs its own DynamoDBClient at import time.
const sendMock = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/client-dynamodb');
  return { ...actual, DynamoDBClient: jest.fn(() => ({ send: sendMock })) };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
import { acquireSimple, releaseSimple, getInflight } from '../src/gate/dynamo-gate';

const cmdName = (c: unknown) => (c as { constructor: { name: string } }).constructor.name;

beforeEach(() => sendMock.mockReset());

describe('acquireSimple', () => {
  it('grants a slot and records a lease when under the limit', async () => {
    sendMock.mockImplementation(async (cmd) => {
      if (cmdName(cmd) === 'UpdateItemCommand') return {};   // ADD inflight succeeds
      if (cmdName(cmd) === 'PutItemCommand') return {};      // lease written
      return {};
    });

    const res = await acquireSimple('runpod:flux-tts-s2t', 25, 'job:abc');
    expect(res.granted).toBe(true);
    expect(res.leaseId).toBeTruthy();

    const cmds = sendMock.mock.calls.map(c => cmdName(c[0]));
    expect(cmds).toContain('UpdateItemCommand');
    expect(cmds).toContain('PutItemCommand');
  });

  it('does not grant when the pool is full (condition fails, no expired leases)', async () => {
    sendMock.mockImplementation(async (cmd) => {
      if (cmdName(cmd) === 'UpdateItemCommand') {
        throw Object.assign(new Error('full'), { name: 'ConditionalCheckFailedException' });
      }
      if (cmdName(cmd) === 'ScanCommand') return { Items: [] }; // reclaim finds nothing
      return {};
    });

    const res = await acquireSimple('runpod:qwen-image-gen', 1, 'job:xyz');
    expect(res.granted).toBe(false);
    expect(res.retryAfterMs).toBeGreaterThan(0);
  });
});

describe('releaseSimple', () => {
  it('decrements the counter and tombstones the lease', async () => {
    sendMock.mockResolvedValue({});
    const res = await releaseSimple('runpod:flux-tts-s2t', 'lease-1');
    expect(res.released).toBe(true);
    // one decrement UpdateItem + one lease-delete UpdateItem
    expect(sendMock.mock.calls.filter(c => cmdName(c[0]) === 'UpdateItemCommand').length).toBe(2);
  });

  it('reports not-released when the counter is already at zero', async () => {
    sendMock.mockImplementation(async (cmd) => {
      if (cmdName(cmd) === 'UpdateItemCommand') {
        throw Object.assign(new Error('zero'), { name: 'ConditionalCheckFailedException' });
      }
      return {};
    });
    const res = await releaseSimple('runpod:flux-tts-s2t', 'lease-2');
    expect(res.released).toBe(false);
  });
});

describe('getInflight', () => {
  it('returns the stored inflight count', async () => {
    sendMock.mockResolvedValue({ Item: marshall({ inflight: 3 }) });
    expect(await getInflight('runpod:flux-tts-s2t')).toBe(3);
  });

  it('returns 0 when the counter item does not exist yet', async () => {
    sendMock.mockResolvedValue({});
    expect(await getInflight('runpod:never-seen')).toBe(0);
  });
});
