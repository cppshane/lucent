import { 
  geolocateFromText, 
  applyJitter 
} from './geolocation';

export interface Env {
  PINGDOM_API_KEY?: string;
  PINGDOM_API_TOKEN?: string;
  STATUSGATOR_API_KEY?: string;
  STATUSGATOR_API_TOKEN?: string;
  ASSETS?: {
    fetch: (request: Request) => Promise<Response>;
  };
}

function resolveMonitoringCredentials(env: Env): {
  pingdom?: string;
  statusGator?: string;
} {
  return {
    pingdom: env.PINGDOM_API_KEY?.trim() || env.PINGDOM_API_TOKEN?.trim() || undefined,
    statusGator:
      env.STATUSGATOR_API_KEY?.trim() || env.STATUSGATOR_API_TOKEN?.trim() || undefined,
  };
}

export interface OutageDto {
  id: string;
  title: string;
  description: string;
  link: string;
  thumbnail: string;
  latencyMs: number;
  latitude: number;
  longitude: number;
  uncertaintyKm?: number | null;
  platform: string;
  status: 'down' | 'degraded' | 'up';
  service: string;
  timestamp: number;
}

const MOCK_SERVICES = [
  { id: 'github', name: 'GitHub', service: 'github', baseLat: 37.7749, baseLng: -122.4194, link: 'https://www.githubstatus.com', logo: 'github' },
  { id: 'slack', name: 'Slack', service: 'slack', baseLat: 51.5074, baseLng: -0.1278, link: 'https://status.slack.com', logo: 'slack' },
  { id: 'aws-us-east', name: 'AWS us-east-1', service: 'aws', baseLat: 38.0336, baseLng: -78.5080, link: 'https://health.aws.amazon.com', logo: 'amazonaws' },
  { id: 'aws-eu-west', name: 'AWS eu-west-1', service: 'aws', baseLat: 53.3498, baseLng: -6.2603, link: 'https://health.aws.amazon.com', logo: 'amazonaws' },
  { id: 'aws-ap-ne', name: 'AWS ap-northeast-1', service: 'aws', baseLat: 35.6762, baseLng: 139.6503, link: 'https://health.aws.amazon.com', logo: 'amazonaws' },
  { id: 'cloudflare-frankfurt', name: 'Cloudflare (FRA)', service: 'cloudflare', baseLat: 50.1109, baseLng: 8.6821, link: 'https://www.cloudflarestatus.com', logo: 'cloudflare' },
  { id: 'cloudflare-tokyo', name: 'Cloudflare (NRT)', service: 'cloudflare', baseLat: 35.7720, baseLng: 140.3929, link: 'https://www.cloudflarestatus.com', logo: 'cloudflare' },
  { id: 'openai', name: 'OpenAI API', service: 'openai', baseLat: 37.7624, baseLng: -122.4348, link: 'https://status.openai.com', logo: 'openai' },
  { id: 'zoom', name: 'Zoom Video', service: 'zoom', baseLat: 39.7392, baseLng: -104.9903, link: 'https://status.zoom.us', logo: 'zoom' },
  { id: 'vercel', name: 'Vercel Edge', service: 'vercel', baseLat: 52.5200, baseLng: 13.4050, link: 'https://www.vercel-status.com', logo: 'vercel' },
  { id: 'heroku', name: 'Heroku Cloud', service: 'heroku', baseLat: 44.0521, baseLng: -123.0868, link: 'https://status.heroku.com', logo: 'heroku' }
];

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = request.headers.get('Origin') || '*';

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const url = new URL(request.url);

    // API Routing
    if (url.pathname === '/api/outages') {
      const simulateParam = url.searchParams.get('simulate') || 'none';
      const response = await handleGetOutages(env, simulateParam);
      return addCorsHeaders(response, origin);
    }

    // Serve static assets
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  },
};

