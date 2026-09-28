// Where the child is: the kid page's GPS and device info, plus what Cloudflare knows about the
// connection. Everything here is best-effort — a failed lookup never delays or blocks an alert.
import type { MessageContext } from '../shared/types';

const UA = 'SOS2me/2 (self-hosted family safety app; https://github.com/jstdlee/sos2me)';
const str = (v: unknown, max = 80) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
const num = (v: unknown, lo: number, hi: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined;

/** Clean the untrusted GPS fix sent by the kid page. */
export function cleanGps(raw: unknown): MessageContext['gps'] | undefined {
  const g = (raw ?? {}) as Record<string, unknown>;
  const lat = num(g.lat, -90, 90);
  const lon = num(g.lon, -180, 180);
  if (lat === undefined || lon === undefined) return undefined;
  return {
    lat: Math.round(lat * 1e6) / 1e6,
    lon: Math.round(lon * 1e6) / 1e6,
    accuracy: Math.round(num(g.accuracy, 0, 1e6) ?? 0),
    at: new Date().toISOString(),
  };
}

/** Clean the untrusted device info sent by the kid page. */
export function cleanDevice(raw: unknown): MessageContext['device'] | undefined {
  const d = (raw ?? {}) as Record<string, unknown>;
  const out: NonNullable<MessageContext['device']> = {
    network: str(d.network, 20),
    effectiveType: str(d.effectiveType, 10),
    battery: num(d.battery, 0, 100),
    charging: typeof d.charging === 'boolean' ? d.charging : undefined,
    timezone: str(d.timezone, 50),
    language: str(d.language, 20),
    platform: str(d.platform, 40),
    userAgent: str(d.userAgent, 300),
  };
  const kept = Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined && v !== ''));
  return Object.keys(kept).length ? kept : undefined;
}

/** What Cloudflare tells us about the connection: IP, ISP and an approximate (city-level) place. */
export function connectionContext(req: Request): MessageContext {
  const cf = (req as Request & { cf?: IncomingRequestCfProperties }).cf;
  const ip = req.headers.get('cf-connecting-ip') ?? undefined;
  const lat = cf?.latitude ? Number(cf.latitude) : undefined;
  const lon = cf?.longitude ? Number(cf.longitude) : undefined;
  const ipLocation = cf
    ? { city: cf.city, region: cf.region, country: cf.country as string | undefined, lat, lon }
    : undefined;
  return {
    ip,
    isp: cf?.asOrganization ? `${cf.asOrganization}${cf.asn ? ` (AS${cf.asn})` : ''}` : undefined,
    ipLocation: ipLocation && Object.values(ipLocation).some(Boolean) ? ipLocation : undefined,
  };
}

/** "1.2.3.4" → "4.3.2.1.in-addr.arpa"; IPv6 → nibble format. */
export function reverseName(ip: string): string | null {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return `${ip.split('.').reverse().join('.')}.in-addr.arpa`;
  if (!ip.includes(':')) return null;
  const [head = '', tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  const hex = groups.map((g) => g.padStart(4, '0')).join('');
  return `${[...hex].reverse().join('.')}.ip6.arpa`;
}

/** The IP's hostname (PTR record), via DNS-over-HTTPS. Often names the ISP or the network. */
export async function reverseDns(ip: string): Promise<string | undefined> {
  const name = reverseName(ip);
  if (!name) return undefined;
  const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${name}&type=PTR`, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(3000),
  });
  const data = (await res.json()) as { Answer?: { type: number; data: string }[] };
  return data.Answer?.find((a) => a.type === 12)?.data.replace(/\.$/, '');
}

/** A short street address for a GPS fix, from OpenStreetMap. */
export async function reverseGeocode(lat: number, lon: number): Promise<string | undefined> {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=${lat}&lon=${lon}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(3800) });
  if (!res.ok) return undefined;
  const d = (await res.json()) as { name?: string; display_name?: string; address?: Record<string, string> };
  const a = d.address ?? {};
  const street = [a.house_number, a.road].filter(Boolean).join(' ');
  const area = a.neighbourhood || a.suburb || a.quarter || a.city_district;
  const city = a.city || a.town || a.village || a.state;
  const parts = [...new Set([d.name, street, area, city].filter((x): x is string => !!x))];
  return parts.length ? parts.join(', ') : d.display_name?.split(',').slice(0, 3).join(',');
}

const distance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const k = Math.cos((lat1 * Math.PI) / 180) * 111_320;
  return Math.hypot((lat2 - lat1) * 110_540, (lon2 - lon1) * k);
};

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

/** Named landmarks within ~200 m (parks, stations, shops, schools, buildings), nearest first. */
export async function nearbyPlaces(lat: number, lon: number, limit = 5): Promise<string[]> {
  const around = `(around:200,${lat},${lon})`;
  const q = `[out:json][timeout:8];(${[
    '["leisure"~"park|playground|sports_centre|stadium"]',
    '["amenity"]',
    '["shop"]',
    '["railway"="station"]',
    '["public_transport"="station"]',
    '["building"]',
    '["tourism"]',
  ]
    .map((f) => `nwr${around}["name"]${f};`)
    .join('')});out tags center 60;`;
  // The public servers are often busy: try a second one if the first fails.
  let res: Response | undefined;
  for (const server of OVERPASS) {
    res = await fetch(server, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(q)}`,
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
    if (res?.ok) break;
  }
  if (!res?.ok) return [];
  const data = (await res.json()) as {
    elements: {
      lat?: number;
      lon?: number;
      center?: { lat: number; lon: number };
      tags?: Record<string, string>;
    }[];
  };
  const seen = new Set<string>();
  return data.elements
    .map((e) => {
      const p = e.center ?? (e.lat !== undefined ? { lat: e.lat, lon: e.lon! } : null);
      const t = e.tags ?? {};
      const kind =
        t.leisure || t.amenity || t.shop || (t.railway || t.public_transport ? 'station' : t.tourism);
      return {
        name: kind && kind !== 'yes' ? `${t.name} (${kind.replace(/_/g, ' ')})` : t.name!,
        d: p ? distance(lat, lon, p.lat, p.lon) : 999,
      };
    })
    .sort((a, b) => a.d - b.d)
    .filter((x) => x.name && !seen.has(x.name) && seen.add(x.name))
    .slice(0, limit)
    .map((x) => x.name);
}

