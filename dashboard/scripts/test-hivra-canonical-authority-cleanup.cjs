const assert = require('node:assert/strict');
const { cleanupOwnedContainer, main } = require('./test-hivra-canonical-authority-concurrency.cjs');
const id = 'a'.repeat(64);
const name = 'hivra-authority-fixture';
// Models a run which created its resource, then lost acknowledgement. Cleanup
// discovers the owned ID rather than depending on docker run's returned value.
let calls = [];
let answers = [id,'owner','', '', ''];
cleanupOwnedContainer(args => { calls.push(args); return answers.shift(); },name,'owner');
assert.deepEqual(calls[2], ['stop','--time','3',id]);
assert.equal(answers.length, 0);
calls = [];
cleanupOwnedContainer(args => { calls.push(args); return ''; },name,'owner');
assert.equal(calls.length, 1, 'absent target needs no destructive command');
calls = [];
answers = [id,'unrelated-owner'];
assert.throws(() => cleanupOwnedContainer(args => { calls.push(args); return answers.shift(); },name,'owner'));
assert.equal(calls.some(args => args[0]==='stop'), false, 'ownership mismatch never stops a container');
assert.throws(() => cleanupOwnedContainer(() => { throw new Error('daemon unavailable'); },name,'owner'), /daemon unavailable/);
assert.throws(() => cleanupOwnedContainer(() => `${id}\n${id}`,name,'owner'), /exactly one/);
async function lostAcknowledgement() {
  let owner, stopped = false;
  await assert.rejects(() => main(args => {
    if (args[0]==='image') return `sha256:${id}`;
    if (args[0]==='run') {
      owner = args.find(value=>value.startsWith('hivra.test.owner=')).split('=')[1];
      throw new Error('fixture lost run acknowledgement');
    }
    if (args[0]==='inspect') return owner;
    if (args[0]==='stop') { assert.equal(args[3],id); stopped=true; return ''; }
    if (args[0]==='ps') return stopped ? '' : id;
    throw new Error('unexpected docker call');
  }), /fixture lost run acknowledgement/);
  assert.equal(stopped,true,'the real main finally must clean an unacknowledged launch');
  let removed = false;
  await assert.rejects(() => main(args => {
    if (args[0]==='image') return `sha256:${id}`;
    if (args[0]==='run') {
      owner = args.find(value=>value.startsWith('hivra.test.owner=')).split('=')[1];
      throw new Error('fixture created but never started');
    }
    if (args[0]==='inspect') return owner;
    if (args[0]==='stop') return ''; // No running process; --rm has not fired.
    if (args[0]==='rm') { assert.equal(args[1],id); removed=true; return ''; }
    if (args[0]==='ps') return removed ? '' : id;
    throw new Error('unexpected docker call');
  }), /fixture created but never started/);
  assert.equal(removed,true,'an unstarted owned container must be explicitly removed');
  console.log('PASS owned container cleanup after lost acknowledgement, absence, conflicting ownership and observation failure');
}
lostAcknowledgement().catch(error=>{ console.error(error); process.exitCode=1; });
