/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Interface, getAddress, toBeHex } = require('ethers');
const {
  approval,
  assessCeiling,
} = require('../../src/main/services/wallet/portfolio-allowance-ceiling');
const { PERMIT2 } = require('../../src/main/services/quant/permit2');

test('ceiling reserves unresolved grants across wallets and does not credit pending revocation', async () => {
  const address = (value) => getAddress(toBeHex(value, 20));
  const hash = (value) => toBeHex(value, 32);
  const [token, olderSpender, newSpender, spentNonceSpender] = [3, 4, 5, 6].map(address);
  const members = [
    { walletId: 'one', address: address(10) },
    { walletId: 'two', address: address(11) },
  ];
  const anchor = {
    block: '100',
    blockHash: hash(100),
    coverage: { tokens: [token], memberIds: ['one', 'two'] },
    rows: [{ token, protocol: 'erc20', walletId: 'one', spender: olderSpender }],
  };
  const guard = { id: 'cap', revision: 2, rule: { token, atoms: '10', decimals: 0 }, members };
  const reads = [];
  const rpc = async (method, params) => {
    if (method === 'eth_getBlockByNumber') return { hash: hash(BigInt(params[0])) };
    assert.equal(method, 'eth_getTransactionCount');
    assert.deepEqual(params, [
      members[1].address,
      { blockHash: hash(102), requireCanonical: true },
    ]);
    return '0x2';
  };
  const market = {
    connect: async () => ({
      rpc,
      height: 102n,
      timestamp: BigInt(Math.floor(Date.now() / 1000)),
      block: { hash: hash(102) },
    }),
    discoverTokenApprovals: async (_config, input) => {
      assert.equal(input.blocks, 2);
      assert.equal(input.anchorHash, hash(102));
      return { nextOffset: null, items: [] };
    },
    tokenAllowance: async (_config, input, { connection }) => {
      assert.equal(connection.block.hash, hash(102));
      reads.push(input.spender);
      return {
        amountAtomic: input.spender === olderSpender ? '3' : input.spender === PERMIT2 ? '1' : '0',
      };
    },
  };
  const wallet = {
    market,
    portfolios: { get: async () => ({ revision: 2, portfolio: { limits: {} } }) },
  };
  const abi = new Interface(['function approve(address,uint256)']);
  const tx = (spender, amount, nonce) => ({
    to: token,
    value: '0',
    nonce,
    data: abi.encodeFunctionData('approve', [spender, amount]),
  });
  const intent = { id: 'new', chainId: 8453, walletId: 'one', address: members[0].address };
  const outgoing = (id, transaction) => ({
    ...intent,
    id,
    walletId: 'two',
    address: members[1].address,
    transaction,
    status: 'submit-unknown',
  });
  const intents = [
    outgoing('pending', tx(newSpender, 4, 2)),
    outgoing('replacement', tx(newSpender, 3, 2)),
    outgoing('revocation', tx(newSpender, 0, 2)),
    outgoing('old', tx(spentNonceSpender, 80, 1)),
  ];
  const assess = (spender, amount) =>
    assessCeiling(
      wallet,
      { venue: 'base' },
      guard,
      anchor,
      intent,
      approval(tx(spender, amount, 5)),
      intents,
      new AbortController().signal,
    );
  const blocked = await assess(newSpender, 2);
  assert.equal(blocked.before, '9');
  assert.equal(blocked.projected, '11');
  assert.equal(blocked.status, 'exceeded');
  assert.ok(!reads.includes(spentNonceSpender));
  const reduced = await assess(olderSpender, 2);
  assert.equal(reduced.status, 'satisfied');
  assert.equal(reduced.projected, '8');
});
