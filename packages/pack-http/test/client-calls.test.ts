import { describe, expect, it } from 'vitest';
import { FRONTEND_CALL_TARGET_UNRESOLVED, HTTP_METHOD_DYNAMIC } from '@gate-forge/http-contract';
import {
  parseClientScanConfigDocument,
  scanClientCalls,
  type ClientScanConfig,
} from '../src/client-calls.js';

const spreadConfig = parseClientScanConfigDocument(
  {
    wrapperFunctions: [
      { name: 'apiFetch', methodFromBody: true },
      { name: 'apiSend', method: 'POST' },
    ],
  },
  'test:client-spread',
);

const verbConfig = parseClientScanConfigDocument(
  { clientSymbols: ['apiClient'] },
  'test:client-verbs',
);

function scanWith(
  config: ClientScanConfig,
  file: string,
  sources: Record<string, string>,
) {
  return scanClientCalls(file, sources[file] ?? '', config, new Map(Object.entries(sources)));
}

describe('client scan: options verb forwarded through an options spread', () => {
  it('a wrapper options parameter spread into fetch takes the call-site verb', () => {
    const result = scanWith(spreadConfig, 'src/api.jsx', {
      'src/api.jsx': `
        export const apiFetch = (url, options = {}) =>
          fetch(url, { ...options, credentials: 'include' });

        export function save() {
          return apiFetch('/contracts', { method: 'POST', body: '{}' });
        }

        export function load() {
          return apiFetch('/contracts', { method: 'GET' });
        }
      `,
    });
    expect(result.unresolved).toEqual([]);
    expect(result.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'POST', rawPath: '/contracts' }),
        expect.objectContaining({ method: 'GET', rawPath: '/contracts' }),
      ]),
    );
    expect(result.calls).toHaveLength(2);
  });

  it('a call site whose options provably carry no method sends GET through the spread', () => {
    const result = scanWith(spreadConfig, 'src/api.jsx', {
      'src/api.jsx': `
        export const apiFetch = (url, options = {}) =>
          fetch(url, { ...options, credentials: 'include' });

        export function load() {
          return apiFetch('/contracts', { headers: { Accept: 'application/json' } });
        }
      `,
    });
    expect(result.unresolved).toEqual([]);
    expect(result.calls).toEqual([
      expect.objectContaining({ method: 'GET', rawPath: '/contracts' }),
    ]);
  });

  it('a call site with no options argument stays unresolved — the {} default is not read', () => {
    const result = scanWith(spreadConfig, 'src/api.jsx', {
      'src/api.jsx': `
        export const apiFetch = (url, options = {}) =>
          fetch(url, { ...options, credentials: 'include' });

        export function load() {
          return apiFetch('/contracts');
        }
      `,
    });
    expect(result.calls).toEqual([]);
    expect(result.unresolved).toEqual([
      expect.objectContaining({ code: FRONTEND_CALL_TARGET_UNRESOLVED }),
    ]);
  });

  it('a call site passing options the scan cannot prove stays unresolved and records no call', () => {
    const result = scanWith(spreadConfig, 'src/api.jsx', {
      'src/api.jsx': `
        export const apiFetch = (url, options = {}) =>
          fetch(url, { ...options, credentials: 'include' });

        export function save() {
          return apiFetch('/contracts', buildOptions());
        }
      `,
    });
    expect(result.calls).toEqual([]);
    expect(result.unresolved).toEqual([
      expect.objectContaining({ code: FRONTEND_CALL_TARGET_UNRESOLVED }),
    ]);
  });

  it('a spread provably free of method never overwrites an earlier explicit verb', () => {
    const result = scanWith(spreadConfig, 'src/api.jsx', {
      'src/api.jsx': `
        const base = { credentials: 'include' };

        export function save() {
          return fetch('/contracts', { method: 'POST', ...base });
        }
      `,
    });
    expect(result.unresolved).toEqual([]);
    expect(result.calls).toEqual([
      expect.objectContaining({ method: 'POST', rawPath: '/contracts' }),
    ]);
  });

  it('a declared fixed-method wrapper with a spread body resolves when the body proves the same verb', () => {
    const result = scanWith(spreadConfig, 'src/api.jsx', {
      'src/api.jsx': `
        export const apiSend = (url, options = {}) => fetch(url, { ...options });

        export function save() {
          return apiSend('/contracts', { method: 'POST' });
        }
      `,
    });
    expect(result.unresolved).toEqual([]);
    expect(result.calls).toEqual([
      expect.objectContaining({ method: 'POST', rawPath: '/contracts' }),
    ]);
  });

  it('a declared fixed-method wrapper with a spread body stays unresolved when the body proves another verb', () => {
    const result = scanWith(spreadConfig, 'src/api.jsx', {
      'src/api.jsx': `
        export const apiSend = (url, options = {}) => fetch(url, { ...options });

        export function load() {
          return apiSend('/contracts', { method: 'GET' });
        }
      `,
    });
    expect(result.calls).toEqual([]);
    expect(result.unresolved).toEqual([
      expect.objectContaining({ code: FRONTEND_CALL_TARGET_UNRESOLVED }),
    ]);
  });

  it('a declared fixed-method wrapper keeps its declared verb when the body proves nothing', () => {
    const result = scanWith(spreadConfig, 'src/api.jsx', {
      'src/api.jsx': `
        export const apiSend = (url, options = {}) => fetch(url, { ...options });

        function buildOptions() {
          return mysteryOptions();
        }

        export function save() {
          return apiSend('/contracts', buildOptions());
        }
      `,
    });
    expect(result.unresolved).toEqual([]);
    expect(result.calls).toEqual([
      expect.objectContaining({ method: 'POST', rawPath: '/contracts' }),
    ]);
  });

  it('a direct fetch options spread takes the proven verb, the platform default only when method-free', () => {
    const result = scanWith(spreadConfig, 'src/api.js', {
      'src/api.js': `
        const base = { credentials: 'include' };

        export function save() {
          return fetch('/contracts', { ...base, method: 'POST' });
        }

        export function ping() {
          return fetch('/health', { ...base });
        }

        export function sync() {
          return fetch('/sync', { ...buildOptions() });
        }
      `,
    });
    expect(result.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'POST', rawPath: '/contracts' }),
        expect.objectContaining({ method: 'GET', rawPath: '/health' }),
      ]),
    );
    expect(result.calls).toHaveLength(2);
    expect(result.unresolved).toHaveLength(1);
  });
});

