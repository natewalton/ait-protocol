'use strict';
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const awsRoot = require.resolve('@aws-sdk/xml-builder/package.json');
const awsRequire = createRequire(awsRoot);
assert.ok(!JSON.parse(fs.readFileSync(awsRoot)).dependencies['fast-xml-parser'], 'upstream must not restore the removed parser');
const { parseXML, XmlNode } = require('@aws-sdk/xml-builder');
assert.deepEqual(parseXML('<ListBucketResult><Key>001</Key><Key>a&amp;b</Key><Size>42</Size></ListBucketResult>'),
  { ListBucketResult: { Key: ['001', 'a&b'], Size: '42' } });
assert.deepEqual(parseXML('<?xml version="1.0"?><Error code="AccessDenied"><Message> denied </Message></Error>'),
  { Error: { Message: ' denied ', code: 'AccessDenied' } });
assert.equal(parseXML('<r>&#65; &lt; &gt; &quot;</r>').r, 'A < > "');
assert.equal(parseXML(XmlNode.of('Key', 'a<&b').toString()).Key, 'a<&b');
assert.throws(() => parseXML('<a><b></a>'));
// The newer upstream SDK removed fast-xml-parser. Exercise its actual parser
// against the former advisory input under the same hard process deadline.
const malformed = spawnSync(process.execPath, ['-e', `
const assert=require('node:assert/strict');
const {parseXML}=require(${JSON.stringify(awsRequire.resolve('@aws-sdk/xml-builder'))});
assert.throws(()=>parseXML('<stop>'+'<a '.repeat(100000)));
`], { timeout: 2000, encoding: 'utf8' });
assert.equal(malformed.error, undefined, 'stop-node input exceeded the process deadline');
assert.equal(malformed.status, 0, malformed.stderr);
assert.equal(typeof require('@atproto/pds').PDS.create, 'function');
console.log('PASS AWS XML parsing, builder round trip, bounded malformed input, and PDS import');
