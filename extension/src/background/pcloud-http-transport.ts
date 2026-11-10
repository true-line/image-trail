import type { PCloudApiHost } from '../core/cloud/pcloud-provider.js';
import { numberOrUndefined } from './pcloud-provider-utils.js';

const PCLOUD_REQUEST_HEADER_RULE_ID_BASE = 900199;
/** Ids above the base that belong to this module; far more than one worker lifetime allocates. */
const PCLOUD_REQUEST_HEADER_RULE_ID_SPAN = 100_000;
/** `chrome.tabs.TAB_ID_NONE`: the request does not come from a tab. */
const NO_TAB_ID = -1;

export interface PCloudCredential {
  readonly accessToken: string;
  readonly apiHost: PCloudApiHost;
}

export interface PCloudHttpTransportOptions {
  readonly referrer: string;
  readonly fetchImpl?: typeof fetch;
}

export class PCloudApiError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly resultCode: number | null,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = 'PCloudApiError';
  }
}

let pcloudRequestHeaderRuleId = PCLOUD_REQUEST_HEADER_RULE_ID_BASE;

/**
 * Removes every header rule this module owns. Session rules outlive the worker that added
 * them while the id counter above restarts, so rules left by a stopped worker (including
 * unscoped ones from an older version) would otherwise stay active until their id is reused.
 */
export async function clearStalePCloudHeaderRules(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.declarativeNetRequest?.getSessionRules) return;
  const stale = (await chrome.declarativeNetRequest.getSessionRules())
    .map((rule) => rule.id)
    .filter(
      (id) => id > PCLOUD_REQUEST_HEADER_RULE_ID_BASE && id <= PCLOUD_REQUEST_HEADER_RULE_ID_BASE + PCLOUD_REQUEST_HEADER_RULE_ID_SPAN,
    );
  if (stale.length > 0) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: stale });
}

/** Resolved once the worker's start-up sweep has run; every rule install waits for it. */
const staleRulesCleared = clearStalePCloudHeaderRules().catch(() => undefined);

/** Shared request mechanics only; callers continue to own credential custody and product error vocabulary. */
export class PCloudHttpTransport {
  constructor(private readonly options: PCloudHttpTransportOptions) {}

  request(
    credential: PCloudCredential,
    method: string,
    params: Record<string, string> = {},
    withRequestHeaders = false,
  ): Promise<Record<string, unknown>> {
    return this.requestBody(
      credential.apiHost,
      method,
      new URLSearchParams({ access_token: credential.accessToken, ...params }),
      withRequestHeaders,
    );
  }

  requestForm(credential: PCloudCredential, method: string, form: FormData): Promise<Record<string, unknown>> {
    form.set('access_token', credential.accessToken);
    return this.requestBody(credential.apiHost, method, form);
  }

  async download(url: URL): Promise<Response> {
    assertPCloudDownloadUrl(url);
    const removeRule = await this.installRequestHeaderRule(url.toString());
    try {
      return await this.fetch(url, {
        referrer: this.options.referrer,
        referrerPolicy: 'origin',
      });
    } finally {
      await removeRule();
    }
  }

  private async requestBody(
    apiHost: PCloudApiHost,
    method: string,
    body: URLSearchParams | FormData,
    withRequestHeaders = false,
  ): Promise<Record<string, unknown>> {
    const url = `https://${apiHost}/${method}`;
    const removeRule = withRequestHeaders ? await this.installRequestHeaderRule(url) : async () => {};
    try {
      const encoded = body instanceof URLSearchParams;
      const response = await this.fetch(url, {
        method: 'POST',
        ...(encoded
          ? {
              mode: 'cors' as const,
              credentials: 'include' as const,
              referrer: this.options.referrer,
              referrerPolicy: 'origin' as const,
              headers: {
                accept: '*/*',
                'accept-language': 'en-US,en;q=0.9',
                'cache-control': 'no-cache',
                'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
                pragma: 'no-cache',
              },
            }
          : {}),
        body,
      });
      let data: Record<string, unknown>;
      try {
        data = (await response.json()) as Record<string, unknown>;
      } catch (error) {
        if (!response.ok) throw new PCloudApiError(`pCloud ${method} failed.`, method, null, response.status);
        throw error;
      }
      const resultCode = numberOrUndefined(data['result']) ?? null;
      if (!response.ok || resultCode !== 0) {
        const message = typeof data['error'] === 'string' ? data['error'] : `pCloud ${method} failed.`;
        throw new PCloudApiError(message, method, resultCode, response.status);
      }
      return data;
    } finally {
      await removeRule();
    }
  }

  private fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    return Reflect.apply(fetchImpl, globalThis, [input, init]) as Promise<Response>;
  }

  private async installRequestHeaderRule(url: string): Promise<() => Promise<void>> {
    if (typeof chrome === 'undefined' || !chrome.declarativeNetRequest?.updateSessionRules) return async () => {};
    await staleRulesCleared;
    pcloudRequestHeaderRuleId += 1;
    const ruleId = pcloudRequestHeaderRuleId;
    await chrome.declarativeNetRequest.updateSessionRules({
      // Session rules outlive a worker restart while the counter above does not: clear the id
      // first so a rule left behind by a stopped worker cannot make this call fail.
      removeRuleIds: [ruleId],
      addRules: [
        {
          id: ruleId,
          priority: 1,
          action: {
            type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
            requestHeaders: [
              {
                header: 'Referer',
                operation: chrome.declarativeNetRequest.HeaderOperation.SET,
                value: this.options.referrer,
              },
              {
                header: 'Origin',
                operation: chrome.declarativeNetRequest.HeaderOperation.SET,
                value: this.options.referrer,
              },
            ],
          },
          condition: {
            regexFilter: `^${escapeRegExp(url)}$`,
            resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST],
            // Only this extension's own worker request gets the rewritten headers, never a
            // page's request to the same address.
            tabIds: [NO_TAB_ID],
            ...(chrome.runtime?.id ? { initiatorDomains: [chrome.runtime.id] } : {}),
          },
        },
      ],
    });
    return async () => {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
    };
  }
}

export function pCloudDownloadUrl(hostInput: string, path: string): URL {
  const host = hostInput.trim().toLowerCase();
  if ((host !== 'pcloud.com' && !host.endsWith('.pcloud.com')) || !path.startsWith('/')) {
    throw new Error('pCloud returned an unexpected download location.');
  }
  const url = new URL(path, `https://${host}`);
  assertPCloudDownloadUrl(url);
  return url;
}

function assertPCloudDownloadUrl(url: URL): void {
  if (url.protocol !== 'https:' || (url.hostname !== 'pcloud.com' && !url.hostname.endsWith('.pcloud.com'))) {
    throw new Error('pCloud returned an unexpected download location.');
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
