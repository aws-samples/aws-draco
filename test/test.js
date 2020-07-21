const retention = require('../src/retention.js');
const snapshots = require('./fixtures/sample.json');
var chai = require('chai');
var assert = chai.assert;

// export DEBUG=1 to see the retained backups
//
function dumpRetained(list) {
  if (process.env.DEBUG) {
    for (let s of list) {
      if (!s.retain) continue;
      console.log(`${s.id}: Day: ${s.dow}, Date: ${s.date}, Week: ${s.week}, Month: ${s.month}`)
    }
  }
};

describe('Retention', function() {

  it ('should delete according to Test policy', async function() {
    const marked = await retention.implementPolicy(snapshots, 'Test');
    dumpRetained(marked);
    assert.typeOf(marked, 'Array');
    let kept = marked.filter( s => s.retain).map( s => s.id );
    assert.lengthOf(kept, 3);
  });

  describe('with Standard policy', function() {
    it ('should work with a month', async function() {
      const marked = await retention.implementPolicy(snapshots, 'Standard');
      dumpRetained(marked);
      assert.typeOf(marked, 'Array');
      let standard = require('./fixtures/standard_month.json');
      let kept = marked.filter( s => s.retain).map( s => s.id );
      assert.deepEqual(kept, standard.map( s => s.id ));
    });

    it ('should work with a full year', async function() {
      const fullyear = require('./fixtures/fullyear.json');
      const results = require('./fixtures/standard_fullyear.json');
      const marked = await retention.implementPolicy(fullyear, 'Standard');
      dumpRetained(marked);
      assert.typeOf(marked, 'Array');
      let kept = marked.filter( s => s.retain).map( s => s.id );
      assert.deepEqual(kept, results);
    });

  });

  it ('should delete according to Weekly policy', async function() {
    const marked = await retention.implementPolicy(snapshots, 'Weekly');
    dumpRetained(marked);
    assert.typeOf(marked, 'Array');
    assert.lengthOf(marked.filter( s => s.retain), 7);
  });

  it ('should delete according to Fortnightly policy', async function() {
    const marked = await retention.implementPolicy(snapshots, 'Fortnightly');
    dumpRetained(marked);
    assert.typeOf(marked, 'Array');
    assert.lengthOf(marked.filter( s => s.retain), 14);
  });

  it ('should delete according to Biweekly policy', async function() {
    const marked = await retention.implementPolicy(snapshots, 'Biweekly');
    assert.typeOf(marked, 'Array');
    dumpRetained(marked);
    let kept = marked.filter( s => s.retain);
    assert.lengthOf(kept, 2);
    assert.equal(kept[0].week, kept[1].week+1);
  });

  it ('should delete according to SemiMonthly policy', async function() {
    const marked = await retention.implementPolicy(snapshots, 'SemiMonthly');
    dumpRetained(marked);
    assert.typeOf(marked, 'Array');
    assert.lengthOf(marked.filter( s => s.retain), 16);
  });

  describe('with Monthly policy', function() {
    it ('should handle April', async function() {
      const marked = await retention.implementPolicy(snapshots, 'Monthly');
      dumpRetained(marked);
      assert.typeOf(marked, 'Array');
      assert.lengthOf(marked.filter( s => s.retain), 30);
    });

    it ('should handle leap February', async function() {
      const leap_feb = require('./fixtures/leap_feb.json');
      const marked = await retention.implementPolicy(leap_feb, 'Monthly');
      dumpRetained(marked);
      assert.typeOf(marked, 'Array');
      assert.lengthOf(marked.filter( s => s.retain), 29);
    });
  });

  it ('should delete according to CurrentMonth policy', async function() {
    const marked = await retention.implementPolicy(snapshots, 'CurrentMonth');
    dumpRetained(marked);
    assert.typeOf(marked, 'Array');
    assert.lengthOf(marked.filter( s => s.retain), 3);
  });
});

