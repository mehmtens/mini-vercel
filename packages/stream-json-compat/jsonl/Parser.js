'use strict';

const jsonLineParserModule = require('stream-json-safe/jsonl/parser.js');
const createJsonLineParser =
  jsonLineParserModule.default || jsonLineParserModule.parser || jsonLineParserModule;

module.exports.make = function make(options) {
  return createJsonLineParser.asStream(options);
};
