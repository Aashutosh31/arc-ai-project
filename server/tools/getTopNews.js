const cheerio = require('cheerio');

const GDELT_DOC_ENDPOINT = 'https://api.gdeltproject.org/api/v2/doc/doc';
const GDELT_SOURCE = 'GDELT DOC API';
const DEFAULT_QUERY = 'current news';
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const MAX_QUERY_TERM_LENGTH = 100;
const MAX_TITLE_LENGTH = 300;
const MAX_URL_LENGTH = 2048;
const MAX_SOURCE_LENGTH = 120;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10000;
const TRACKING_QUERY_KEYS = new Set([
    'fbclid',
    'gclid',
    'mc_cid',
    'mc_eid',
    'ref',
    'referrer',
    'utm_campaign',
    'utm_content',
    'utm_medium',
    'utm_source',
    'utm_term'
]);
const REGION_COUNTRY_CODES = Object.freeze({
    argentina: 'AR',
    australia: 'AU',
    austria: 'AT',
    belgium: 'BE',
    brazil: 'BR',
    canada: 'CA',
    chile: 'CL',
    china: 'CN',
    colombia: 'CO',
    'czech republic': 'CZ',
    denmark: 'DK',
    egypt: 'EG',
    finland: 'FI',
    france: 'FR',
    germany: 'DE',
    greece: 'GR',
    hungary: 'HU',
    india: 'IN',
    indonesia: 'ID',
    ireland: 'IE',
    israel: 'IL',
    italy: 'IT',
    japan: 'JP',
    malaysia: 'MY',
    mexico: 'MX',
    netherlands: 'NL',
    'new zealand': 'NZ',
    nigeria: 'NG',
    norway: 'NO',
    peru: 'PE',
    philippines: 'PH',
    poland: 'PL',
    portugal: 'PT',
    qatar: 'QA',
    romania: 'RO',
    russia: 'RU',
    'russian federation': 'RU',
    'saudi arabia': 'SA',
    singapore: 'SG',
    'south africa': 'ZA',
    'south korea': 'KR',
    'republic of korea': 'KR',
    spain: 'ES',
    sweden: 'SE',
    switzerland: 'CH',
    thailand: 'TH',
    turkey: 'TR',
    ukraine: 'UA',
    'united kingdom': 'GB',
    'united states': 'US',
    'united states of america': 'US',
    'united arab emirates': 'AE',
    vietnam: 'VN',
    'great britain': 'GB',
    uk: 'GB',
    us: 'US',
    usa: 'US',
    uae: 'AE',
    ar: 'AR',
    au: 'AU',
    at: 'AT',
    be: 'BE',
    br: 'BR',
    ca: 'CA',
    cl: 'CL',
    cn: 'CN',
    co: 'CO',
    cz: 'CZ',
    dk: 'DK',
    eg: 'EG',
    fi: 'FI',
    fr: 'FR',
    de: 'DE',
    gr: 'GR',
    hu: 'HU',
    in: 'IN',
    id: 'ID',
    ie: 'IE',
    il: 'IL',
    it: 'IT',
    jp: 'JP',
    my: 'MY',
    mx: 'MX',
    nl: 'NL',
    nz: 'NZ',
    ng: 'NG',
    no: 'NO',
    pe: 'PE',
    ph: 'PH',
    pl: 'PL',
    pt: 'PT',
    qa: 'QA',
    ro: 'RO',
    ru: 'RU',
    sa: 'SA',
    sg: 'SG',
    za: 'ZA',
    kr: 'KR',
    kp: 'KP',
    es: 'ES',
    se: 'SE',
    ch: 'CH',
    th: 'TH',
    tr: 'TR',
    ua: 'UA',
    ae: 'AE',
    gb: 'GB',
    vn: 'VN'
});

const normalizeText = (value, maxLength) => {
    if (value === undefined || value === null) return '';

    return String(value)
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength)
        .trim();
};

const normalizeLimit = (value) => {
    if (value === undefined || value === null || value === '') return DEFAULT_LIMIT;
    if (typeof value !== 'number' && typeof value !== 'string') return DEFAULT_LIMIT;
    if (typeof value === 'string' && !value.trim()) return DEFAULT_LIMIT;

    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;

    return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(parsed)));
};

const quotePhrase = (value) => {
    const phrase = normalizeText(value, MAX_QUERY_TERM_LENGTH)
        .replace(/["\\]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    return phrase ? `"${phrase}"` : '';
};

const normalizeRegionKey = (value) => normalizeText(value, MAX_QUERY_TERM_LENGTH)
    .toLowerCase()
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeUrl = (value) => {
    const candidate = normalizeText(value, MAX_URL_LENGTH);
    if (!candidate) return '';

    try {
        const parsed = new URL(candidate);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
        return parsed.href;
    } catch {
        return '';
    }
};

const normalizeLinkKey = (value) => {
    try {
        const parsed = new URL(value);
        parsed.hash = '';
        parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';

        for (const key of [...parsed.searchParams.keys()]) {
            if (TRACKING_QUERY_KEYS.has(key.toLowerCase())) parsed.searchParams.delete(key);
        }

        const queryEntries = [...parsed.searchParams.entries()]
            .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
                const left = `${leftKey}=${leftValue}`;
                const right = `${rightKey}=${rightValue}`;
                return left < right ? -1 : left > right ? 1 : 0;
            });
        parsed.search = '';
        for (const [key, value] of queryEntries) parsed.searchParams.append(key, value);

        return parsed.href;
    } catch {
        return normalizeText(value, MAX_URL_LENGTH).toLowerCase();
    }
};