function addCorsHeaders(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  headers.set('Access-Control-Expose-Headers', 'X-sYntinel-Mode, X-sYntinel-Provider');
  
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function handleGetOutages(env: Env, simulateParam: string): Promise<Response> {
  let outages: OutageDto[] = [];
  let fetchSuccessful = false;
  const credentials = resolveMonitoringCredentials(env);

  // Check if real API integrations are configured
  if (credentials.pingdom) {
    try {
      outages = await fetchPingdomOutages(credentials.pingdom);
      fetchSuccessful = true;
    } catch (err) {
      console.error('Failed to fetch Pingdom outages, falling back:', err);
    }
  } else if (credentials.statusGator) {
    try {
      outages = await fetchStatusGatorOutages(credentials.statusGator);
      fetchSuccessful = true;
    } catch (err) {
      console.error('Failed to fetch StatusGator outages, falling back:', err);
    }
  }

  const hasKeys = !!(credentials.pingdom || credentials.statusGator);
  const isSimulation = !hasKeys || simulateParam !== 'none' || !fetchSuccessful;

  if (isSimulation) {
    outages = generateSimulatedOutages(simulateParam);
  }

  const activeMode = isSimulation ? 'simulated' : 'live';
  const activeProvider = isSimulation 
    ? 'simulated' 
    : (credentials.pingdom ? 'pingdom' : 'statusgator');

  return new Response(JSON.stringify(outages), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=10',
      'X-sYntinel-Mode': activeMode,
      'X-sYntinel-Provider': activeProvider
    },
  });
}

async function fetchPingdomOutages(apiKey: string): Promise<OutageDto[]> {
  const url = 'https://api.pingdom.com/api/3.1/checks';
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${apiKey}`
    }
  });

  if (!res.ok) {
    throw new Error(`Pingdom returned HTTP ${res.status}`);
  }

  const data = (await res.json()) as any;
  const checks = data.checks || [];
  const outages: OutageDto[] = [];

  for (const check of checks) {
    // Pingdom statuses: up, down, unconfirmed, paused, unknown
    if (check.status === 'paused') {
      continue;
    }

    const name = check.name || 'Unknown Site';
    let loc = geolocateFromText(name);
    
    // Default to Middle of Atlantic / Equator if geolocation fails, apply jitter
    if (!loc) {
      loc = applyJitter(37.0902, -95.7129, 1000); // US central fallback
    } else {
      loc = applyJitter(loc.latitude, loc.longitude, 20);
    }

    const logo = getLogoForName(name);
    const isDown = check.status === 'down';
    const isDegraded = check.status === 'unconfirmed';
    const status: 'down' | 'degraded' | 'up' = isDown ? 'down' : isDegraded ? 'degraded' : 'up';
    const color = isDown ? 'EF4444' : isDegraded ? 'F59E0B' : '10B981';

    outages.push({
      id: `pingdom-${check.id}`,
      title: name,
      description: status === 'up'
        ? 'System operational. All health checks passing.'
        : `Pingdom check reported ${check.status.toUpperCase()}. Target: ${check.hostname || 'N/A'}.`,
      link: `https://my.pingdom.com/`,
      thumbnail: getThumbnailUrl(logo, color),
      latencyMs: check.lastresponsetime || (isDown ? 5000 : isDegraded ? 800 : 75),
      latitude: loc.latitude,
      longitude: loc.longitude,
      uncertaintyKm: loc.uncertaintyKm,
      platform: 'pingdom',
      status: status,
      service: logo,
      timestamp: check.laststatuschangetime ? check.laststatuschangetime * 1000 : Date.now()
    });
  }

  return outages;
}

