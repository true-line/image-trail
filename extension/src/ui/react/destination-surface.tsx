import { useLayoutEffect, useRef, type MouseEvent, type ReactNode } from 'react';

import { inlineImageThumbnail, type ImageDisplayRecord } from '../../core/display-records.js';
import type { PanelAction, PanelDestinationId, PanelState } from '../../core/types.js';
import { isCapturedOriginalRecord } from '../components/bookmarks-view.js';
import { openInteropWorkflow } from '../components/interop-workflow-view.js';
import { recordDisplayName, recordTitle } from '../components/record-metadata.js';
import { panelDestination } from '../destination-registry.js';
import { destinationDockSelector } from './destination-dock.js';
import { renderReactSubtree } from './react-subtree.js';

declare const __IMAGE_TRAIL_INTEROP_ENABLED__: boolean | undefined;
const transferSyncEnabled = typeof __IMAGE_TRAIL_INTEROP_ENABLED__ === 'boolean' && __IMAGE_TRAIL_INTEROP_ENABLED__;

interface DestinationSurfaceProps {
  readonly state: PanelState;
  readonly dispatch: (action: PanelAction) => void;
  readonly domBody?: HTMLElement | undefined;
}

function DomBody({ content, destination }: { readonly content: HTMLElement; readonly destination: PanelDestinationId }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.replaceChildren(content);
    return () => {
      if (content.parentElement === host) content.remove();
    };
  }, [content]);
  return <div ref={hostRef} className="image-trail-panel__destination-dom-host" data-destination={destination} />;
}