const settle = <T>(p: Promise<T>) => p.catch(() => undefined);

/** Fill in the hostname, street address and nearby landmarks. Lookups run in parallel and may fail. */
export async function enrichContext(ctx: MessageContext): Promise<MessageContext> {
  const [hostname, place, nearby] = await Promise.all([
    ctx.ip && !ctx.hostname ? settle(reverseDns(ctx.ip)) : undefined,
    ctx.gps ? settle(reverseGeocode(ctx.gps.lat, ctx.gps.lon)) : undefined,
    ctx.gps ? settle(nearbyPlaces(ctx.gps.lat, ctx.gps.lon)) : undefined,
  ]);
  return {
    ...ctx,
    ...(hostname && { hostname }),
    ...(place && { place }),
    ...(nearby?.length && { nearby }),
  };
}

/** Add lookups that finished late to the stored context, unless the GPS fix changed meanwhile. */
export function mergeLate(stored: MessageContext, full: MessageContext): MessageContext {
  const sameFix = stored.gps?.lat === full.gps?.lat && stored.gps?.lon === full.gps?.lon;
  return {
    ...stored,
    hostname: stored.hostname ?? full.hostname,
    ...(sameFix && { place: stored.place ?? full.place, nearby: stored.nearby ?? full.nearby }),
  };
}

export const mapLink = (lat: number, lon: number) => `https://maps.google.com/?q=${lat},${lon}`;

/** One short line for the call, SMS and the AI: "near Bishan Park, Bishan (GPS ±20 m)". */
export function whereText(ctx: MessageContext | null): string {
  if (!ctx) return '';
  if (ctx.gps) {
    const acc = ctx.gps.accuracy ? ` (GPS ±${ctx.gps.accuracy} m)` : ' (GPS)';
    return `${ctx.place ? `near ${ctx.place}` : `at ${ctx.gps.lat}, ${ctx.gps.lon}`}${acc}`;
  }
  const l = ctx.ipLocation;
  const city = [l?.city, l?.country].filter(Boolean).join(', ');
  return city ? `somewhere around ${city} (from the internet connection, not exact)` : '';
}

/** Plain-text block for emails. */
export function contextLines(ctx: MessageContext | null): string[] {
  if (!ctx) return [];
  const d = ctx.device ?? {};
  const lines = [
    whereText(ctx) && `Where: ${whereText(ctx)}`,
    ctx.gps && `Map: ${mapLink(ctx.gps.lat, ctx.gps.lon)}`,
    ctx.nearby?.length && `Nearby: ${ctx.nearby.join(', ')}`,
    ctx.ip &&
      `Connection: ${[ctx.ip, ctx.hostname, ctx.isp].filter(Boolean).join(' · ')}${d.network ? ` · ${d.network}` : ''}`,
    d.battery !== undefined && `Battery: ${d.battery}%${d.charging ? ' (charging)' : ''}`,
  ];
  return lines.filter((x): x is string => !!x);
}