async function fetchStatusGatorOutages(apiKey: string): Promise<OutageDto[]> {
  const baseUrl = 'https://statusgator.com/api/v3';
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Accept': 'application/json'
  };

  // 1. Fetch organization boards (StatusGator v3 scopes monitors to boards)
  const boardsRes = await fetch(`${baseUrl}/boards`, { headers });
  if (!boardsRes.ok) {
    throw new Error(`StatusGator boards API returned HTTP ${boardsRes.status}`);
  }

  const boardsData = (await boardsRes.json()) as any;
  const boards: any[] = Array.isArray(boardsData?.data) ? boardsData.data : [];

  // 2. Fetch monitors across all boards in parallel
  const monitorRequests = boards.map(async (board: any) => {
    try {
      const res = await fetch(`${baseUrl}/boards/${encodeURIComponent(board.id)}/monitors`, { headers });
      if (!res.ok) {
        console.warn(`StatusGator monitors API for board ${board.id} returned HTTP ${res.status}`);
        return [];
      }
      const json = (await res.json()) as any;
      return Array.isArray(json?.data) ? json.data : [];
    } catch (err) {
      console.warn(`Failed to fetch StatusGator monitors for board ${board.id}:`, err);
      return [];
    }
  });

  const monitorArrays = await Promise.all(monitorRequests);
  const rawMonitors = monitorArrays.flat();

  // Deduplicate monitors across boards
  const seenIds = new Set<string>();
  const monitors: any[] = [];
  for (const item of rawMonitors) {
    if (item && item.id && !seenIds.has(item.id)) {
      seenIds.add(item.id);
      monitors.push(item);
    }
  }

  const outages: OutageDto[] = [];

  for (const monitor of monitors) {
    const serviceName = monitor.display_name || monitor.name || monitor.attributes?.name || 'Service';
    const rawStatus = (
      monitor.filtered_status ||
      monitor.unfiltered_status ||
      monitor.attributes?.status ||
      'up'
    ).toLowerCase();

    // StatusGator statuses: 'up', 'down', 'warn', 'maintenance'
    const isDown = rawStatus === 'down';
    const isDegraded = rawStatus === 'warn' || rawStatus === 'maintenance';
    const status: 'down' | 'degraded' | 'up' = isDown ? 'down' : isDegraded ? 'degraded' : 'up';
    const color = isDown ? 'EF4444' : isDegraded ? 'F59E0B' : '10B981';
    const logo = getLogoForName(serviceName);

    // Geolocation: try name text parsing, then fallback to tech hub with jitter
    let loc = geolocateFromText(serviceName);
    if (!loc) {
      const baseLat = 37.7749;
      const baseLng = -122.4194;
      loc = applyJitter(baseLat, baseLng, 1200);
    } else {
      loc = applyJitter(loc.latitude, loc.longitude, 50);
    }

    const description =
      monitor.last_details ||
      monitor.last_message ||
      monitor.description ||
      monitor.attributes?.description ||
      (status === 'up'
        ? 'System operational. All health checks passing.'
        : `StatusGator monitor reported service as ${rawStatus.toUpperCase()}.`);

    const link =
      monitor.home_url ||
      monitor.url ||
      monitor.attributes?.home_url ||
      `https://statusgator.com`;
    const thumbnail = monitor.icon_url || getThumbnailUrl(logo, color);
    const latency = isDown ? 4500 : isDegraded ? 1200 : 75;
    const timestamp =
      Date.parse(
        monitor.updated_at ||
        monitor.checked_at ||
        monitor.attributes?.updated_at ||
        new Date().toISOString()
      ) || Date.now();

    outages.push({
      id: `statusgator-${monitor.id}`,
      title: serviceName,
      description,
      link,
      thumbnail,
      latencyMs: latency,
      latitude: loc.latitude,
      longitude: loc.longitude,
      uncertaintyKm: loc.uncertaintyKm ?? 200,
      platform: 'statusgator',
      status,
      service: logo,
      timestamp
    });
  }

  return outages;
}

function getLogoForName(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('github')) return 'github';
  if (n.includes('slack')) return 'slack';
  if (n.includes('aws') || n.includes('amazon')) return 'amazonaws';
  if (n.includes('cloudflare')) return 'cloudflare';
  if (n.includes('openai')) return 'openai';
  if (n.includes('zoom')) return 'zoom';
  if (n.includes('vercel')) return 'vercel';
  if (n.includes('heroku')) return 'heroku';
  if (n.includes('google')) return 'googlecloud';
  if (n.includes('microsoft') || n.includes('azure')) return 'microsoftazure';
  return 'statusgator'; // Fallback generic logo
}