describe('client scan: spread order is last-writer-wins and a verb-named second argument is a body', () => {
  it('a literal method written AFTER an unproven spread wins', () => {
    const result = scanWith(spreadConfig, 'src/api.js', {
      'src/api.js': `
        const requestOptions = buildRequestOptions();

        export function save() {
          return fetch('/api/v1/contracts', { ...requestOptions, method: 'POST' });
        }
      `,
    });
    expect(result.unresolved).toEqual([]);
    expect(result.calls).toEqual([
      expect.objectContaining({ method: 'POST', rawPath: '/api/v1/contracts' }),
    ]);
  });

  it('an unproven spread written AFTER a literal method keeps the verb unproven', () => {
    const result = scanWith(spreadConfig, 'src/api.js', {
      'src/api.js': `
        const requestOptions = buildRequestOptions();

        export function save() {
          return fetch('/api/v1/contracts', { method: 'POST', ...requestOptions });
        }
      `,
    });
    expect(result.calls).toEqual([]);
    expect(result.unresolved).toEqual([
      expect.objectContaining({ code: HTTP_METHOD_DYNAMIC }),
    ]);
  });

  it('a verb-named call treats its spread second argument as the request body', () => {
    const result = scanWith(verbConfig, 'src/floor-plan/FloorPlanTab.jsx', {
      'src/floor-plan/FloorPlanTab.jsx': `
        export function saveShape(extra) {
          return apiClient.patch('/api/v1/floor-plan-room-shapes/1', { polygon_json: {}, ...extra });
        }
      `,
    });
    expect(result.unresolved).toEqual([]);
    expect(result.calls).toEqual([
      expect.objectContaining({ method: 'PATCH', rawPath: '/api/v1/floor-plan-room-shapes/1' }),
    ]);
  });

  it('a verb-named call keeps the member verb across multiple body spreads', () => {
    const result = scanWith(verbConfig, 'src/service/ServiceRequestCreatePage.jsx', {
      'src/service/ServiceRequestCreatePage.jsx': `
        export function createTag(tagPayload, selection) {
          return apiClient.post('/api/v1/spatial-location-tags', { ...tagPayload, ...selection });
        }
      `,
    });
    expect(result.unresolved).toEqual([]);
    expect(result.calls).toEqual([
      expect.objectContaining({ method: 'POST', rawPath: '/api/v1/spatial-location-tags' }),
    ]);
  });
});

