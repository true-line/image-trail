import { useCallback, useEffect, useMemo, useState } from 'react';

import { inlineImageThumbnail, recordHasStoredOriginal, type ImageDisplayRecord } from '../core/display-records.js';
import type { RecallCandidate } from '../core/types.js';
import { recordDisplayName, recordExtensionLabel, recordMetadataText } from '../ui/components/record-metadata.js';
import type { DestinationServices, RecallWindow } from './destination-services.js';
import { useRequestGeneration } from './request-generation.js';

interface RecallPageState {
  readonly busy: boolean;
  readonly candidates: readonly RecallCandidate[];
  readonly selectedIds: readonly string[];
  readonly nextOffset: number;
  readonly total: number;
  readonly hasMore: boolean;
  readonly privacyMode: boolean;
  readonly message: string | null;
  readonly error: string | null;
}

const INITIAL_STATE: RecallPageState = {
  busy: true,
  candidates: [],
  selectedIds: [],
  nextOffset: 0,
  total: 0,
  hasMore: false,
  privacyMode: false,
  message: null,
  error: null,
};

function applyWindow(current: RecallPageState, page: RecallWindow, append: boolean): RecallPageState {
  const result = page.result;
  if (!result.ok) return { ...current, busy: false, error: result.message, message: null };
  const candidates = append ? [...current.candidates, ...result.candidates] : result.candidates;
  const available = new Set(candidates.map((candidate) => candidate.id));
  return {
    busy: false,
    candidates,
    selectedIds: current.selectedIds.filter((id) => available.has(id)),
    nextOffset: result.nextOffset,
    total: result.total,
    hasMore: result.hasMore,
    privacyMode: page.privacyMode,
    message: result.message || null,
    error: null,
  };
}

function useRecall(services: DestinationServices) {
  const [state, setState] = useState<RecallPageState>(INITIAL_STATE);
  const requests = useRequestGeneration();
  const load = useCallback(
    async (offset?: number, append = false) => {
      const request = requests.begin();
      setState((current) => ({ ...current, busy: true, error: null }));
      try {
        const page = await services.loadRecall(offset);
        if (requests.isCurrent(request)) setState((current) => applyWindow(current, page, append));
      } catch {
        if (requests.isCurrent(request)) {
          setState((current) => ({ ...current, busy: false, error: 'Recall could not load durable queue records.' }));
        }
      }
    },
    [requests, services],
  );
  useEffect(() => {
    void load();
    return services.subscribeLibrary(() => void load());
  }, [load, services]);
  const toggle = useCallback((id: string) => {
    setState((current) => ({
      ...current,
      selectedIds: current.selectedIds.includes(id)
        ? current.selectedIds.filter((selectedId) => selectedId !== id)
        : [...current.selectedIds, id],
    }));
  }, []);
  const recallSelected = useCallback(async () => {
    if (state.selectedIds.length === 0) return;
    const request = requests.begin();
    setState((current) => ({ ...current, busy: true, error: null }));
    const result = await services.recall(state.selectedIds);
    if (!requests.isCurrent(request)) return;
    if (!result.ok) return setState((current) => ({ ...current, busy: false, error: result.message }));
    setState((current) => ({ ...current, selectedIds: [], message: result.message }));
    await load();
  }, [load, requests, services, state.selectedIds]);
  return { state, load, toggle, recallSelected, setState };
}

function RecallRow({
  record,
  selected,
  privacyMode,
  onToggle,
}: {
  readonly record: ImageDisplayRecord;
  readonly selected: boolean;
  readonly privacyMode: boolean;
  readonly onToggle: () => void;
}) {
  const masked = privacyMode || record.privacyStatus === 'locked';
  const name = recordDisplayName(record, { privacyMode: masked });
  return (
    <li
      className="image-trail-destination-recall__row"
      data-selected={selected ? 'true' : undefined}
      data-privacy={masked ? 'true' : undefined}
    >
      <label>
        <input type="checkbox" checked={selected} onChange={onToggle} />
        {inlineImageThumbnail(record.thumbnail) && !masked ? (
          <img src={inlineImageThumbnail(record.thumbnail)} alt="" />
        ) : (
          <span aria-hidden="true">{masked ? 'PRIVATE' : 'IMG'}</span>
        )}
        <span>
          <strong>{name}</strong>
          <small>{masked ? 'Private durable record' : `${recordExtensionLabel(record)} · ${recordMetadataText(record)}`}</small>
        </span>
        {recordHasStoredOriginal(record) ? <i title="Original stored" aria-label="Original stored" /> : null}
      </label>
    </li>
  );
}

export function RecallDestination({ services }: { readonly services: DestinationServices }) {
  const recall = useRecall(services);
  const state = recall.state;
  const selected = useMemo(() => new Set(state.selectedIds), [state.selectedIds]);
  return (
    <div className="image-trail-destination-recall">
      <div className="image-trail-destination-page__toolbar">
        <p>
          {state.candidates.length} shown of {state.total} global durable records
        </p>
        <button type="button" disabled={state.busy} onClick={() => void recall.load()}>
          {state.busy ? 'Loading…' : 'Reload'}
        </button>
      </div>
      <p className={`image-trail-destination-page__status${state.error ? ' is-error' : ''}`}>
        {state.error ?? state.message ?? 'Select offscreen queue records to move them to the front.'}
      </p>
      {state.candidates.length > 0 ? (
        <ol className="image-trail-destination-recall__list">
          {state.candidates.map((record) => (
            <RecallRow
              key={record.id}
              record={record}
              selected={selected.has(record.id)}
              privacyMode={state.privacyMode}
              onToggle={() => recall.toggle(record.id)}
            />
          ))}
        </ol>
      ) : (
        <p className="image-trail-destination-page__empty">
          {state.busy ? 'Loading…' : 'No durable queue records are currently offscreen.'}
        </p>
      )}
      <div className="image-trail-destination-page__actions">
        <button
          type="button"
          disabled={state.busy || state.candidates.length === 0}
          onClick={() => recall.setState((current) => ({ ...current, selectedIds: current.candidates.map((record) => record.id) }))}
        >
          Select shown
        </button>
        <button
          type="button"
          disabled={state.busy || state.selectedIds.length === 0}
          onClick={() => recall.setState((current) => ({ ...current, selectedIds: [] }))}
        >
          Clear selection
        </button>
        {state.hasMore ? (
          <button type="button" disabled={state.busy} onClick={() => void recall.load(state.nextOffset, true)}>
            Load more
          </button>
        ) : null}
        <button
          type="button"
          className="is-primary"
          disabled={state.busy || state.selectedIds.length === 0}
          onClick={() => void recall.recallSelected()}
        >
          Recall selected ({state.selectedIds.length})
        </button>
      </div>
      <p className="image-trail-destination-page__note">
        Recall reads the durable queue producer only. It never reads encrypted blobs directly and never creates Recents.
      </p>
    </div>
  );
}
