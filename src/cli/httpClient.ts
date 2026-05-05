/**
 * Thin HTTP client for the facilitator's admin API.
 *
 * Config precedence (highest → lowest):
 *   1. --url / --token command flags   (caller passes cliOptions)
 *   2. X402_URL / X402_ADMIN_TOKEN env vars
 *   3. default URL http://localhost:3000 (token has no default — fail if absent)
 *
 * Configuration picker (for requests scoped to a configuration):
 *   --configuration <id> flag → X-Configuration-ID header
 *     else CONFIGURATION env var → X-Configuration-ID header
 *     else nothing — server uses default_configuration_id
 */

export interface CliHttpOptions {
  url?: string;
  token?: string;
  configuration?: string;
}

export class CliHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message: string,
  ) {
    super(message);
  }
}

export interface CliHttpClient {
  readonly baseUrl: string;
  readonly configuration: string | null;
  get<T = unknown>(path: string, query?: Record<string, string | number | undefined>): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  del<T = unknown>(path: string): Promise<T>;
}

export function createCliHttpClient(opts: CliHttpOptions = {}): CliHttpClient {
  const baseUrl = (opts.url ?? process.env.X402_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  const token = opts.token ?? process.env.X402_ADMIN_TOKEN;
  if (!token) {
    throw new Error(
      'No admin token configured. Set X402_ADMIN_TOKEN=<token> or pass --token <token>.\n' +
        "Mint one with: x402 keys create --scopes '*' --label cli-admin  (DEV_ADMIN_FALLBACK)\n" +
        'or for production: x402 admin jwt --secret $X402_ADMIN_JWT_SECRET',
    );
  }
  const configuration = opts.configuration ?? process.env.CONFIGURATION ?? null;

  function headers(): Record<string, string> {
    const h: Record<string, string> = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
    if (configuration) h['x-configuration-id'] = configuration;
    return h;
  }

  async function parse<T>(res: Response, path: string): Promise<T> {
    const text = await res.text();
    let body: unknown = text;
    if (text && res.headers.get('content-type')?.includes('json')) {
      try {
        body = JSON.parse(text);
      } catch {
        // fall through with text body
      }
    }
    if (!res.ok) {
      const message =
        (body && typeof body === 'object' && 'error' in body
          ? String((body as { error: unknown }).error)
          : res.statusText) || `HTTP ${res.status}`;
      throw new CliHttpError(res.status, body, `${message} (${res.status} from ${path})`);
    }
    return body as T;
  }

  return {
    baseUrl,
    configuration,

    async get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
      const url = new URL(baseUrl + path);
      if (query) {
        for (const [k, v] of Object.entries(query)) {
          if (v !== undefined && v !== null && v !== '') {
            url.searchParams.set(k, String(v));
          }
        }
      }
      const res = await fetch(url.toString(), { method: 'GET', headers: headers() });
      return parse<T>(res, path);
    },

    async post<T>(path: string, body?: unknown): Promise<T> {
      const res = await fetch(baseUrl + path, {
        method: 'POST',
        headers: headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return parse<T>(res, path);
    },

    async del<T>(path: string): Promise<T> {
      const res = await fetch(baseUrl + path, { method: 'DELETE', headers: headers() });
      return parse<T>(res, path);
    },
  };
}