describe('client scan: a base.endsWith("/") path-join ternary is one URL', () => {
  it('the idiom with a literal base without a trailing slash proves the single joined template', () => {
    const result = scanWith(verbConfig, 'src/ui/dropdown.js', {
      'src/ui/dropdown.js': `
        const base = '/api/v1/contracts';

        export function loadDetail(value) {
          const directPath = base.endsWith('/')
            ? \`\${base}\${value}/\`
            : \`\${base}/\${value}/\`;
          return apiClient.get(directPath);
        }
      `,
    });
    expect(result.unresolved).toEqual([]);
    expect(result.calls).toEqual([
      expect.objectContaining({ method: 'GET', rawPath: '/api/v1/contracts/${}/' }),
    ]);
  });

  it('the idiom with a base that already ends in a slash still proves the one joined template', () => {
    const result = scanWith(verbConfig, 'src/ui/dropdown.js', {
      'src/ui/dropdown.js': `
        const base = '/api/v1/contracts/';

        export function loadDetail(value) {
          const directPath = base.endsWith('/')
            ? \`\${base}\${value}/\`
            : \`\${base}/\${value}/\`;
          return apiClient.get(directPath);
        }
      `,
    });
    expect(result.unresolved).toEqual([]);
    expect(result.calls).toEqual([
      expect.objectContaining({
        method: 'GET',
        rawPath: '/api/v1/contracts//${}/',
        canonicalPath: '/api/v1/contracts/{}',
      }),
    ]);
  });

  it('a conditional with unrelated arms is not the idiom and stays two templates', () => {
    const result = scanWith(verbConfig, 'src/ui/dropdown.js', {
      'src/ui/dropdown.js': `
        const base = '/api/v1/contracts';

        export function loadDetail(value) {
          const directPath = base.endsWith('/')
            ? \`\${base}\${value}/\`
            : \`\${base}/archive/\${value}/\`;
          return apiClient.get(directPath);
        }
      `,
    });
    expect(result.unresolved).toEqual([]);
    expect(result.calls).toEqual([
      expect.objectContaining({ method: 'GET', rawPath: '/api/v1/contracts/archive/${}/' }),
      expect.objectContaining({ method: 'GET', rawPath: '/api/v1/contracts${}/' }),
    ]);
  });
});

