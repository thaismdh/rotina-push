import { buildPushPayload } from '@block65/webcrypto-web-push';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function toMin(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function toHHMM(mins) {
  mins = ((mins % 1440) + 1440) % 1440;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

// Only the instant (vitamin/medication) items need push reminders.
// dow: 0=Sunday ... 5=Friday ... per JS Date#getDay()
function computeVitaminSchedule(cfg, dow) {
  const breakfast = toMin(cfg.mealBreakfast);
  const lunch = toMin(cfg.mealLunch);
  const dinner = toMin(cfg.mealDinner);
  const dur = cfg.mealDuration;

  const items = [
    { key: 'syntroid', title: 'Syntroid', start: breakfast - cfg.syntroidBefore },
    { key: 'natifa_omega', title: 'Natifa Pro + Ômega 3', start: breakfast },
    { key: 'subtramina', title: 'Subtramina', start: lunch - cfg.subBefore },
    { key: 'calde_max', title: 'Calde Max', start: lunch + dur },
    { key: 'fisiogen_lunch', title: 'Fisiogen', start: lunch + dur + 30 },
    { key: 'fisiogen_dinner', title: 'Fisiogen', start: dinner + dur + 30 },
  ];
  if (dow === 5) {
    items.push({ key: 'vitamina_d', title: 'Vitamina D', start: lunch });
  }
  return items;
}

// Brazil (São Paulo) has used a fixed UTC-3 offset with no DST since 2019.
function brazilNow() {
  const now = new Date();
  const shifted = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return {
    dow: shifted.getUTCDay(),
    nowMin: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    dateKey: shifted.toISOString().slice(0, 10),
  };
}

async function handleScheduled(env) {
  const subRaw = await env.ROTINA_KV.get('subscription');
  const cfgRaw = await env.ROTINA_KV.get('config');
  if (!subRaw || !cfgRaw) return;

  const subscription = JSON.parse(subRaw);
  const cfg = JSON.parse(cfgRaw);
  const { dow, nowMin, dateKey } = brazilNow();

  const items = computeVitaminSchedule(cfg, dow);

  const doneRaw = await env.ROTINA_KV.get('done:' + dateKey);
  const done = doneRaw ? JSON.parse(doneRaw) : {};
  const notifiedRaw = await env.ROTINA_KV.get('notified:' + dateKey);
  const notified = notifiedRaw ? JSON.parse(notifiedRaw) : {};

  let changed = false;

  for (const item of items) {
    const start = ((item.start % 1440) + 1440) % 1440;
    if (!done[item.key] && nowMin >= start && !notified[item.key]) {
      notified[item.key] = true;
      changed = true;
      try {
        const vapid = {
          subject: env.VAPID_SUBJECT,
          publicKey: env.VAPID_PUBLIC_KEY,
          privateKey: env.VAPID_PRIVATE_KEY,
        };
        const message = {
          data: JSON.stringify({
            title: '💊 Hora do remédio',
            body: `${item.title} · ${toHHMM(item.start)}`,
          }),
          options: { ttl: 3600 },
        };
        const payload = await buildPushPayload(message, subscription, vapid);
        await fetch(subscription.endpoint, payload);
      } catch (err) {
        // Subscription may have expired or the push service rejected it; ignore and continue.
      }
    }
  }

  if (changed) {
    await env.ROTINA_KV.put('notified:' + dateKey, JSON.stringify(notified));
  }
}

async function handleFetch(request, env) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (request.method === 'GET' && url.pathname === '/') {
    return json({ ok: true, service: 'rotina-push' });
  }

  if (request.method === 'POST' && url.pathname === '/subscribe') {
    const body = await request.json();
    if (!body || !body.subscription) return json({ error: 'missing subscription' }, 400);
    await env.ROTINA_KV.put('subscription', JSON.stringify(body.subscription));
    return json({ ok: true });
  }

  if (request.method === 'POST' && url.pathname === '/config') {
    const body = await request.json();
    if (!body || !body.config) return json({ error: 'missing config' }, 400);
    await env.ROTINA_KV.put('config', JSON.stringify(body.config));
    return json({ ok: true });
  }

  if (request.method === 'POST' && url.pathname === '/done') {
    const body = await request.json();
    if (!body || !body.date || !body.key) return json({ error: 'missing fields' }, 400);
    const raw = await env.ROTINA_KV.get('done:' + body.date);
    const doneMap = raw ? JSON.parse(raw) : {};
    doneMap[body.key] = !!body.done;
    await env.ROTINA_KV.put('done:' + body.date, JSON.stringify(doneMap));
    return json({ ok: true });
  }

  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(request, env) {
    try {
      return await handleFetch(request, env);
    } catch (err) {
      return json({ error: String(err && err.message ? err.message : err) }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  },
};
