import test from 'node:test';
import assert from 'node:assert/strict';
import {randomInt} from 'node:crypto';
import {listenHttpFixture} from './http-fixture.mjs';

const close = server => new Promise((resolve,reject) => server.close(error=>error?reject(error):resolve()));
const reply = (_req,res) => res.end('fixture');

test('Fetch rejects the low dynamic-range port before HTTP communication', async () => {
  await assert.rejects(fetch('http://127.0.0.1:6667/'), error=>error.cause?.message==='bad port');
});

test('HTTP fixture binds loopback on a Fetch-compatible port and serves actual requests', async () => {
  let calls=0;
  const server=await listenHttpFixture((_req,res)=>{calls++;res.end('fixture');});
  try {
    const address=server.address();
    assert.equal(address.address,'127.0.0.1');
    assert.ok(address.port>=49152 && address.port<=65535);
    assert.equal(calls,0);
    assert.equal(await (await fetch(`http://127.0.0.1:${address.port}/`)).text(),'fixture');
    assert.equal(calls,1);
  } finally { await close(server); }
  assert.equal(server.listening,false);
});

test('HTTP fixture retries an occupied bind without disturbing its owner', async () => {
  const owner=await listenHttpFixture(reply);
  let server,candidates=0;
  try {
    server=await listenHttpFixture(reply,{choosePort:()=>{
      if(candidates++===0)return owner.address().port;
      return randomInt(49152,65536);
    }});
    assert.ok(candidates>=2);
    assert.notEqual(server.address().port,owner.address().port);
    for(const current of [owner,server])
      assert.equal(await (await fetch(`http://127.0.0.1:${current.address().port}/`)).text(),'fixture');
  } finally { if(server)await close(server);await close(owner); }
});

test('HTTP fixture exhaustion reports the bind error within its budget', async () => {
  const owner=await listenHttpFixture(reply);let attempts=0;
  try {
    await assert.rejects(listenHttpFixture(reply,{maxAttempts:2,choosePort:()=>{attempts++;return owner.address().port;}}),
      error=>error.code==='EADDRINUSE'&&error.message.includes('2 attempts'));
    assert.equal(attempts,2);
  } finally { await close(owner); }
});

test('HTTP fixture rejects unsafe ports and invalid budgets without silently retrying', async () => {
  for(const port of [0,6000,6667,49151,65536,NaN])
    await assert.rejects(listenHttpFixture(reply,{choosePort:()=>port}),RangeError);
  await assert.rejects(listenHttpFixture(reply,{maxAttempts:0}),RangeError);
  const error=new Error('picker failed');
  await assert.rejects(listenHttpFixture(reply,{choosePort:()=>{throw error;}}),e=>e===error);
});