describe('client scan: runtime base-URL hosts in template URLs', () => {
  const envConfig = `
    export const getEnv = (key, defaultValue) => {
      const runtimeVal = window.__ENV__?.[key];
      if (runtimeVal) return runtimeVal;
      const viteVal = import.meta.env?.[\`VITE_\${key}\`];
      if (viteVal) return viteVal;
      return defaultValue;
    };
  `;

  it('a template whose leading hole is an env-config helper resolves to the static path that follows', () => {
    const result = scanWith(spreadConfig, 'src/contractor/Invoice.jsx', {
      'src/utils/envConfig.js': envConfig,
      'src/contractor/Invoice.jsx': `
        import axios from 'axios';
        import { getEnv } from '../utils/envConfig';

        const BACKEND_URL = getEnv('BACKEND_URL');

        export function loadInvoice(token) {
          return axios.get(\`\${BACKEND_URL}/api/v1/contractor/invoice/\${token}\`);
        }
      `,
    });
    expect(result.unresolved).toEqual([]);
    expect(result.calls).toEqual([
      expect.objectContaining({ method: 'GET', rawPath: '/api/v1/contractor/invoice/${}' }),
    ]);
  });

  it('a direct import.meta.env base constant resolves the same way', () => {
    const result = scanWith(spreadConfig, 'src/api.js', {
      'src/api.js': `
        import axios from 'axios';

        const API_BASE = import.meta.env.VITE_API_BASE;

        export function load() {
          return axios.get(\`\${API_BASE}/api/v1/plans\`);
        }
      `,
    });
    expect(result.unresolved).toEqual([]);
    expect(result.calls).toEqual([
      expect.objectContaining({ method: 'GET', rawPath: '/api/v1/plans' }),
    ]);
  });

  it('a process.env base constant resolves the same way', () => {
    const result = scanWith(spreadConfig, 'src/api.ts', {
      'src/api.ts': `
        import axios from 'axios';

        const BACKEND = process.env.BACKEND_URL;

        export function submit() {
          return axios.post(\`\${BACKEND}/api/v1/contractor/schedule/\${globalThis.token}\`, {});
        }
      `,
    });
    expect(result.unresolved).toEqual([]);
    expect(result.calls).toEqual([
      expect.objectContaining({ method: 'POST', rawPath: '/api/v1/contractor/schedule/${}' }),
    ]);
  });

  it('a dynamic hole the model cannot trace to a config read keeps the call unresolved', () => {
    const result = scanWith(spreadConfig, 'src/api.js', {
      'src/api.js': `
        import axios from 'axios';

        const PREFIX = computePrefix();

        export function load() {
          return axios.get(\`\${PREFIX}/api/v1/plans\`);
        }
      `,
    });
    expect(result.calls).toEqual([]);
    expect(result.unresolved).toEqual([
      expect.objectContaining({ code: FRONTEND_CALL_TARGET_UNRESOLVED }),
    ]);
  });

  it('an env host with no static path after it stays unresolved — nothing is invented', () => {
    const result = scanWith(spreadConfig, 'src/api.js', {
      'src/utils/envConfig.js': envConfig,
      'src/api.js': `
        import axios from 'axios';
        import { getEnv } from './utils/envConfig';

        const BACKEND_URL = getEnv('BACKEND_URL');

        export function load(path) {
          return axios.get(\`\${BACKEND_URL}\${path}\`);
        }
      `,
    });
    expect(result.calls).toEqual([]);
    expect(result.unresolved).toEqual([
      expect.objectContaining({ code: FRONTEND_CALL_TARGET_UNRESOLVED }),
    ]);
  });

  it('a provable absolute host is not same-origin by default — the existing gate holds', () => {
    const result = scanWith(spreadConfig, 'src/api.js', {
      'src/api.js': `
        import axios from 'axios';

        const API = 'https://api.example.com';

        export function ping() {
          return axios.get(\`\${API}/health\`);
        }
      `,
    });
    expect(result.calls).toEqual([]);
    expect(result.unresolved).toEqual([
      expect.objectContaining({ code: FRONTEND_CALL_TARGET_UNRESOLVED }),
    ]);
  });
});

const optionConfig = parseClientScanConfigDocument(
  {
    clientSymbols: ['client'],
    wrapperFunctions: [
      { name: 'useSend', method: 'POST', parameter: 'endpoint', methodOption: 'options' },
      { name: 'useSendTwice', method: 'POST', parameter: 'endpoint' },
      { name: 'SendButton', method: 'POST', parameter: 'endpoint', methodOption: 'options' },
    ],
  },
  'test:client-method-option',
);

const sendHook = `
  export function useSend(endpoint, options = {}) {
    const { method = 'post', ...rest } = options;
    return async (payload) => {
      const path = endpoint;
      const res = method === 'delete'
        ? await client.delete(\`/api\${path}\`, { data: payload })
        : await client[method](\`/api\${path}\`, payload);
      return res.data;
    };
  }
`;

function scanSend(page: string) {
  return scanWith(optionConfig, 'src/Page.jsx', { 'src/useSend.js': sendHook, 'src/Page.jsx': page });
}

