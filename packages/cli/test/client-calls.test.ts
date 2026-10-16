import { describe, expect, it } from 'vitest';
import { FRONTEND_CALL_TARGET_UNRESOLVED } from '@gate-forge/http-contract';
import { parseClientScanConfigDocument, scanClientCalls } from '../../pack-http/src/client-calls.js';

const config = parseClientScanConfigDocument(
  {
    clientSymbols: ['apiClient', 'otherClient'],
    wrapperFunctions: [
      { name: 'useApiGet', method: 'GET' },
      { name: 'DuplicateRowAction', method: 'DELETE' },
    ],
  },
  'test:client-calls',
);

function scanFrom(file: string, sources: Record<string, string>) {
  return scanClientCalls(file, sources[file] ?? '', config, new Map(Object.entries(sources)));
}

describe('client scan: interceptor replays (error.config)', () => {
  it('a replay through a const bound to error.config is neither a call nor a finding', () => {
    const result = scanFrom('src/api.jsx', {
      'src/api.jsx': `
        import axios from 'axios';

        export const apiClient = axios.create();

        apiClient.interceptors.response.use(
          (response) => response,
          async (error) => {
            const config = error.config;
            if (error.response?.status === 401) {
              return apiClient(config);
            }
            return Promise.reject(error);
          },
        );

        export function loadContracts() {
          return apiClient.get('/contracts');
        }
      `,
    });
    expect(result.unresolved).toEqual([]);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toMatchObject({ method: 'GET', rawPath: '/contracts', framework: 'apiClient' });
  });

  it('a replay through a const bound to error.config with an as cast is neither a call nor a finding', () => {
    const result = scanFrom('src/apiClient.ts', {
      'src/apiClient.ts': `
        import axios, { AxiosError } from 'axios';

        export const apiClient = axios.create();

        apiClient.interceptors.response.use(
          (response) => response,
          async (error: AxiosError) => {
            const config = error.config as RetriableConfig | undefined;
            const isPortalRequest = config?.url?.includes('/v1/portal/')
              || config?.url?.includes('/v1/service-requests/portal/');

            if (error.response?.status === 401 && config && !config._retried && !isPortalRequest) {
              config._retried = true;

              try {
                const newToken = await refreshAccessToken();
                if (newToken) {
                  config.headers.Authorization = \`Bearer \${newToken}\`;
                  return apiClient(config);
                }
              } catch (refreshError) {
                console.error('[apiClient] Token refresh failed:', refreshError);
              }

              window.location.href = '/login';
              return Promise.reject(error);
            }

            emitApiError(error);
            return Promise.reject(error);
          }
        );
      `,
    });
    expect(result.unresolved).toEqual([]);
    expect(result.calls).toEqual([]);
  });

  it('a replay through satisfies, non-null, and paren-wrapped error.config bindings is neither a call nor a finding', () => {
    const result = scanFrom('src/apiClient.ts', {
      'src/apiClient.ts': `
        import axios from 'axios';

        export const apiClient = axios.create();

        apiClient.interceptors.response.use(
          (response) => response,
          async (error) => {
            const config = (error.config as RetriableConfig | undefined)!;
            const cfg = error.config satisfies RetriableConfig | undefined;
            if (config && !config._retried) {
              return apiClient(cfg);
            }
            return apiClient(error.config!);
          },
        );
      `,
    });
    expect(result.unresolved).toEqual([]);
    expect(result.calls).toEqual([]);
  });

  it('a replay passing error.config directly is neither a call nor a finding', () => {
    const result = scanFrom('src/api.jsx', {
      'src/api.jsx': `
        import axios from 'axios';

        export const apiClient = axios.create();

        apiClient.interceptors.response.use(
          (response) => response,
          (error) => {
            return apiClient(error.config);
          },
        );
      `,
    });
    expect(result.unresolved).toEqual([]);
    expect(result.calls).toEqual([]);
  });

  it('a replay through a destructured { config } handler parameter is neither a call nor a finding', () => {
    const result = scanFrom('src/api.jsx', {
      'src/api.jsx': `
        import axios from 'axios';

        export const apiClient = axios.create();

        apiClient.interceptors.response.use(
          (response) => response,
          async ({ config, status }) => {
            if (status === 401) {
              return apiClient(config);
            }
            return Promise.reject(config);
          },
        );
      `,
    });
    expect(result.unresolved).toEqual([]);
    expect(result.calls).toEqual([]);
  });

  it('a config-only call on a DIFFERENT client symbol inside an interceptor stays unresolved', () => {
    const result = scanFrom('src/api.jsx', {
      'src/api.jsx': `
        import axios from 'axios';

        export const apiClient = axios.create();

        apiClient.interceptors.response.use(
          (response) => response,
          (error) => otherClient(error.config),
        );
      `,
    });
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]?.code).toBe(FRONTEND_CALL_TARGET_UNRESOLVED);
    expect(result.unresolved[0]?.detail).toContain('otherClient');
    expect(result.unresolved[0]?.detail).toContain('without an inline config object');
  });

  it('a configured call without an inline config outside any interceptor stays unresolved', () => {
    const result = scanFrom('src/api.jsx', {
      'src/api.jsx': `
        import axios from 'axios';

        export const apiClient = axios.create();

        export function ping() {
          return apiClient(mysteryConfig);
        }
      `,
    });
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]?.code).toBe(FRONTEND_CALL_TARGET_UNRESOLVED);
    expect(result.unresolved[0]?.detail).toContain('without an inline config object');
  });

  it('concrete calls inside an interceptor handler are still recorded', () => {
    const result = scanFrom('src/api.jsx', {
      'src/api.jsx': `
        import axios from 'axios';

        export const apiClient = axios.create();

        apiClient.interceptors.response.use(
          (response) => response,
          async (error) => {
            if (error.response?.status === 401) {
              await apiClient.post('/refresh-token');
              return apiClient(error.config);
            }
            return Promise.reject(error);
          },
        );
      `,
    });
    expect(result.unresolved).toEqual([]);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toMatchObject({ method: 'POST', rawPath: '/refresh-token', framework: 'apiClient' });
  });
});

