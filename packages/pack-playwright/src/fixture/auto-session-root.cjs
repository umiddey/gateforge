'use strict';
module.exports = function forwardRoot(root, test, request) {
  for (const key of Reflect.ownKeys(root)) {
    if (key in test) continue;
    Object.defineProperty(test, key, { get: () => root[key], configurable: true });
  }
  Object.defineProperty(test, 'test', { value: test, configurable: true });
  Object.defineProperty(test, 'request', { value: request, configurable: true });
  return test;
};