describe('client scan: wrapper verb from a call-site method option', () => {
  it('a literal method option at the call site is the verb', () => {
    const result = scanSend(`
      import { useSend } from './useSend';
      export function Page() {
        return useSend('/items', { method: 'put', onDone: () => {} });
      }
    `);
    expect(result.unresolved).toEqual([]);
    expect(result.calls).toEqual([expect.objectContaining({ method: 'PUT', rawPath: '/api/items' })]);
  });

  it('a constant method option resolves like a literal', () => {
    const result = scanSend(`
      import { useSend } from './useSend';
      const VERB = 'patch';
      export function Page() {
        return useSend('/items', { method: VERB });
      }
    `);
    expect(result.unresolved).toEqual([]);
    expect(result.calls).toEqual([expect.objectContaining({ method: 'PATCH', rawPath: '/api/items' })]);
  });

  it('no method option takes the configured default verb', () => {
    const result = scanSend(`
      import { useSend } from './useSend';
      export function Page() {
        useSend('/items');
        return useSend('/items', { onDone: () => {} });
      }
    `);
    expect(result.unresolved).toEqual([]);
    expect(result.calls).toEqual([
      expect.objectContaining({ method: 'POST', rawPath: '/api/items' }),
      expect.objectContaining({ method: 'POST', rawPath: '/api/items' }),
    ]);
  });

  it('a body branch verb never adds a second call: delete at the call site is one DELETE', () => {
    const result = scanSend(`
      import { useSend } from './useSend';
      export function Page() {
        return useSend('/items', { method: 'delete' });
      }
    `);
    expect(result.unresolved).toEqual([]);
    expect(result.calls).toEqual([expect.objectContaining({ method: 'DELETE', rawPath: '/api/items' })]);
  });

  it('a non-literal method option is HTTP_METHOD_DYNAMIC and records no call', () => {
    const result = scanSend(`
      import { useSend } from './useSend';
      export function Page({ kind, opts }) {
        useSend('/items', { method: kind });
        return useSend('/items', opts);
      }
    `);
    expect(result.calls).toEqual([]);
    expect(result.unresolved).toEqual([
      expect.objectContaining({ code: HTTP_METHOD_DYNAMIC }),
      expect.objectContaining({ code: HTTP_METHOD_DYNAMIC }),
    ]);
  });

  it('a method-option wrapper called from another wrapper body fails closed, never the default', () => {
    const result = scanWith(optionConfig, 'src/Page.jsx', {
      'src/useSend.js': sendHook,
      'src/useSendTwice.js': `
        import { useSend } from './useSend';
        export function useSendTwice(endpoint) {
          return useSend(endpoint, { method: 'put' });
        }
      `,
      'src/Page.jsx': `
        import { useSendTwice } from './useSendTwice';
        export function Page() {
          return useSendTwice('/items');
        }
      `,
    });
    expect(result.calls).toEqual([]);
    expect(result.unresolved).toEqual([expect.objectContaining({ code: FRONTEND_CALL_TARGET_UNRESOLVED })]);
  });

  it('a JSX usage of a method-option wrapper is HTTP_METHOD_DYNAMIC, never the default', () => {
    const result = scanWith(optionConfig, 'src/Page.jsx', {
      'src/SendButton.jsx': `
        export function SendButton({ endpoint, options = {} }) {
          const { method = 'post' } = options;
          return <button onClick={() => method === 'delete'
            ? client.delete(\`/api\${endpoint}\`)
            : client[method](\`/api\${endpoint}\`)}>send</button>;
        }
      `,
      'src/Page.jsx': `
        import { SendButton } from './SendButton';
        export function Page() {
          return <SendButton endpoint="/items" options={{ method: 'put' }} />;
        }
      `,
    });
    expect(result.calls).toEqual([]);
    expect(result.unresolved).toEqual([expect.objectContaining({ code: HTTP_METHOD_DYNAMIC })]);
  });

  it('methodOption needs an explicit default method and excludes methodFromBody', () => {
    expect(() => parseClientScanConfigDocument(
      { wrapperFunctions: [{ name: 'useSend', methodOption: 'options' }] },
      'test:bad',
    )).toThrow(/methodOption/);
    expect(() => parseClientScanConfigDocument(
      { wrapperFunctions: [{ name: 'useSend', method: 'POST', methodOption: 'options', methodFromBody: true }] },
      'test:bad',
    )).toThrow(/methodOption/);
  });
});

const guardConfig = parseClientScanConfigDocument(
  {
    clientSymbols: ['client'],
    wrapperFunctions: [{ name: 'usePut', method: 'PUT', parameter: 'endpoint' }],
  },
  'test:client-typeof-guard',
);