function getThumbnailUrl(logoName: string, statusColor: string): string {
  const removedFromSimpleIcons = ['slack', 'amazonaws', 'aws', 'openai', 'heroku'];
  const name = logoName.toLowerCase();
  
  if (removedFromSimpleIcons.includes(name)) {
    const slug = name === 'amazonaws' ? 'aws' : name;
    return `https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons/${slug}/default.svg`;
  }
  
  return `https://cdn.simpleicons.org/${logoName}/${statusColor}`;
}

function generateSimulatedOutages(disaster: string): OutageDto[] {
  const list: OutageDto[] = [];
  const seed = Math.floor(Date.now() / 60000); // 1-minute seed rotation

  MOCK_SERVICES.forEach((item, index) => {
    let status: 'up' | 'degraded' | 'down' = 'up';
    let latency = 40 + Math.floor(((seed * (index + 3)) % 80)); // base low latency
    let desc = 'System operational. All health checks passing.';

    if (disaster === 'solar-flare') {
      status = 'down';
      latency = 5500 + Math.floor(((seed * (index + 1)) % 3000));
      desc = 'Solar storm magnetic interference. Global uplink carrier signal lost.';
    } else if (disaster === 'global-dns') {
      if (item.service === 'cloudflare' || item.service === 'aws') {
        status = 'down';
        latency = 4800 + Math.floor(((seed * (index + 2)) % 1500));
        desc = 'Recursive DNS queries timing out. Root nameservers unreachable.';
      } else {
        status = 'degraded';
        latency = 1200 + Math.floor(((seed * (index + 1)) % 800));
        desc = 'Connection degraded. Domain names resolving slowly via fallback gateways.';
      }
    } else if (disaster === 'aws-collapse') {
      if (item.service === 'aws' || item.service === 'vercel' || item.service === 'heroku' || item.service === 'slack') {
        const isAWS = item.service === 'aws';
        status = isAWS ? 'down' : 'degraded';
        latency = (isAWS ? 4200 : 2200) + Math.floor(((seed * (index + 4)) % 1000));
        desc = isAWS 
          ? 'EBS Storage Volume degraded performance. EC2 API unavailable.'
          : 'Degraded network connectivity. Downstream hosting provider AWS experiencing issues.';
      }
    } else {
      // Normal simulation mode: random shifting failures
      // Seed triggers dynamic outages every few minutes
      const triggerDown = (seed + index * 7) % 11 === 0;
      const triggerDegraded = (seed + index * 3) % 7 === 0;

      if (triggerDown) {
        status = 'down';
        latency = 3000 + Math.floor(((seed * 19) % 2500));
        desc = `Connection timeout: Server failed to respond within 3000ms. Tested from geo-probe.`;
      } else if (triggerDegraded) {
        status = 'degraded';
        latency = 600 + Math.floor(((seed * 13) % 900));
        desc = `Response times elevated: Server response is significantly slower than 200ms baseline.`;
      }
    }

    // Apply jitter to coordinates so overlapping hubs (e.g. SF) separate beautifully
    const jittered = applyJitter(item.baseLat, item.baseLng, 80);
    const color = status === 'down' ? 'EF4444' : status === 'degraded' ? 'F59E0B' : '10B981';

    list.push({
      id: `simulated-${item.id}`,
      title: item.name,
      description: desc,
      link: item.link,
      thumbnail: getThumbnailUrl(item.logo, color),
      latencyMs: latency,
      latitude: jittered.latitude,
      longitude: jittered.longitude,
      uncertaintyKm: 80,
      platform: 'simulated',
      status: status,
      service: item.service,
      timestamp: Date.now() - (seed % 10) * 1000 * 60
    });
  });

  return list;
}
