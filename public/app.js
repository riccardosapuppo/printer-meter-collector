/**
 * The board.
 *
 * Plain JavaScript, no build step. The page reads one endpoint and draws it;
 * a framework here would be a dependency between somebody and a JSON document.
 *
 * The one thing worth reading is `gauge()`. Everything else on this page is a
 * list.
 */

const $ = (id) => document.getElementById(id);

let latest = null;

async function refresh() {
  try {
    const answer = await (await fetch('/api/devices')).json();
    latest = answer;
    draw(answer);
  } catch {
    $('whatItReads').textContent = 'the collector is not answering';
  }
}

fetch('/api/health')
  .then((response) => response.json())
  .then((health) => {
    $('whatItReads').textContent = `${health.devices} devices · ${health.readings} readings · ${health.reads}`;
  })
  .catch(() => {
    $('whatItReads').textContent = 'the collector is not answering';
  });

$('collectNow').addEventListener('click', async () => {
  const button = $('collectNow');
  button.disabled = true;
  button.textContent = 'Collecting…';

  const response = await fetch('/api/round', { method: 'POST' });
  const said = await response.json();

  button.disabled = false;
  button.textContent = 'Collect now';

  if (!response.ok) {
    $('summary').textContent = said.error;
    return;
  }

  $('summary').textContent = `${said.answered} of ${said.asked} answered in ${Math.round(said.tookMs / 1000)}s`;
  await refresh();
});

$('find').addEventListener('input', () => draw(latest));

// ---------------------------------------------------------------- drawing

function draw(answer) {
  if (!answer) return;

  const looking = $('find').value.trim().toLowerCase();
  const sites = $('sites');
  sites.textContent = '';

  let shown = 0;

  for (const site of answer.sites) {
    const devices = site.devices.filter((device) => matches(device, site.site, looking));
    if (devices.length === 0) continue;

    shown += devices.length;
    sites.append(drawSite(site, devices));
  }

  $('none').hidden = shown > 0;

  const needing = answer.sites.reduce((total, site) => total + site.needs, 0);
  const silent = answer.sites.reduce((total, site) => total + site.silent, 0);
  $('summary').textContent = `${needing} ${needing === 1 ? 'thing' : 'things'} to do · ${silent} not answering`;

  const strangers = answer.unidentified ?? [];
  $('unidentifiedCard').hidden = strangers.length === 0;
  $('unidentified').textContent = '';
  for (const one of strangers) {
    const row = document.createElement('li');
    row.textContent = `${one.host}:${one.port} — ${one.model ?? 'no model given'}`;
    $('unidentified').append(row);
  }
}

/** Searching the words somebody would actually type, including what it needs. */
function matches(device, site, looking) {
  if (!looking) return true;

  const words = [
    site,
    device.serial,
    device.name,
    device.model,
    device.host,
    ...device.needs.map((one) => one.what),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return words.includes(looking);
}

function drawSite(site, devices) {
  const section = document.createElement('section');
  section.className = 'site';
  section.dataset.site = site.site;

  const head = document.createElement('h2');
  head.innerHTML = `${site.site}<em>${devices.length} ${devices.length === 1 ? 'device' : 'devices'}</em>`;
  if (site.needs > 0) head.innerHTML += `<span class="needs">${site.needs} to do</span>`;
  if (site.silent > 0) head.innerHTML += `<span class="silent">${site.silent} not answering</span>`;
  section.append(head);

  for (const device of devices) section.append(drawDevice(device));
  return section;
}

function drawDevice(device) {
  const card = document.createElement('article');
  card.className = 'card device';
  card.dataset.serial = device.serial;
  card.dataset.reachable = String(device.reachable);

  const head = document.createElement('header');
  head.innerHTML = `
    <div>
      <p class="name">${escape(device.name ?? device.host)}</p>
      <p class="model">${escape(device.model ?? 'no model reported')} · <code>${escape(device.serial)}</code></p>
    </div>
    <p class="pages">${device.pages == null ? '—' : device.pages.toLocaleString('en-GB')}<em>${
      device.usage?.perDay != null ? `${device.usage.perDay.toLocaleString('en-GB')} a day` : 'pages'
    }</em></p>
  `;
  card.append(head);

  // What to do, first and in words. The numbers are underneath.
  if (device.needs.length > 0) {
    const todo = document.createElement('ul');
    todo.className = 'todo';
    for (const need of device.needs) {
      const row = document.createElement('li');
      row.dataset.urgent = String(need.urgent);
      row.innerHTML = `<strong>${escape(need.what)}</strong>${need.why ? `<span>${escape(need.why)}</span>` : ''}`;
      todo.append(row);
    }
    card.append(todo);
  }

  if (device.supplies.length > 0) {
    const supplies = document.createElement('div');
    supplies.className = 'supplies';
    for (const supply of device.supplies) supplies.append(gauge(supply));
    card.append(supplies);
  }

  if (device.trays.length > 0) {
    const trays = document.createElement('p');
    trays.className = 'trays';
    trays.textContent = device.trays
      .map((tray) => `${tray.description}: ${tray.sheets === null ? 'unknown' : `${tray.sheets} sheets`}`)
      .join(' · ');
    card.append(trays);
  }

  return card;
}

/**
 * One supply, drawn — and the reason this page exists.
 *
 * There are three states, not two, and the third is the one everybody leaves
 * out. A device that says it cannot measure its toner gets a **hatched** bar
 * and the word "unknown", never a bar at zero.
 *
 * Drawing it as empty is the whole failure this project is about: it is a
 * confident picture of something nobody knows, it looks exactly like a machine
 * about to stop, and it gets a cartridge ordered and an engineer sent for a
 * printer that is perfectly full. The honest answer is visibly different from
 * both a full bar and an empty one.
 */
function gauge(supply) {
  const wrap = document.createElement('div');
  wrap.className = 'gauge';
  wrap.dataset.supply = supply.description ?? supply.index;

  const known = supply.remaining !== null;
  const filling = supply.kind === 'filled';

  wrap.dataset.state = !known ? 'unknown' : supply.remaining <= 15 ? 'low' : supply.remaining <= 35 ? 'watch' : 'fine';

  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.dataset.unknown = String(!known);

  const fill = document.createElement('div');
  fill.className = 'fill';
  // A hatched bar is drawn full width: the hatching IS the value, and a
  // hatched bar at 40% would be a number nobody has.
  fill.style.width = known ? `${supply.remaining}%` : '100%';
  bar.append(fill);

  const label = document.createElement('p');
  label.className = 'what';
  label.textContent = supply.description ?? `supply ${supply.index}`;

  const value = document.createElement('p');
  value.className = 'value';

  if (!known) {
    value.textContent = 'unknown';
    value.title = supply.why ?? 'the device did not say';
  } else if (filling) {
    value.textContent = `${supply.percent}% full`;
  } else {
    value.textContent = `${supply.remaining}%`;
  }

  wrap.append(label, bar, value);

  if (supply.why) {
    const why = document.createElement('p');
    why.className = 'why';
    why.textContent = supply.why;
    wrap.append(why);
  }

  return wrap;
}

function escape(text) {
  return String(text ?? '').replace(
    /[&<>"']/g,
    (one) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[one]
  );
}

await refresh();

// The collector goes round on its own timer; this follows it rather than
// polling hard. Ten seconds is often enough to see a round land and rare
// enough not to be a load of its own.
setInterval(refresh, 10_000);