const putHook = `
  export function usePut(endpoint) {
    return async (payload) => {
      const path = typeof endpoint === 'function' ? endpoint(payload) : endpoint;
      const res = await client.put(path, payload);
      return res.data;
    };
  }
`;

function scanPut(page: string) {
  return scanWith(guardConfig, 'src/Page.jsx', { 'src/usePut.js': putHook, 'src/Page.jsx': page });
}

describe('client scan: typeof function URL guard', () => {
  it('a guard over a literal wrapper argument folds to the literal URL', () => {
    const result = scanPut(`
      import { usePut } from './usePut';

      export function Page() {
        return usePut('/api/items');
      }
    `);
    expect(result.unresolved).toEqual([]);
    expect(result.calls).toEqual([expect.objectContaining({ method: 'PUT', rawPath: '/api/items' })]);
  });

  it('a guard over a constant-built wrapper argument folds to the built URL', () => {
    const result = scanPut(`
      import { usePut } from './usePut';

      const BASE = '/api/items';

      export function Page() {
        return usePut(\`\${BASE}/archive\`);
      }
    `);
    expect(result.unresolved).toEqual([]);
    expect(result.calls).toEqual([expect.objectContaining({ method: 'PUT', rawPath: '/api/items/archive' })]);
  });

  it('a guard over a wrapper argument with an unproven hole stays unresolved', () => {
    const result = scanPut(`
      import { usePut } from './usePut';

      export function Page({ id }) {
        return usePut(\`/api/items/\${id}\`);
      }
    `);
    expect(result.calls).toEqual([]);
    expect(result.unresolved).toEqual([
      expect.objectContaining({ code: FRONTEND_CALL_TARGET_UNRESOLVED }),
    ]);
  });

  it('a guard over an arrow wrapper argument stays unresolved', () => {
    const result = scanPut(`
      import { usePut } from './usePut';

      export function Page() {
        return usePut((p) => \`/api/items/\${p.id}\`);
      }
    `);
    expect(result.calls).toEqual([]);
    expect(result.unresolved).toEqual([
      expect.objectContaining({ code: FRONTEND_CALL_TARGET_UNRESOLVED }),
    ]);
  });

  it('a guard over an unresolvable wrapper argument stays unresolved', () => {
    const result = scanPut(`
      import { usePut } from './usePut';

      export function Page({ target }) {
        return usePut(target);
      }
    `);
    expect(result.calls).toEqual([]);
    expect(result.unresolved).toEqual([
      expect.objectContaining({ code: FRONTEND_CALL_TARGET_UNRESOLVED }),
    ]);
  });

  it('a guard over a module const folds to that const', () => {
    const result = scanWith(verbConfig, 'src/load.js', {
      'src/load.js': `
        const URL = '/api/items';

        export function load() {
          return apiClient.get(typeof URL === 'function' ? URL() : URL);
        }
      `,
    });
    expect(result.unresolved).toEqual([]);
    expect(result.calls).toEqual([expect.objectContaining({ method: 'GET', rawPath: '/api/items' })]);
  });

  it('a guard over a parameter of the same name stays unresolved', () => {
    const result = scanWith(verbConfig, 'src/load.js', {
      'src/load.js': `
        const URL = '/api/items';

        export function load(URL) {
          return apiClient.get(typeof URL === 'function' ? URL() : URL);
        }
      `,
    });
    expect(result.calls).toEqual([]);
    expect(result.unresolved).toEqual([
      expect.objectContaining({ code: FRONTEND_CALL_TARGET_UNRESOLVED }),
    ]);
  });

  it('a function declaration and a hoisted var of the same name shadow the module const', () => {
    const result = scanWith(verbConfig, 'src/load.js', {
      'src/load.js': `
        const URL = '/api/items';

        export function load() {
          return apiClient.get(URL);
          function URL() { return '/api/other'; }
        }

        export function reload() {
          const res = apiClient.get(URL);
          var URL = '/api/other';
          return res;
        }
      `,
    });
    expect(result.calls).toEqual([]);
    expect(result.unresolved).toEqual([
      expect.objectContaining({ code: FRONTEND_CALL_TARGET_UNRESOLVED }),
      expect.objectContaining({ code: FRONTEND_CALL_TARGET_UNRESOLVED }),
    ]);
  });

  it('a block-local const is visible only inside its own block or loop', () => {
    const result = scanWith(verbConfig, 'src/load.js', {
      'src/load.js': `
        const URL = '/api/items';

        export function load(flag) {
          if (flag) { const URL = '/api/other'; }
          return apiClient.get(URL);
        }

        export function reload() {
          for (const URL = '/api/other'; ;) { break; }
          return apiClient.get(URL);
        }

        export function each() {
          for (const PATH = '/api/items'; ;) { return apiClient.get(PATH); }
        }
      `,
    });
    expect(result.calls).toEqual([expect.objectContaining({ method: 'GET', rawPath: '/api/items' })]);
    expect(result.unresolved).toEqual([
      expect.objectContaining({ code: FRONTEND_CALL_TARGET_UNRESOLVED }),
      expect.objectContaining({ code: FRONTEND_CALL_TARGET_UNRESOLVED }),
    ]);
  });

  it('an imported reassigned module let never resolves, guarded or bare', () => {
    const result = scanWith(verbConfig, 'src/load.js', {
      'src/cfg.js': `
        export let URL = '/api/items';

        export function configure(next) { URL = next; }
      `,
      'src/load.js': `
        import { URL } from './cfg';

        export function load() {
          return apiClient.get(typeof URL === 'function' ? URL() : URL);
        }

        export function reload() {
          return apiClient.get(URL);
        }
      `,
    });
    expect(result.calls).toEqual([]);
    expect(result.unresolved).toEqual([
      expect.objectContaining({ code: FRONTEND_CALL_TARGET_UNRESOLVED }),
      expect.objectContaining({ code: FRONTEND_CALL_TARGET_UNRESOLVED }),
    ]);
  });

  it('an imported module const resolves under the guard', () => {
    const result = scanWith(verbConfig, 'src/load.js', {
      'src/cfg.js': `
        export const URL = '/api/items';
      `,
      'src/load.js': `
        import { URL } from './cfg';

        export function load() {
          return apiClient.get(typeof URL === 'function' ? URL() : URL);
        }
      `,
    });
    expect(result.unresolved).toEqual([]);
    expect(result.calls).toEqual([expect.objectContaining({ method: 'GET', rawPath: '/api/items' })]);
  });
});

