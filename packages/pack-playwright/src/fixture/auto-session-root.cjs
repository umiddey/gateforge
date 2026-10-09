'use strict';
module.exports = function forwardRoot(root, test, request) {
  const forwarded = new Proxy(test, {
    get(target, key, receiver) {
      if (key === 'test') return forwarded;
      if (key === 'request') return request;
      return key in target ? Reflect.get(target, key, receiver) : Reflect.get(root, key);
    },
    has(target, key) {
      return key === 'test' || key === 'request' || key in target || key in root;
    },
  });
  return forwarded;
};