describe('client scan: JSX prop wrapper targets', () => {
  const apiModule = `
    import axios from 'axios';

    export const apiClient = axios.create();

    export async function useApiGet(path) {
      const response = await apiClient.get(path);
      return response.data;
    }

    export async function DuplicateRowAction(apiBasePath) {
      await apiClient.delete(apiBasePath);
      return null;
    }
  `;

  const searchableDropdown = `
    import { useApiGet } from './api.jsx';

    export function SearchableDropdown({ apiEndpoint }) {
      const options = useApiGet(apiEndpoint);
      return <input list={options} />;
    }
  `;

  it('two literal usage sites emit one call per distinct target and no finding', () => {
    const result = scanFrom('src/SearchableDropdown.jsx', {
      'src/api.jsx': apiModule,
      'src/SearchableDropdown.jsx': searchableDropdown,
      'src/screens.jsx': `
        import { SearchableDropdown } from './SearchableDropdown.jsx';

        export function ContractsScreen() {
          return <SearchableDropdown apiEndpoint="/contracts/" />;
        }

        export function InvoicesScreen() {
          return <SearchableDropdown apiEndpoint="/invoices/" />;
        }
      `,
    });
    expect(result.unresolved).toEqual([]);
    expect(result.calls.map((call) => call.rawPath).sort()).toEqual(['/contracts/', '/invoices/']);
    expect(result.calls.every((call) => call.framework === 'useApiGet')).toBe(true);
    expect(result.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(result.calls.every((call) => call.location.file === 'src/SearchableDropdown.jsx')).toBe(true);
  });

  it('a usage site passing an unresolvable value keeps the finding', () => {
    const result = scanFrom('src/SearchableDropdown.jsx', {
      'src/api.jsx': apiModule,
      'src/SearchableDropdown.jsx': searchableDropdown,
      'src/screens.jsx': `
        import { SearchableDropdown } from './SearchableDropdown.jsx';

        export function MysteryScreen({ dynamicPath }) {
          return <SearchableDropdown apiEndpoint={dynamicPath} />;
        }
      `,
    });
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]?.code).toBe(FRONTEND_CALL_TARGET_UNRESOLVED);
    expect(result.unresolved[0]?.detail).toBe('call target cannot be resolved statically (useApiGet)');
    expect(result.calls).toEqual([]);
  });

  it('a component with no usage sites keeps the finding', () => {
    const result = scanFrom('src/SearchableDropdown.jsx', {
      'src/api.jsx': apiModule,
      'src/SearchableDropdown.jsx': searchableDropdown,
    });
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]?.code).toBe(FRONTEND_CALL_TARGET_UNRESOLVED);
    expect(result.unresolved[0]?.detail).toBe('call target cannot be resolved statically (useApiGet)');
    expect(result.calls).toEqual([]);
  });

  it('two usage sites with the same literal emit one call', () => {
    const result = scanFrom('src/SearchableDropdown.jsx', {
      'src/api.jsx': apiModule,
      'src/SearchableDropdown.jsx': searchableDropdown,
      'src/screens.jsx': `
        import { SearchableDropdown } from './SearchableDropdown.jsx';

        export function FirstScreen() {
          return <SearchableDropdown apiEndpoint="/contracts/" />;
        }

        export function SecondScreen() {
          return <SearchableDropdown apiEndpoint="/contracts/" />;
        }
      `,
    });
    expect(result.unresolved).toEqual([]);
    expect(result.calls.map((call) => call.rawPath)).toEqual(['/contracts/']);
  });

  it('one hop of unchanged prop forwarding resolves', () => {
    const result = scanFrom('src/ActionRow.jsx', {
      'src/api.jsx': apiModule,
      'src/ActionRow.jsx': `
        import { DuplicateRowAction } from './api.jsx';

        export function ActionRow({ apiBasePath }) {
          return <DuplicateRowAction apiBasePath={apiBasePath} />;
        }
      `,
      'src/DataTable.jsx': `
        import { ActionRow } from './ActionRow.jsx';

        export function DataTable({ apiBasePath }) {
          return <ActionRow apiBasePath={apiBasePath} />;
        }
      `,
      'src/views.jsx': `
        import { DataTable } from './DataTable.jsx';

        export function ProjectsView() {
          return <DataTable apiBasePath="/projects" />;
        }
      `,
    });
    expect(result.unresolved).toEqual([]);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toMatchObject({
      method: 'DELETE',
      rawPath: '/projects',
      framework: 'DuplicateRowAction',
    });
    expect(result.calls[0]?.location.file).toBe('src/ActionRow.jsx');
  });

  it('a wrapper attribute that is a member access on a prop keeps the finding', () => {
    const result = scanFrom('src/ActionRow.jsx', {
      'src/api.jsx': apiModule,
      'src/ActionRow.jsx': `
        import { DuplicateRowAction } from './api.jsx';

        export function ActionRow({ duplicate }) {
          return <DuplicateRowAction apiBasePath={duplicate.apiBasePath} />;
        }
      `,
      'src/views.jsx': `
        import { ActionRow } from './ActionRow.jsx';

        export function ProjectsView() {
          return <ActionRow duplicate={{ apiBasePath: '/projects' }} />;
        }
      `,
    });
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]?.code).toBe(FRONTEND_CALL_TARGET_UNRESOLVED);
    expect(result.unresolved[0]?.detail).toBe('call target cannot be resolved statically (DuplicateRowAction)');
    expect(result.calls).toEqual([]);
  });
});