const elementConfig = parseClientScanConfigDocument(
  { clientSymbols: ['client'] },
  'test:client-element-access',
);

describe('client scan: element-access client calls', () => {
  it('a literal element key is the verb', () => {
    const result = scanWith(elementConfig, 'src/save.js', {
      'src/save.js': `
        export function save() {
          return client['put']('/api/items', {});
        }
      `,
    });
    expect(result.unresolved).toEqual([]);
    expect(result.calls).toEqual([expect.objectContaining({ method: 'PUT', rawPath: '/api/items' })]);
  });

  it('a module const element key is the verb', () => {
    const result = scanWith(elementConfig, 'src/save.js', {
      'src/save.js': `
        const VERB = 'patch';

        export function save() {
          return client[VERB]('/api/items', {});
        }
      `,
    });
    expect(result.unresolved).toEqual([]);
    expect(result.calls).toEqual([expect.objectContaining({ method: 'PATCH', rawPath: '/api/items' })]);
  });

  it('a parameter element key is HTTP_METHOD_DYNAMIC and records no call', () => {
    const result = scanWith(elementConfig, 'src/save.js', {
      'src/save.js': `
        export function save(m) {
          return client[m]('/api/items', {});
        }
      `,
    });
    expect(result.calls).toEqual([]);
    expect(result.unresolved).toEqual([expect.objectContaining({ code: HTTP_METHOD_DYNAMIC })]);
  });

  it('a parameter shadows a module const of the same name — never the constant', () => {
    const result = scanWith(elementConfig, 'src/save.js', {
      'src/save.js': `
        const m = 'put';

        export function save(m) {
          return client[m]('/api/items', {});
        }
      `,
    });
    expect(result.calls).toEqual([]);
    expect(result.unresolved).toEqual([expect.objectContaining({ code: HTTP_METHOD_DYNAMIC })]);
  });

  it('an undeclared element-access wrapper blocks inside and at its call site', () => {
    const result = scanWith(elementConfig, 'src/save.js', {
      'src/save.js': `
        function save(m) {
          return client[m]('/api/items', {});
        }

        export function Page() {
          return save('put');
        }
      `,
    });
    expect(result.calls).toEqual([]);
    expect(result.unresolved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: HTTP_METHOD_DYNAMIC }),
        expect.objectContaining({ code: FRONTEND_CALL_TARGET_UNRESOLVED }),
      ]),
    );
    expect(result.unresolved).toHaveLength(2);
  });

  it('a declared wrapper with an unproven verb key stays unresolved at the call site', () => {
    const wrapperElementConfig = parseClientScanConfigDocument(
      {
        clientSymbols: ['client'],
        wrapperFunctions: [{ name: 'save', method: 'PUT', parameter: 'url' }],
      },
      'test:client-element-wrapper',
    );
    const sources = {
      'src/save.js': `
        export function save(url, m) {
          return client[m](url, {});
        }
      `,
      'src/Page.jsx': `
        import { save } from './save';

        export function Page() {
          return save('/api/items', 'put');
        }
      `,
    };
    const wrapperFile = scanWith(wrapperElementConfig, 'src/save.js', sources);
    expect(wrapperFile.unresolved).toEqual([]);
    const page = scanWith(wrapperElementConfig, 'src/Page.jsx', sources);
    expect(page.calls).toEqual([]);
    expect(page.unresolved).toEqual([expect.objectContaining({ code: FRONTEND_CALL_TARGET_UNRESOLVED })]);
  });

  it('a methodOption wrapper destructuring the option proves the body verb key', () => {
    const result = scanWith(optionConfig, 'src/Page.jsx', {
      'src/useSend.js': `
        export function useSend(endpoint, options = {}) {
          const { method = 'post' } = options;
          return (payload) => client[method](\`/api\${endpoint}\`, payload);
        }
      `,
      'src/Page.jsx': `
        import { useSend } from './useSend';

        export function Page() {
          useSend('/items');
          return useSend('/items', { method: 'put' });
        }
      `,
    });
    expect(result.unresolved).toEqual([]);
    expect(result.calls).toEqual([
      expect.objectContaining({ method: 'POST', rawPath: '/api/items' }),
      expect.objectContaining({ method: 'PUT', rawPath: '/api/items' }),
    ]);
  });

  it('a body verb key computed from a ternary stays unresolved, never the configured default', () => {
    const result = scanWith(optionConfig, 'src/Page.jsx', {
      'src/useSend.js': `
        export function useSend(endpoint, options = {}) {
          const verb = options.kind === 'replace' ? 'put' : 'patch';
          return (payload) => client[verb](\`/api\${endpoint}\`, payload);
        }
      `,
      'src/Page.jsx': `
        import { useSend } from './useSend';

        export function Page() {
          return useSend('/items', { method: 'put' });
        }
      `,
    });
    expect(result.calls).toEqual([]);
    expect(result.unresolved).toEqual([expect.objectContaining({ code: FRONTEND_CALL_TARGET_UNRESOLVED })]);
  });

  it('a dispatch wrapper proves the literal call and blocks only the arrow call site', () => {
    const result = scanWith(optionConfig, 'src/Page.jsx', {
      'src/useSend.js': `
        export function useSend(endpoint, options = {}) {
          const { method = 'post' } = options;
          return async (payload) => {
            const path = typeof endpoint === 'function' ? endpoint(payload) : endpoint;
            const res = method === 'delete'
              ? await client.delete(path, { data: payload })
              : await client[method](path, payload);
            return res.data;
          };
        }
      `,
      'src/Page.jsx': `
        import { useSend } from './useSend';

        export function Page() {
          useSend('/api/items', { method: 'put' });
          return useSend((p) => \`/api/items/\${p.id}\`, { method: 'put' });
        }
      `,
    });
    expect(result.calls).toEqual([expect.objectContaining({ method: 'PUT', rawPath: '/api/items' })]);
    expect(result.unresolved).toEqual([expect.objectContaining({ code: FRONTEND_CALL_TARGET_UNRESOLVED })]);
  });
});
