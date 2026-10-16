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
