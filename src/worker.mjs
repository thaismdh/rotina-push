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

function brazilToday() {
  // Date object at UTC-midnight representing "today" in Brazil time, used
  // purely for date-math in the calendar resolver below.
  const now = new Date();
  const shifted = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
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

// ---------- Minimal ICS (iCalendar) parser + "today" resolver ----------
// Not a full RFC5545 implementation - covers the common cases found in
// personal Google Calendar exports: single events, all-day events, and
// DAILY/WEEKLY/MONTHLY/YEARLY recurrence with INTERVAL/BYDAY/UNTIL/COUNT.
// Also handles the common "edit just this one occurrence" case (a VEVENT
// with RECURRENCE-ID overriding a single instance of a recurring series).

function unfoldIcs(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

function parseIcsDate(value, params) {
  const isDateOnly = (params && params.VALUE === 'DATE') || /^\d{8}$/.test(value);
  const y = Number(value.slice(0, 4));
  const mo = Number(value.slice(4, 6)) - 1;
  const d = Number(value.slice(6, 8));
  if (isDateOnly) {
    return { date: new Date(Date.UTC(y, mo, d)), allDay: true };
  }
  const h = Number(value.slice(9, 11));
  const mi = Number(value.slice(11, 13));
  const isUtc = value.endsWith('Z');
  let dt;
  if (isUtc) {
    dt = new Date(Date.UTC(y, mo, d, h, mi) - 3 * 60 * 60 * 1000);
  } else {
    // Treat as already being in Brazil local time (covers TZID=America/Sao_Paulo
    // and floating times, which is the common case for a personal calendar).
    dt = new Date(Date.UTC(y, mo, d, h, mi));
  }
  return { date: dt, allDay: false, raw: dt };
}

function dateOnly(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function diffDays(a, b) {
  return Math.round((dateOnly(b) - dateOnly(a)) / 86400000);
}

function parsePropLine(line) {
  const colonIdx = line.indexOf(':');
  if (colonIdx === -1) return null;
  const left = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);
  const [name, ...paramParts] = left.split(';');
  const params = {};
  for (const p of paramParts) {
    const [k, v] = p.split('=');
    if (k) params[k] = v;
  }
  return { name, params, value };
}

function parseRRuleString(value) {
  const rule = {};
  for (const part of value.split(';')) {
    const [k, v] = part.split('=');
    if (k) rule[k] = v;
  }
  return rule;
}

const ICS_DAY_TO_JS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseIcs(text) {
  const lines = unfoldIcs(text).split('\n').map((l) => l.trim()).filter(Boolean);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      cur = { exdates: [] };
      continue;
    }
    if (line === 'END:VEVENT') {
      if (cur) events.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const prop = parsePropLine(line);
    if (!prop) continue;
    if (prop.name === 'UID') cur.uid = prop.value;
    else if (prop.name === 'SUMMARY') cur.summary = prop.value.replace(/\\,/g, ',').replace(/\\n/gi, ' ');
    else if (prop.name === 'DTSTART') cur.dtstart = parseIcsDate(prop.value, prop.params);
    else if (prop.name === 'DTEND') cur.dtend = parseIcsDate(prop.value, prop.params);
    else if (prop.name === 'RRULE') cur.rrule = parseRRuleString(prop.value);
    else if (prop.name === 'RECURRENCE-ID') cur.recurrenceId = parseIcsDate(prop.value, prop.params);
    else if (prop.name === 'EXDATE') {
      for (const v of prop.value.split(',')) {
        const parsed = parseIcsDate(v, prop.params);
        cur.exdates.push(dateOnly(parsed.date).getTime());
      }
    }
  }
  return events;
}

function ruleMatchesDateNoCount(rrule, start, target) {
  const rruleNoCount = { ...rrule };
  delete rruleNoCount.COUNT;
  return ruleMatchesDate(rruleNoCount, start, target);
}

function ruleMatchesDate(rrule, dtstartDate, targetDate) {
  const freq = rrule.FREQ;
  const interval = parseInt(rrule.INTERVAL || '1', 10) || 1;
  const start = dateOnly(dtstartDate);
  const target = dateOnly(targetDate);
  if (target < start) return false;

  if (rrule.UNTIL) {
    const untilParsed = parseIcsDate(rrule.UNTIL, {});
    if (target > dateOnly(untilParsed.date)) return false;
  }

  const dayDiff = diffDays(start, target);

  if (freq === 'DAILY') {
    if (dayDiff % interval !== 0) return false;
  } else if (freq === 'WEEKLY') {
    const startWeekMon = new Date(start);
    const startDow = (start.getUTCDay() + 6) % 7;
    startWeekMon.setUTCDate(startWeekMon.getUTCDate() - startDow);
    const targetWeekMon = new Date(target);
    const targetDow = (target.getUTCDay() + 6) % 7;
    targetWeekMon.setUTCDate(targetWeekMon.getUTCDate() - targetDow);
    const weekDiff = Math.round((targetWeekMon - startWeekMon) / (7 * 86400000));
    if (weekDiff < 0 || weekDiff % interval !== 0) return false;
    if (rrule.BYDAY) {
      const days = rrule.BYDAY.split(',').map((d) => ICS_DAY_TO_JS[d.slice(-2)]);
      if (!days.includes(target.getUTCDay())) return false;
    } else if (target.getUTCDay() !== start.getUTCDay()) {
      return false;
    }
  } else if (freq === 'MONTHLY') {
    if (target.getUTCDate() !== start.getUTCDate()) return false;
    const monthDiff = (target.getUTCFullYear() - start.getUTCFullYear()) * 12 + (target.getUTCMonth() - start.getUTCMonth());
    if (monthDiff < 0 || monthDiff % interval !== 0) return false;
  } else if (freq === 'YEARLY') {
    if (target.getUTCDate() !== start.getUTCDate() || target.getUTCMonth() !== start.getUTCMonth()) return false;
    const yearDiff = target.getUTCFullYear() - start.getUTCFullYear();
    if (yearDiff < 0 || yearDiff % interval !== 0) return false;
  } else {
    return false;
  }

  if (rrule.COUNT) {
    const count = parseInt(rrule.COUNT, 10);
    let n = 0;
    let cursor = new Date(start);
    let guard = 0;
    while (cursor <= target && guard < 20000) {
      guard++;
      if (ruleMatchesDateNoCount(rrule, start, cursor)) {
        n++;
        if (dateOnly(cursor).getTime() === target.getTime()) {
          return n <= count;
        }
        if (n > count) return false;
      }
      cursor = new Date(cursor.getTime() + 86400000);
    }
    return n <= count;
  }

  return true;
}

function eventsOnDate(events, todayDate) {
  // Eventos recorrentes com UMA ocorrência editada individualmente (ex.: só o
  // compromisso de hoje mudou de título/duração no Google Calendar) aparecem
  // no ICS como duas entradas com o mesmo UID: a série original (com RRULE,
  // sem EXDATE pra esse dia — o Google só usa EXDATE quando a ocorrência é
  // excluída, não quando é só editada) e uma segunda entrada "override" com
  // RECURRENCE-ID apontando pra data da ocorrência original, carregando os
  // dados novos (outro horário/título). Sem tratar isso, a série original
  // "ressuscitava" nesse dia com os dados antigos, escondendo a edição feita
  // no Google Calendar (foi exatamente o bug visto com o evento de estudo).
  const maskedByUid = new Map(); // uid -> Set(timestamp do dia da ocorrência original substituída)
  events.forEach((ev) => {
    if (ev.uid && ev.recurrenceId) {
      if (!maskedByUid.has(ev.uid)) maskedByUid.set(ev.uid, new Set());
      maskedByUid.get(ev.uid).add(dateOnly(ev.recurrenceId.date).getTime());
    }
  });

  const result = [];
  for (const ev of events) {
    if (!ev.dtstart) continue;
    if (ev.exdates.includes(dateOnly(todayDate).getTime())) continue;

    // Se esta é a ocorrência "mestre" (não é ela mesma o override) de uma série
    // que teve o dia de hoje editado separadamente, pula — quem representa hoje
    // é a entrada override (tratada como um evento normal, pelo seu próprio
    // dtstart, mais abaixo no mesmo loop).
    if (!ev.recurrenceId && ev.uid) {
      const masked = maskedByUid.get(ev.uid);
      if (masked && masked.has(dateOnly(todayDate).getTime())) continue;
    }

    let occurs = false;
    if (ev.rrule) {
      occurs = ruleMatchesDate(ev.rrule, ev.dtstart.date, todayDate);
    } else if (ev.dtstart.allDay) {
      const endDate = ev.dtend ? ev.dtend.date : new Date(ev.dtstart.date.getTime() + 86400000);
      occurs = todayDate >= dateOnly(ev.dtstart.date) && todayDate < dateOnly(endDate);
    } else {
      occurs = dateOnly(ev.dtstart.date).getTime() === dateOnly(todayDate).getTime();
    }
    if (!occurs) continue;

    result.push({
      title: ev.summary || '(sem título)',
      allDay: !!ev.dtstart.allDay,
      start: ev.dtstart.allDay ? null : `${String(ev.dtstart.raw.getUTCHours()).padStart(2, '0')}:${String(ev.dtstart.raw.getUTCMinutes()).padStart(2, '0')}`,
      end: ev.dtend && !ev.dtend.allDay ? `${String(ev.dtend.raw.getUTCHours()).padStart(2, '0')}:${String(ev.dtend.raw.getUTCMinutes()).padStart(2, '0')}` : null,
    });
  }
  result.sort((a, b) => {
    if (a.allDay && !b.allDay) return -1;
    if (!a.allDay && b.allDay) return 1;
    return (a.start || '').localeCompare(b.start || '');
  });
  return result;
}

async function handleCalendarToday(env) {
  const cfgRaw = await env.ROTINA_KV.get('config');
  const cfg = cfgRaw ? JSON.parse(cfgRaw) : {};
  if (!cfg.calendarIcalUrl) return json({ events: [], configured: false });

  const resp = await fetch(cfg.calendarIcalUrl);
  if (!resp.ok) return json({ events: [], configured: true, error: 'fetch_failed' }, 502);
  const text = await resp.text();
  const events = parseIcs(text);
  const today = brazilToday();
  return json({ events: eventsOnDate(events, today), configured: true });
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
    const existingCfgRaw = await env.ROTINA_KV.get('config');
    const existingCfg = existingCfgRaw ? JSON.parse(existingCfgRaw) : {};
    const merged = { ...existingCfg, ...body.config };
    // Mesma proteção do /state: um aparelho com o campo vazio localmente não
    // pode apagar um link já configurado só porque a cópia dele está desatualizada.
    if (!body.config.calendarIcalUrl && existingCfg.calendarIcalUrl) {
      merged.calendarIcalUrl = existingCfg.calendarIcalUrl;
    }
    if (!body.config.pushServerUrl && existingCfg.pushServerUrl) {
      merged.pushServerUrl = existingCfg.pushServerUrl;
    }
    await env.ROTINA_KV.put('config', JSON.stringify(merged));
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

  if (request.method === 'GET' && url.pathname === '/calendar/today') {
    return handleCalendarToday(env);
  }

  if (request.method === 'GET' && url.pathname === '/state') {
    const raw = await env.ROTINA_KV.get('app_state');
    if (!raw) return json({ state: null, updatedAt: 0 });
    const parsed = JSON.parse(raw);
    return json({ state: parsed.state, updatedAt: parsed.updatedAt });
  }

  if (request.method === 'POST' && url.pathname === '/state') {
    const body = await request.json();
    if (!body || !body.state || typeof body.updatedAt !== 'number') {
      return json({ error: 'missing fields' }, 400);
    }
    const existingRaw = await env.ROTINA_KV.get('app_state');
    const existing = existingRaw ? JSON.parse(existingRaw) : null;
    if (existing && existing.updatedAt > body.updatedAt) {
      // Outro aparelho já salvou algo mais recente; devolve essa versão em vez
      // de sobrescrever, e deixa o cliente decidir adotar o que veio do servidor.
      return json({ ok: true, applied: false, state: existing.state, updatedAt: existing.updatedAt });
    }
    // Protege calendarIcalUrl/pushServerUrl no PRÓPRIO blob principal (app_state),
    // não só na cópia espelhada em 'config'. Um aparelho com esses dois campos
    // vazios localmente (ex.: PWA recém-reinstalado, que ainda não terminou de
    // puxar o estado real quando disparou esse push) não pode apagar um valor
    // já configurado por outro aparelho.
    const existingStateConfig = (existing && existing.state && existing.state.config) || {};
    if (body.state.config) {
      if (!body.state.config.calendarIcalUrl && existingStateConfig.calendarIcalUrl) {
        body.state.config.calendarIcalUrl = existingStateConfig.calendarIcalUrl;
      }
      if (!body.state.config.pushServerUrl && existingStateConfig.pushServerUrl) {
        body.state.config.pushServerUrl = existingStateConfig.pushServerUrl;
      }
    }
    await env.ROTINA_KV.put('app_state', JSON.stringify({ state: body.state, updatedAt: body.updatedAt }));
    // Mantém as chaves usadas pelo agendador de push em sincronia, sem mudar
    // o comportamento dele.
    if (body.state.config) {
      const existingCfgRaw = await env.ROTINA_KV.get('config');
      const existingCfg = existingCfgRaw ? JSON.parse(existingCfgRaw) : {};
      const merged = { ...existingCfg, ...body.state.config };
      // Um aparelho com dado desatualizado (ex.: uma aba antiga que nunca
      // recebeu o link mais recente) não pode apagar uma URL já configurada
      // só porque a cópia dele está vazia nesses dois campos sensíveis.
      if (!body.state.config.calendarIcalUrl && existingCfg.calendarIcalUrl) {
        merged.calendarIcalUrl = existingCfg.calendarIcalUrl;
      }
      if (!body.state.config.pushServerUrl && existingCfg.pushServerUrl) {
        merged.pushServerUrl = existingCfg.pushServerUrl;
      }
      await env.ROTINA_KV.put('config', JSON.stringify(merged));
    }
    if (body.state.history) {
      const { dateKey } = brazilNow();
      await env.ROTINA_KV.put('done:' + dateKey, JSON.stringify(body.state.history[dateKey] || {}));
    }
    return json({ ok: true, applied: true, state: body.state, updatedAt: body.updatedAt });
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
