const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(code => code.includes('const firebaseConfig'));

function page() {
  const elements = new Map();
  function element() {
    const classes = new Set();
    return {
      textContent: '', innerHTML: '', value: '', disabled: false, style: {}, children: [],
      classList: {
        add: name => classes.add(name),
        remove: name => classes.delete(name),
        contains: name => classes.has(name),
        toggle(name, enabled) {
          if (enabled) classes.add(name);
          else classes.delete(name);
        },
      },
      append(...items) { this.children.push(...items); },
      appendChild(item) { this.children.push(item); },
      prepend(item) { this.children.unshift(item); },
    };
  }
  const get = id => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  get('thresholdSlider').value = '3255';
  let interval;
  let qr;
  const sandbox = {
    URL, URLSearchParams,
    document: {
      getElementById: get,
      createElement: element,
      querySelectorAll: () => [],
    },
    window: {
      location: {
        href: 'https://wiqaya.example/?mode=nurse#private-fragment', search: '',
      },
      addEventListener: () => {},
    },
    firebase: { initializeApp() { throw new Error('Placeholder settings must not initialize Firebase'); } },
    setTimeout() { throw new Error('No unconfirmed success redirect is allowed'); },
    setInterval(callback) { interval = callback; return 1; },
    clearInterval() { interval = undefined; },
    QRCode: function (target, options) { qr = options.text; },
  };
  Object.defineProperty(sandbox, 'localStorage', {
    get() { throw new Error('Patient storage must not use browser local storage'); },
  });
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context);
  return {
    get,
    run: code => vm.runInContext(code, context),
    tick: () => interval(),
    qr: () => qr,
    rejectDatabaseWrites() {
      let attempts = 0;
      sandbox.rejectedDatabase = {
        ref: () => ({ set: async () => { attempts++; throw new Error('Permission denied'); } }),
      };
      vm.runInContext('db = rejectedDatabase; firebaseReady = true; firebaseConnected = true;', context);
      return () => attempts;
    },
  };
}

test('placeholder configuration remains offline without browser storage', () => {
  const p = page();
  assert.equal(p.run('firebaseReady'), false);
  assert.equal(p.run('firebaseConnected'), false);
  assert.equal(p.get('fbDot').classList.contains('online'), false);
  assert.match(p.get('fbStatusText').textContent, /غير مكتملة/);
});

test('registration without a configured connection reports failure and never redirects', async () => {
  const p = page();
  await p.run('savePatientData({ preventDefault() {} })');
  assert.match(p.get('formFeedback').textContent, /لم يتم التسجيل/);
  assert.equal(p.get('dispPatientName').textContent, '');
  assert.equal(p.get('savePatientBtn').disabled, false);
});

test('rejected registration never updates the displayed patient or claims success', async () => {
  const p = page();
  const attempts = p.rejectDatabaseWrites();
  await p.run('savePatientData({ preventDefault() {} })');
  assert.equal(attempts(), 1);
  assert.match(p.get('formFeedback').textContent, /تعذّر تأكيد حفظ/);
  assert.equal(p.get('dispPatientName').textContent, '');
});

test('offline controls do not change the confirmed display state', async () => {
  const p = page();
  p.get('thresholdSlider').value = '2000';
  await p.run('toggleMute()');
  await p.run('applyThreshold()');
  assert.equal(p.run('isMuted'), false);
  assert.equal(p.run('currentThreshold'), 3255);
});

test('rejected commands retain the previous mute and threshold state', async () => {
  const p = page();
  const attempts = p.rejectDatabaseWrites();
  p.get('thresholdSlider').value = '2000';
  await p.run('toggleMute()');
  await p.run('applyThreshold()');
  assert.equal(attempts(), 2);
  assert.equal(p.run('isMuted'), false);
  assert.equal(p.run('currentThreshold'), 3255);
  assert.equal(p.get('muteBtn').disabled, false);
});

test('missing, incomplete, sparse, or invalid readings cannot display a safe assessment', () => {
  const p = page();
  for (const values of ['null', '[]', 'Array(16)', 'Array(16).fill("0")', 'Array(16).fill(5000)']) {
    p.run(`renderSensors(${values})`);
    assert.equal(p.get('kpiRisk').textContent, 'غير متاح');
    assert.equal(p.get('clinicalAlertBar').classList.contains('safe'), false);
    assert.equal(p.get('clinicalAlertBar').classList.contains('unknown'), true);
  }
});

test('simulation is visibly labelled, blocks hardware commands, and clears on exit', async () => {
  const p = page();
  const attempts = p.rejectDatabaseWrites();
  p.run('toggleSimulation()');
  p.tick();
  assert.equal(p.get('simulationNotice').style.display, 'block');
  assert.match(p.get('kpiHw').textContent, /محاكاة/);
  await p.run('toggleMute()');
  await p.run('applyThreshold()');
  assert.equal(attempts(), 0);
  p.run('toggleSimulation()');
  assert.equal(p.get('simulationNotice').style.display, 'none');
  assert.equal(p.get('kpiTemp').textContent, '--');
  assert.equal(p.get('kpiRisk').textContent, 'غير متاح');
});

test('bed QR retains its room and bed and omits the current fragment and query', () => {
  const p = page();
  p.get('qrRoom').value = '220';
  p.get('qrBed').value = '1';
  p.run('generateBedQR()');
  const url = new URL(p.qr());
  assert.equal(url.searchParams.get('mode'), 'patient');
  assert.equal(url.searchParams.get('room'), '220');
  assert.equal(url.searchParams.get('bed'), '1');
  assert.equal(url.hash, '');
});

test('event messages are inserted as text rather than executable markup', () => {
  const p = page();
  p.run('addLog("<strong>message</strong>")');
  const message = p.get('eventLog').children[0].children[0];
  assert.equal(message.textContent, '<strong>message</strong>');
  assert.equal(message.innerHTML, '');
});
