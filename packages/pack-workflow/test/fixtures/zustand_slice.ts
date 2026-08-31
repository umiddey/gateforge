/**
 * Fixture for the Zustand state-slice detector arm.
 *
 *   idle -> loading -> ready -> error
 *
 * Local stand-in for zustand: the detector matches on the call shape
 * `create((set, get) => ({ ... }))`, not the library itself.
 */

type SetState<T> = (partial: Partial<T>) => void;
type GetState<T> = () => T;

interface CreateApi<T> {
  (initializer: (set: SetState<T>, get: GetState<T>) => T): { getState: () => T };
}

/** Local stand-in for `import { create } from 'zustand'`. */
export const create: CreateApi<SliceState> = (initializer) => {
  let state = initializer(() => {}, () => state);
  return { getState: () => state };
};

interface SliceState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  transition: (event: string) => void;
}

export const useSlice = create((set) => ({
  status: 'idle',
  transition: (event: string) => {
    if (event === 'load') set({ status: 'loading' });
    else if (event === 'finish') set({ status: 'ready' });
    else if (event === 'fail') set({ status: 'error' });
  },
}));

// Audit sink mention keeps `auditEvent: true` on this fixture.
const audit = 'audit.json';
void audit;