function StatTile({ label, value, tone }: { readonly label: string; readonly value: number; readonly tone?: string }) {
  return (
    <div className="image-trail-panel__destination-stat" data-tone={tone}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function DashboardBody({ state, dispatch }: { readonly state: PanelState; readonly dispatch: (action: PanelAction) => void }) {
  const targetUrl = state.target.selectedUrl;
  const draftUrl = state.draftUrl ?? targetUrl;
  const applied = !draftUrl || draftUrl === targetUrl;
  const captured = state.bookmarks.filter(isCapturedOriginalRecord).length;
  const pins = Math.max(0, state.bookmarkTotal - captured);
  const targetCopy = state.privacyModeEnabled ? 'Private target' : (targetUrl ?? 'No target selected');
  return (
    <div className="image-trail-panel__dashboard-destination">
      <div className="image-trail-panel__dashboard-target image-trail-ds__card">
        {targetUrl && !state.privacyModeEnabled ? (
          <img src={targetUrl} alt="" />
        ) : (
          <span className="image-trail-panel__destination-image-placeholder" aria-hidden="true">
            IMG
          </span>
        )}
        <div>
          <p title={targetCopy}>{targetCopy}</p>
          <span className="image-trail-ds__badge" data-tone={targetUrl ? 'selected' : 'count'}>
            {targetUrl ? 'Selected' : 'Waiting'}
          </span>
          <span className="image-trail-panel__destination-applied">{applied ? 'applied' : 'not applied'}</span>
        </div>
      </div>
      <div className="image-trail-panel__destination-stats">
        <StatTile label="Pins" value={pins} />
        <StatTile label="Bookmarks" value={captured} tone="accent" />
        <StatTile label="In trail" value={state.successfulFieldIds.length} />
        <StatTile label="Trash" value={0} />
      </div>
      <p className="image-trail-panel__destination-note">
        Trail:{' '}
        <strong>{state.successfulFieldIds.length > 0 ? `${state.successfulFieldIds.length} proven fields` : 'nothing walking'}</strong>
        {state.successfulFieldIds.length === 0 ? ' — enable Trail on a field to walk it' : ''}
      </p>
      <div className="image-trail-panel__destination-actions">
        <button type="button" aria-label="Previous trail step" onClick={() => dispatch({ name: 'navigate-previous' })}>
          ◀
        </button>
        <button type="button" onClick={() => dispatch({ name: 'navigate-next' })}>
          Next ▶
        </button>
        <button
          type="button"
          className="is-primary"
          disabled={applied}
          onClick={() => draftUrl && dispatch({ name: 'selected-url/apply', url: draftUrl })}
        >
          Apply to Host
        </button>
      </div>
    </div>
  );
}

function GalleryTile({
  record,
  state,
  dispatch,
}: {
  readonly record: ImageDisplayRecord;
  readonly state: PanelState;
  readonly dispatch: (action: PanelAction) => void;
}) {
  const privacyMasked = state.privacyModeEnabled || record.privacyStatus === 'locked';
  const name = recordDisplayName(record, { privacyMode: state.privacyModeEnabled });
  const captured = isCapturedOriginalRecord(record);
  return (
    <button
      type="button"
      className="image-trail-panel__gallery-tile"
      data-stored-original={captured ? 'true' : 'false'}
      title={recordTitle(record, { privacyMode: state.privacyModeEnabled })}
      disabled={record.privacyStatus === 'locked'}
      onClick={() => dispatch({ name: 'bookmark/load', id: record.id })}
    >
      {!privacyMasked && inlineImageThumbnail(record.thumbnail) ? (
        <img src={inlineImageThumbnail(record.thumbnail)} alt="" />
      ) : (
        <span className="image-trail-panel__destination-image-placeholder" aria-hidden="true">
          {privacyMasked ? 'PRIVATE' : 'IMG'}
        </span>
      )}
      {captured ? <i className="image-trail-panel__gallery-original" title="Original stored" aria-label="Original stored" /> : null}
      <span>{name}</span>
    </button>
  );
}

function GalleryBody({ state, dispatch }: { readonly state: PanelState; readonly dispatch: (action: PanelAction) => void }) {
  return (
    <div className="image-trail-panel__gallery-destination">
      <p className="image-trail-panel__destination-note">
        Pinned &amp; captured images · activate a tile to load it without changing queue order.
      </p>
      {transferSyncEnabled ? (
        <button
          type="button"
          disabled={state.bookmarks.length === 0}
          onClick={(event) =>
            openGalleryInteropWorkflow(
              state.bookmarks.map((bookmark) => bookmark.id),
              !state.blobKeyUnlocked && state.blobKeyAvailable,
              event.currentTarget,
            )
          }
        >
          Transfer &amp; Sync
        </button>
      ) : null}
      {state.bookmarks.length > 0 ? (
        <div className="image-trail-panel__gallery-grid">
          {state.bookmarks.map((record) => (
            <GalleryTile key={record.id} record={record} state={state} dispatch={dispatch} />
          ))}
        </div>
      ) : (
        <p className="image-trail-panel__destination-empty">Nothing pinned yet. Pin or capture an image to build the Gallery.</p>
      )}
    </div>
  );
}

export function openGalleryInteropWorkflow(recordIds: readonly string[], locked: boolean, anchor: Element): void {
  openInteropWorkflow('gallery', recordIds, locked, anchor);
}

function restoreDockFocus(event: MouseEvent<HTMLButtonElement>, destination: PanelDestinationId, dispatch: (action: PanelAction) => void) {
  const root = event.currentTarget.getRootNode();
  const queryRoot = root instanceof Document || root instanceof ShadowRoot ? root : document;
  dispatch({ name: 'destination/close' });
  queueMicrotask(() => queryRoot.querySelector<HTMLElement>(destinationDockSelector(destination))?.focus({ preventScroll: true }));
}

function DestinationSurface({ state, dispatch, domBody }: DestinationSurfaceProps) {
  const active = state.activeDestination;
  if (!active) return null;
  const destination = panelDestination(active);
  let body: ReactNode;
  if (domBody) body = <DomBody content={domBody} destination={active} />;
  else if (active === 'dashboard') body = <DashboardBody state={state} dispatch={dispatch} />;
  else body = <GalleryBody state={state} dispatch={dispatch} />;
  return (
    <section
      className="image-trail-panel__destination-surface"
      data-destination={active}
      role="dialog"
      aria-modal="false"
      aria-labelledby={`image-trail-destination-${active}-title`}
    >
      <header className="image-trail-panel__destination-header">
        <span aria-hidden="true">{destination.glyph}</span>
        <h3 id={`image-trail-destination-${active}-title`}>{destination.label}</h3>
        {destination.openInTabAction ? (
          <button
            type="button"
            className="image-trail-panel__destination-open-tab"
            aria-label={`Open ${destination.label} in tab`}
            title={`Open ${destination.label} in tab`}
            onClick={() => dispatch(destination.openInTabAction?.() ?? destination.activationAction())}
          >
            ↗
          </button>
        ) : null}
        <button
          type="button"
          className="image-trail-panel__destination-close"
          aria-label={`Close ${destination.label}`}
          title={`Close ${destination.label} and return to the primary workflow`}
          onClick={(event) => restoreDockFocus(event, active, dispatch)}
        >
          ✕
        </button>
      </header>
      <div className="image-trail-panel__destination-body" data-destination={active}>
        {body}
      </div>
    </section>
  );
}

export function createPanelDestinationSurface(
  state: PanelState,
  dispatch: (action: PanelAction) => void,
  domBody?: HTMLElement,
): HTMLElement {
  const root = document.createElement('div');
  root.className = 'image-trail-panel__destination-root';
  return renderReactSubtree(root, <DestinationSurface state={state} dispatch={dispatch} domBody={domBody} />);
}
