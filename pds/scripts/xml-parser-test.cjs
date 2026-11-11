'use strict';
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const awsRequire = createRequire(require.resolve('@aws-sdk/xml-builder'));
const { parseXML, XmlNode } = require('@aws-sdk/xml-builder');
assert.deepEqual(parseXML('<ListBucketResult><Key>001</Key><Key>a&amp;b</Key><Size>42</Size></ListBucketResult>'),
  { ListBucketResult: { Key: ['001', 'a&b'], Size: '42' } });
assert.deepEqual(parseXML('<?xml version="1.0"?><Error code="AccessDenied"><Message> denied </Message></Error>'),
  { Error: { Message: ' denied ', code: 'AccessDenied' } });
assert.equal(parseXML('<r>&#65; &lt; &gt; &quot;</r>').r, 'A < > "');
assert.equal(parseXML(XmlNode.of('Key', 'a<&b').toString()).Key, 'a<&b');
assert.throws(() => parseXML('<a><b></a>'));
// Run the advisory's malformed stop-node input under a hard process deadline.
const malformed = spawnSync(process.execPath, ['-e', `
const assert=require('node:assert/strict');
const {XMLParser}=require(${JSON.stringify(awsRequire.resolve('fast-xml-parser'))});
assert.throws(()=>new XMLParser({stopNodes:['stop']}).parse('<stop>'+'<a '.repeat(100000)));
`], { timeout: 2000, encoding: 'utf8' });
assert.equal(malformed.error, undefined, 'stop-node input exceeded the process deadline');
assert.equal(malformed.status, 0, malformed.stderr);
assert.equal(typeof require('@atproto/pds').PDS.create, 'function');
console.log('PASS AWS XML parsing, builder round trip, bounded malformed stop node, and PDS import');
