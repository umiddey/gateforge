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
