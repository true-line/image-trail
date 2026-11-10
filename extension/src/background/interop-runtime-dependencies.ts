import type { InteropOperation } from '../core/interop/contract.js';
import type { InteropProviderId } from '../core/interop/runtime-state.js';
import type { InteropObjectStore } from '../core/interop/transport.js';
import type { ActiveBlobKey } from '../data/crypto/blob-keyring.js';

export type InteropLocalAvailability =
  'connected' | 'missing-host' | 'not-running' | 'locked' | 'incompatible' | 'unavailable' | 'unsupported';

export interface InteropProviderOpenContext {
  readonly operation: InteropOperation;
  readonly operationId: string;
  readonly remoteSessionId: string;
  readonly pairingId: string;
  readonly recordIds: readonly string[];
}

export interface InteropRuntimeProviderStore extends InteropObjectStore {
  commit?(): Promise<void> | void;
  clearStaged?(): Promise<void>;
}

export interface InteropRuntimeDependencies {
  readonly storage: {
    get(key: string): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
  };
  readonly getDb: () => Promise<IDBDatabase | null>;
  readonly getActiveBlobKey: () => Promise<ActiveBlobKey | null>;
  readonly probePCloud: (interactive: boolean) => Promise<boolean>;
  readonly disconnectPCloud: () => Promise<void>;
  readonly probeGoogleDrive: (interactive: boolean) => Promise<void>;
  readonly disconnectGoogleDrive: () => Promise<void>;
  readonly probeICloud: (pairingId: string, operation: InteropOperation) => Promise<InteropLocalAvailability | void>;
  readonly disconnectICloud: () => Promise<void>;
  readonly cancelICloudOperation: (operationId: string) => Promise<void>;
  readonly openProvider: (provider: InteropProviderId, context: InteropProviderOpenContext) => Promise<InteropRuntimeProviderStore | null>;
  readonly finalizeSourceRecord: (sourceLocalId: string, sourceUpdatedAt: string, sourceFingerprint?: string) => Promise<void>;
}