const normalizeTitleKey = (value) => normalizeText(value, MAX_TITLE_LENGTH)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const getArticleSource = (item, url) => {
    const source = normalizeText(item.find('source').first().text(), MAX_SOURCE_LENGTH);
    if (source) return source;

    try {
        return new URL(url).hostname.replace(/^www\./i, '').slice(0, MAX_SOURCE_LENGTH);
    } catch {
        return 'Unknown source';
    }
};

module.exports = {
    schema: {
        type: 'function',
        function: {
            name: 'getTopNews',
            description: "Fetch the latest real-time news headlines from around the world. Use this specifically when the user asks for current news, today's headlines, or what is happening in the world right now.",
            parameters: {
                type: 'object',
                properties: {
                    topic: {
                        type: 'string',
                        description: 'Optional news topic or subject to search for.',
                        maxLength: MAX_QUERY_TERM_LENGTH
                    },
                    region: {
                        type: 'string',
                        description: 'Optional country or region to focus the news search on.',
                        maxLength: MAX_QUERY_TERM_LENGTH
                    },
                    limit: {
                        type: 'integer',
                        description: 'Maximum number of news articles to return.',
                        minimum: 1,
                        maximum: MAX_LIMIT,
                        default: DEFAULT_LIMIT
                    }
                },
                required: []
            }
        }
    },

    execute: async (args = {}) => {
        const input = args && typeof args === 'object' ? args : {};
        const topic = normalizeText(input.topic, MAX_QUERY_TERM_LENGTH);
        const region = normalizeText(input.region, MAX_QUERY_TERM_LENGTH);
        const limit = normalizeLimit(input.limit);
        const clauses = [quotePhrase(topic) || DEFAULT_QUERY];

        if (region) {
            const regionKey = normalizeRegionKey(region);
            const countryCode = Object.prototype.hasOwnProperty.call(REGION_COUNTRY_CODES, regionKey)
                ? REGION_COUNTRY_CODES[regionKey]
                : null;
            const regionClause = countryCode ? `sourcecountry:${countryCode}` : quotePhrase(region);
            if (regionClause) clauses.push(regionClause);
        }

        const query = clauses.join(' AND ');
        const resultContext = {
            source: GDELT_SOURCE,
            query,
            region: region || null,
            topic: topic || null
        };
        // `retryable: false` is a DECLARED verdict, not a guess. Every failure
        // below is either a definitive upstream answer (non-2xx, empty body,
        // oversized body, no usable articles) or a completed request that
        // already consumed the full REQUEST_TIMEOUT_MS budget. An immediate
        // in-turn retry issues the byte-identical request, cannot succeed for a
        // deterministic verdict, and stacks a SECOND full timeout behind the
        // first — the reported "two 10s waits". Genuine transport faults
        // (ECONNRESET, DNS) never reach here; they throw and are classified by
        // ToolRecoveryManager on their own merits.
        const failure = (error) => ({ success: false, retryable: false, ...resultContext, error });
        const params = new URLSearchParams();
        params.set('query', query);
        params.set('mode', 'ArtList');
        params.set('format', 'rss');
        params.set('timespan', '1d');
        params.set('sort', 'DateDesc');
        params.set('maxrecords', String(limit));

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        try {
            const response = await fetch(`${GDELT_DOC_ENDPOINT}?${params.toString()}`, {
                signal: controller.signal,
                headers: {
                    Accept: 'application/rss+xml, application/xml, text/xml'
                }
            });
            const status = response?.status;
            const statusFailed = response?.ok === false ||
                (typeof status === 'number' && (status < 200 || status >= 300));

            if (!response || statusFailed) {
                return failure(`News service returned an unavailable response${status ? ` (HTTP ${status})` : ''}.`);
            }

            const contentLengthHeader = response.headers?.get?.('content-length');
            if (contentLengthHeader !== undefined && contentLengthHeader !== null) {
                const contentLength = Number(contentLengthHeader);
                if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > MAX_RESPONSE_BYTES) {
                    return failure('News service returned an oversized response.');
                }
            }

            const body = await response.text();
            if (typeof body !== 'string' || !body.trim()) {
                return failure('News service returned an empty response.');
            }
            if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
                return failure('News service returned an oversized response.');
            }

            const $ = cheerio.load(body, { xmlMode: true });
            const items = $('item');
            const articles = [];
            const seenTitles = new Set();
            const seenLinks = new Set();

            items.each((_, element) => {
                if (articles.length >= limit) return false;

                const item = $(element);
                const title = normalizeText(item.find('title').first().text(), MAX_TITLE_LENGTH);
                const url = normalizeUrl(item.find('link').first().text());
                const titleKey = normalizeTitleKey(title);
                const linkKey = normalizeLinkKey(url);

                if (!title || !titleKey || !url || !linkKey) return;
                if (seenTitles.has(titleKey) || seenLinks.has(linkKey)) return;

                seenTitles.add(titleKey);
                seenLinks.add(linkKey);

                articles.push({
                    title,
                    headline: title,
                    url,
                    publishedAt: normalizeText(item.find('pubDate').first().text(), 100) || null,
                    source: getArticleSource(item, url)
                });
            });

            if (articles.length === 0) {
                return failure('News service returned no usable current articles.');
            }

            return {
                success: true,
                ...resultContext,
                articles
            };
        } catch (error) {
            if (error?.name === 'AbortError') {
                return failure('News request timed out.');
            }
            return failure(`Failed to fetch current news: ${error?.message || 'Unknown error'}`);
        } finally {
            clearTimeout(timeout);
        }
    }
};