describe('client scan: JSX prop destructuring defaults', () => {
  const wrapperApiModule = `
    import axios from 'axios';

    export const apiClient = axios.create();

    export async function useApiGet(path) {
      const response = await apiClient.get(path);
      return response.data;
    }
  `;

  const defaultedDropdown = `
    import { useApiGet } from './api.jsx';

    export function SearchableDropdown({ base, detail = null }) {
      const options = useApiGet(detail === null ? \`\${base}/x\` : \`\${detail}/x\`);
      return <input list={options} />;
    }
  `;

  it('a usage omitting a prop with a literal destructuring default resolves through the default', () => {
    const result = scanFrom('src/SearchableDropdown.jsx', {
      'src/api.jsx': wrapperApiModule,
      'src/SearchableDropdown.jsx': defaultedDropdown,
      'src/screens.jsx': `
        import { SearchableDropdown } from './SearchableDropdown.jsx';

        export function ContractsScreen() {
          return <SearchableDropdown base="/contracts/" />;
        }

        export function InvoicesScreen() {
          return <SearchableDropdown base="/invoices/" />;
        }
      `,
    });
    expect(result.unresolved).toEqual([]);
    expect(result.calls.map((call) => call.rawPath).sort()).toEqual(['/contracts//x', '/invoices//x']);
    expect(result.calls.map((call) => call.canonicalPath).sort()).toEqual(['/contracts/x', '/invoices/x']);
    expect(result.calls.every((call) => call.framework === 'useApiGet')).toBe(true);
    expect(result.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(result.calls.every((call) => call.location.file === 'src/SearchableDropdown.jsx')).toBe(true);
  });

  it('a usage passing the defaulted prop selects the other ternary branch', () => {
    const result = scanFrom('src/SearchableDropdown.jsx', {
      'src/api.jsx': wrapperApiModule,
      'src/SearchableDropdown.jsx': defaultedDropdown,
      'src/screens.jsx': `
        import { SearchableDropdown } from './SearchableDropdown.jsx';

        export function ContractsScreen() {
          return <SearchableDropdown base="/contracts/" detail="/b" />;
        }

        export function InvoicesScreen() {
          return <SearchableDropdown base="/invoices/" />;
        }
      `,
    });
    expect(result.unresolved).toEqual([]);
    expect(result.calls.map((call) => call.rawPath).sort()).toEqual(['/b/x', '/invoices//x']);
  });

  it('a config object carrying props into a destructured hook resolves omitted defaults', () => {
    const result = scanFrom('src/SearchableDropdown.jsx', {
      'src/api.jsx': `
        import axios from 'axios';

        export const apiClient = axios.create();

        export async function useApiGet({ endpoint, detailEndpoint }) {
          const target = detailEndpoint === null ? endpoint : detailEndpoint;
          const response = await apiClient.get(\`\${target}/x\`);
          return response.data;
        }
      `,
      'src/SearchableDropdown.jsx': `
        import { useApiGet } from './api.jsx';

        export function SearchableDropdown({ apiEndpoint, detailEndpoint = null }) {
          const options = useApiGet({ endpoint: apiEndpoint, detailEndpoint });
          return <input list={options} />;
        }
      `,
      'src/screens.jsx': `
        import { SearchableDropdown } from './SearchableDropdown.jsx';

        export function ContractsScreen() {
          return <SearchableDropdown apiEndpoint="/contracts/" />;
        }

        export function InvoicesScreen() {
          return <SearchableDropdown apiEndpoint="/invoices/" />;
        }
      `,
    });
    expect(result.unresolved).toEqual([]);
    expect(result.calls.map((call) => call.rawPath).sort()).toEqual(['/contracts//x', '/invoices//x']);
    expect(result.calls.map((call) => call.canonicalPath).sort()).toEqual(['/contracts/x', '/invoices/x']);
    expect(result.calls.every((call) => call.framework === 'useApiGet')).toBe(true);
    expect(result.calls.every((call) => call.location.file === 'src/SearchableDropdown.jsx')).toBe(true);
  });

  it('positional arguments carrying props into a hook resolve omitted defaults', () => {
    const result = scanFrom('src/SearchableDropdown.jsx', {
      'src/api.jsx': `
        import axios from 'axios';

        export const apiClient = axios.create();

        export async function useApiGet(endpoint, detailEndpoint) {
          const target = detailEndpoint === null ? endpoint : detailEndpoint;
          const response = await apiClient.get(\`\${target}/x\`);
          return response.data;
        }
      `,
      'src/SearchableDropdown.jsx': `
        import { useApiGet } from './api.jsx';

        export function SearchableDropdown({ apiEndpoint, detailEndpoint = null }) {
          const options = useApiGet(apiEndpoint, detailEndpoint);
          return <input list={options} />;
        }
      `,
      'src/screens.jsx': `
        import { SearchableDropdown } from './SearchableDropdown.jsx';

        export function ContractsScreen() {
          return <SearchableDropdown apiEndpoint="/contracts/" />;
        }

        export function InvoicesScreen() {
          return <SearchableDropdown apiEndpoint="/invoices/" />;
        }
      `,
    });
    expect(result.unresolved).toEqual([]);
    expect(result.calls.map((call) => call.rawPath).sort()).toEqual(['/contracts//x', '/invoices//x']);
    expect(result.calls.map((call) => call.canonicalPath).sort()).toEqual(['/contracts/x', '/invoices/x']);
  });

  it('a usage omitting a prop with no destructuring default keeps the finding', () => {
    const result = scanFrom('src/SearchableDropdown.jsx', {
      'src/api.jsx': wrapperApiModule,
      'src/SearchableDropdown.jsx': `
        import { useApiGet } from './api.jsx';

        export function SearchableDropdown({ base, detail }) {
          const options = useApiGet(detail === null ? \`\${base}/x\` : \`\${detail}/x\`);
          return <input list={options} />;
        }
      `,
      'src/screens.jsx': `
        import { SearchableDropdown } from './SearchableDropdown.jsx';

        export function ContractsScreen() {
          return <SearchableDropdown base="/contracts/" />;
        }
      `,
    });
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]?.code).toBe(FRONTEND_CALL_TARGET_UNRESOLVED);
    expect(result.unresolved[0]?.detail).toBe('call target cannot be resolved statically (useApiGet)');
    expect(result.calls).toEqual([]);
  });

  it('a non-literal destructuring default keeps the finding', () => {
    const result = scanFrom('src/SearchableDropdown.jsx', {
      'src/api.jsx': wrapperApiModule,
      'src/SearchableDropdown.jsx': `
        import { useApiGet } from './api.jsx';

        function makePath() {
          return '/generated/';
        }

        export function SearchableDropdown({ base, detail = makePath() }) {
          const options = useApiGet(detail === null ? \`\${base}/x\` : \`\${detail}/x\`);
          return <input list={options} />;
        }
      `,
      'src/screens.jsx': `
        import { SearchableDropdown } from './SearchableDropdown.jsx';

        export function ContractsScreen() {
          return <SearchableDropdown base="/contracts/" />;
        }
      `,
    });
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]?.code).toBe(FRONTEND_CALL_TARGET_UNRESOLVED);
    expect(result.unresolved[0]?.detail).toBe('call target cannot be resolved statically (useApiGet)');
    expect(result.calls).toEqual([]);
  });

  it('a spread usage keeps the finding', () => {
    const result = scanFrom('src/SearchableDropdown.jsx', {
      'src/api.jsx': wrapperApiModule,
      'src/SearchableDropdown.jsx': defaultedDropdown,
      'src/screens.jsx': `
        import { SearchableDropdown } from './SearchableDropdown.jsx';

        export function MysteryScreen(props) {
          return <SearchableDropdown {...props} />;
        }
      `,
    });
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]?.code).toBe(FRONTEND_CALL_TARGET_UNRESOLVED);
    expect(result.unresolved[0]?.detail).toBe('call target cannot be resolved statically (useApiGet)');
    expect(result.calls).toEqual([]);
  });
});
