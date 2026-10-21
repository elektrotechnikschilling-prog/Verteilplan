/* Bedienung der Web-App: Aufnahmebogen oeffnen, Daten und Verteiler bearbeiten, Plan ansehen und
   als PDF speichern. Gezeichnet wird mit plan.js (dasselbe wie am PC), der Bogen wird mit
   bogen-import.js umgesetzt. Alles laeuft im Browser; der aktuelle Plan liegt nur im Geraet. */
(function () {
  'use strict';
  const SPEICHER = 'verteilerplan.aktuell';
  const $ = s => document.querySelector(s);
  const KOPIE = o => JSON.parse(JSON.stringify(o));

  const TYP_NAMEN = [
    ['LS', 'LS – Leitungsschutz'], ['RCD', 'RCD – Fehlerstrom'], ['FILS', 'FI/LS'], ['AFDD', 'AFDD – Brandschutz'],
    ['SLS', 'SLS'], ['SI', 'Sicherung'], ['SPD', 'Überspannungsschutz'], ['HS', 'Hauptschalter'],
    ['SCHUETZ', 'Schütz'], ['STS', 'Stromstoßschalter'], ['UHR', 'Zeitschaltuhr'], ['TRAFO', 'Klingeltrafo'],
    ['ZAEHLER', 'Zwischenzähler'], ['SD', 'Steckdose'], ['SONST', 'Sonstiges'], ['LEER', 'Freier Platz']
  ];
  const WERTE = {
    LS: ['B6', 'B10', 'B13', 'B16', 'B20', 'B25', 'B32', 'C6', 'C10', 'C13', 'C16', 'C20', 'C25', 'C32', 'C40'],
    RCD: ['25 A / 30 mA', '40 A / 30 mA', '63 A / 30 mA', '40 A / 300 mA', '63 A / 300 mA']
  };
  const WERTLISTE = { LS: 'LS', FILS: 'LS', AFDD: 'LS', SLS: 'LS', RCD: 'RCD' };
  const POLE = { LS: ['1', '2', '3'], RCD: ['2', '4'], FILS: ['1+N', '3+N'], AFDD: ['1+N'], SLS: ['3'], SI: ['1', '3'], HS: ['3', '4'] };
  const ARTEN = ['Typ A', 'Typ F', 'Typ B', 'Typ AC'];
  const MIT_ART = new Set(['RCD', 'FILS']);

  let FIRMA = {}, LOGO = '';
  let plan = null;
  let ansicht = 'start';

  /* ---------- Hilfen ---------- */
  function h(tag, attrs, ...kinder) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kinder.flat(Infinity)) {
      if (k == null || k === false || k === '') continue;
      el.append(k.nodeType ? k : document.createTextNode(String(k)));
    }
    return el;
  }
  const zwei = n => String(n).padStart(2, '0');
  function heute() { const d = new Date(); return `${d.getFullYear()}-${zwei(d.getMonth() + 1)}-${zwei(d.getDate())}`; }
  const typVon = g => String(g.typ || 'SONST').toUpperCase();
  const teVon = g => Verteilerplan.teVon(g);
  const breite = () => Number(plan.te_pro_reihe) || 12;

  function speichern() { try { localStorage.setItem(SPEICHER, JSON.stringify(plan)); } catch (e) { /* privater Modus */ } }
  let speicherUhr = 0;
  function speichernSpaeter() { clearTimeout(speicherUhr); speicherUhr = setTimeout(speichern, 300); }
  function gesichert() { try { return JSON.parse(localStorage.getItem(SPEICHER) || 'null'); } catch (e) { return null; } }
  const hatInhalt = p => p && (p.kunde || p.adresse || (p.reihen || []).some(r => (r.geraete || []).length));

  function leererPlan() {
    return { kunde: '', adresse: '', verteiler: '', standort: '', netz: '', vorsicherung: '', datum: heute(),
      bearbeiter: '', bemerkung: '', te_pro_reihe: 12, reihen: [{ geraete: [] }], offen: [] };
  }
  function setze(obj, feld, wert) { if (wert === '' || wert == null) delete obj[feld]; else obj[feld] = wert; }
  function geraetVon(id) { const [r, g] = id.split('.').map(Number); return plan.reihen[r].geraete[g]; }

  function herunterladen(name, inhalt, typ) {
    const url = URL.createObjectURL(new Blob([inhalt], { type: typ }));
    const a = h('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  function dateiname(endung) {
    const teile = ['Verteilerplan', plan.kunde, plan.verteiler, plan.datum || heute()].filter(Boolean)
      .map(s => String(s).replace(/[^\wäöüÄÖÜß-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''));
    return teile.join('_') + (endung || '');
  }

  /* ---------- Ansichten ---------- */
  function zeige(neu) {
    if (neu !== 'start' && !plan) neu = 'start';
    ansicht = neu;
    for (const id of ['start', 'daten', 'verteiler', 'plan']) $('#ansicht-' + id).hidden = id !== neu;
    document.querySelectorAll('.schritte button').forEach(b => {
      b.classList.toggle('aktiv', b.dataset.ansicht === neu);
      b.disabled = !plan;
    });
    if (neu === 'start') zeichneStart();
    if (neu === 'daten') zeichneDaten();
    if (neu === 'verteiler') zeichneVerteiler();
    if (neu === 'plan') zeichnePlan();
    window.scrollTo(0, 0);
  }

  function fehler(text) {
    const el = $('#start-fehler');
    el.textContent = text || '';
    el.hidden = !text;
  }

  /* ---------- Start ---------- */
  function zeichneStart() {
    const alt = plan || gesichert();
    const weiter = document.querySelector('[data-aktion="weiter"]');
    weiter.hidden = !hatInhalt(alt);
    if (hatInhalt(alt)) $('#weiter-name').textContent = [alt.kunde, alt.verteiler].filter(Boolean).join(' – ') || 'Plan ohne Namen';
  }

  function neuBeginnen() {
    if (hatInhalt(plan) && !confirm('Der aktuelle Plan wird ersetzt. Weiter?')) return false;
    return true;
  }

  async function pdfFelder(datei) {
    const doc = await PDFLib.PDFDocument.load(new Uint8Array(await datei.arrayBuffer()), { ignoreEncryption: true, updateMetadata: false });
    const werte = {};
    let felder = [];
    try { felder = doc.getForm().getFields(); } catch (e) { felder = []; }
    for (const f of felder) {
      try {
        if (f instanceof PDFLib.PDFCheckBox) werte[f.getName()] = f.isChecked();
        else if (f instanceof PDFLib.PDFTextField) werte[f.getName()] = f.getText() || '';
      } catch (e) { /* einzelnes Feld unlesbar */ }
    }
    return werte;
  }

  async function bogenOeffnen(datei) {
    fehler('');
    try {
      if (!window.PDFLib) throw new Error('Die PDF-Funktion konnte nicht geladen werden. Bitte Internetverbindung prüfen und die Seite neu laden.');
      const werte = await pdfFelder(datei);
      const bekannt = Object.keys(werte).map(k => k.split('.').pop()).filter(k => /^[st]\d\d$|^craftnote_1_|^ls_standard$|^verteiler$/.test(k));
      if (!bekannt.length) throw new Error('In dieser PDF stecken keine Felder des Aufnahmebogens. Bitte den Aufnahmebogen aus Craftnote nehmen, ausfüllen und als PDF speichern.');
      const neu = BogenImport.zuPlan(werte);
      if (!neu.datum) neu.datum = heute();
      plan = neu;
      speichern();
      zeige('plan');
    } catch (e) {
      fehler(e && e.message ? e.message : String(e));
      zeige('start');
    }
  }

  async function jsonOeffnen(datei) {
    fehler('');
    try {
      const neu = JSON.parse(await datei.text());
      if (!neu || !Array.isArray(neu.reihen)) throw new Error('Das ist keine Plan-Datei.');
      plan = neu;
      speichern();
      zeige('plan');
    } catch (e) {
      fehler('Die Datei konnte nicht gelesen werden: ' + (e.message || e));
      zeige('start');
    }
  }

  /* ---------- 1 Daten ---------- */
  function zeichneDaten() {
    const el = $('#ansicht-daten');
    el.textContent = '';
    const feld = (label, key, extra = {}) => h('label', { class: 'feld' + (extra.breit ? ' breit' : '') },
      h('span', null, label),
      h('input', { value: plan[key] || '', 'data-kopf': key, type: extra.type || 'text', placeholder: extra.placeholder, autocomplete: 'off' }));

    const netz = h('div', { class: 'feld' }, h('span', null, 'Netzsystem'),
      h('div', { class: 'segment', role: 'group', 'aria-label': 'Netzsystem' },
        ['TN-C-S', 'TN-S', 'TT'].map(n => h('button', { type: 'button', 'data-netz': n, class: plan.netz === n ? 'an' : null, 'aria-pressed': plan.netz === n ? 'true' : 'false' }, n))));

    el.append(h('div', { class: 'karte' }, h('h2', null, 'Anlage'),
      h('div', { class: 'raster' },
        feld('Kunde', 'kunde'),
        feld('Anlagenadresse', 'adresse', { placeholder: 'Straße Nr., PLZ Ort' }),
        feld('Verteiler', 'verteiler', { placeholder: 'z. B. UV Erdgeschoss' }),
        feld('Standort', 'standort', { placeholder: 'z. B. Flur' }),
        netz,
        feld('Vorsicherung', 'vorsicherung', { placeholder: 'z. B. SLS E35 A' }),
        feld('Datum', 'datum', { type: 'date' }),
        feld('Erstellt von', 'bearbeiter'),
        feld('Bemerkung auf dem Plan (optional)', 'bemerkung', { breit: true }))));

    const offen = plan.offen || [];
    el.append(h('div', { class: 'karte' + (offen.length ? ' offen' : '') },
      h('h2', null, offen.length ? `Offene Punkte (${offen.length})` : 'Offene Punkte'),
      offen.length
        ? h('ul', { class: 'offen-liste' }, offen.map((p, i) => h('li', null, h('span', null, p),
            h('button', { type: 'button', class: 'knopf klein', 'data-offen-weg': i }, 'Erledigt'))))
        : h('p', { style: 'margin:0 0 12px;color:var(--a-grau)' }, 'Keine – der Plan ist kein Entwurf.'),
      h('div', { class: 'zeile2', style: 'display:flex;gap:8px' },
        h('input', { class: 'eingabe', id: 'offen-neu', placeholder: 'Punkt notieren, der noch zu klären ist' }),
        h('button', { type: 'button', class: 'knopf', 'data-aktion': 'offen-dazu' }, 'Dazu'))));

    if (plan.notizen) el.append(h('div', { class: 'karte' }, h('h2', null, 'Notizen vom Aufnahmebogen ', h('small', null, '(stehen nicht auf dem Plan)')),
      h('div', { class: 'notizen-box' }, plan.notizen)));

    el.append(h('div', { class: 'weiter' }, h('button', { type: 'button', class: 'knopf haupt', 'data-ziel': 'verteiler' }, 'Weiter zum Verteiler →')));
  }

  /* ---------- 2 Verteiler ---------- */
  function rcdAuswahl(attrs, wert, anzahl, ohneText) {
    const optionen = [['', ohneText], ['ohne', 'ohne RCD'], ['?', 'RCD unklar (?)']];
    for (let i = 1; i <= anzahl; i++) optionen.push([String(i), 'RCD ' + i]);
    const aktuell = wert == null ? '' : String(wert);
    return h('select', attrs, optionen.map(([w, t]) => h('option', { value: w, selected: w === aktuell }, t)));
  }

  function zeichneVerteiler() {
    const el = $('#ansicht-verteiler');
    el.textContent = '';
    if (!plan.reihen.length) plan.reihen.push({ geraete: [] });
    const rcdAnzahl = plan.reihen.reduce((n, r) => n + r.geraete.filter(g => typVon(g) === 'RCD').length, 0);
    plan.reihen.forEach((r, ri) => el.append(reiheKarte(r, ri, rcdAnzahl)));
    el.append(h('div', { class: 'weiter' },
      h('button', { type: 'button', class: 'knopf', 'data-aktion': 'reihe-neu' }, '+ Reihe'),
      h('button', { type: 'button', class: 'knopf haupt', 'data-ziel': 'plan' }, 'Plan ansehen →')));
  }

  function reiheKarte(r, ri, rcdAnzahl) {
    const start = ri * breite() + 1;
    const belegt = r.geraete.reduce((s, g) => s + teVon(g), 0);
    let pos = start;
    const nummern = r.geraete.map(g => { const te = teVon(g); const nr = te > 1 ? `${pos}–${pos + te - 1}` : String(pos); pos += te; return nr; });

    const mini = h('div', { class: 'mini-streifen', 'aria-hidden': 'true' },
      r.geraete.map((g, gi) => {
        const typ = typVon(g);
        const kl = typ === 'RCD' ? 'm-rcd' : typ === 'LEER' ? 'm-leer' : '';
        const d = h('div', { class: [kl, g.unsicher ? 'm-unsicher' : ''].join(' ').trim() || null, 'data-sprung': `${ri}.${gi}`, style: `--te:${teVon(g)}` },
          h('i', null, nummern[gi]), typ !== 'LEER' && h('b', null, g.wert || (typ === 'LS' ? 'LS' : (Verteilerplan.TYPEN[typ] || {}).kurz || typ)));
        return d;
      }),
      belegt < breite() && h('div', { class: 'm-leer', style: `--te:${breite() - belegt}` }, h('i', null, 'frei')));

    const zaehler = h('span', { class: 'te-zaehler' + (belegt > breite() ? ' zu-viel' : '') }, `${belegt} / ${breite()} TE belegt`);
    const kopf = h('div', { class: 'reihe-kopfzeile' },
      h('h2', null, `Reihe ${ri + 1} `, h('small', null, `Platz ${start}–${start + breite() - 1}`)),
      zaehler,
      h('div', { class: 'rechts' },
        rcdAuswahl({ 'data-reihe-rcd': ri, 'aria-label': 'RCD für diese Reihe' }, r.rcd, rcdAnzahl, 'RCD automatisch'),
        h('button', { type: 'button', class: 'knopf-icon loeschen', 'data-aktion': 'reihe-weg', 'data-r': ri, title: 'Reihe löschen', 'aria-label': `Reihe ${ri + 1} löschen` }, '✕')));

    const liste = h('div', { class: 'geraete' }, r.geraete.map((g, gi) => geraetKarte(g, `${ri}.${gi}`, nummern[gi], rcdAnzahl)));
    const hinzu = h('div', { class: 'hinzu' },
      h('button', { type: 'button', class: 'knopf klein', 'data-hinzu': 'LS', 'data-r': ri }, '+ LS'),
      h('button', { type: 'button', class: 'knopf klein', 'data-hinzu': 'RCD', 'data-r': ri }, '+ RCD'),
      h('button', { type: 'button', class: 'knopf klein', 'data-hinzu': 'LEER', 'data-r': ri }, '+ Freier Platz'),
      h('button', { type: 'button', class: 'knopf klein', 'data-hinzu': 'SONST', 'data-r': ri }, '+ Anderes Gerät'));
    return h('section', { class: 'karte reihe-karte' }, kopf, mini, liste, hinzu);
  }

  function geraetKarte(g, id, nr, rcdAnzahl) {
    const typ = typVon(g);
    const leer = typ === 'LEER';
    const typWahl = h('select', { class: 'eingabe', 'data-g': id, 'data-feld': 'typ', 'aria-label': 'Gerätetyp' },
      TYP_NAMEN.map(([w, t]) => h('option', { value: w, selected: w === typ }, t)));
    const wert = h('input', { class: 'eingabe', 'data-g': id, 'data-feld': 'wert', value: g.wert || '', disabled: leer,
      list: WERTLISTE[typ] ? 'werte-' + WERTLISTE[typ] : null, placeholder: typ === 'RCD' ? '40 A / 30 mA' : typ === 'LS' ? 'B16' : 'Wert', 'aria-label': 'Wert', autocomplete: 'off' });
    const pole = POLE[typ]
      ? h('select', { class: 'eingabe', 'data-g': id, 'data-feld': 'pole', 'aria-label': 'Polzahl' },
          h('option', { value: '' }, 'Pole'),
          POLE[typ].map(p => h('option', { value: p, selected: String(g.pole ?? '') === p }, p === '1+N' || p === '3+N' ? p : p + '-polig')))
      : h('span');
    const knoepfe = h('div', { class: 'knoepfe' },
      h('button', { type: 'button', class: 'knopf-icon', 'data-aktion': 'hoch', 'data-g': id, title: 'nach links', 'aria-label': 'nach links schieben' }, '↑'),
      h('button', { type: 'button', class: 'knopf-icon', 'data-aktion': 'runter', 'data-g': id, title: 'nach rechts', 'aria-label': 'nach rechts schieben' }, '↓'),
      h('button', { type: 'button', class: 'knopf-icon loeschen', 'data-aktion': 'weg', 'data-g': id, title: 'löschen', 'aria-label': 'Gerät löschen' }, '✕'));
    const text = h('input', { class: 'eingabe', 'data-g': id, 'data-feld': 'text', value: g.text || '', disabled: leer,
      placeholder: leer ? 'freier Platz' : typ === 'RCD' ? 'Bezeichnung (optional)' : 'Stromkreis / Raum', 'aria-label': 'Stromkreis', autocomplete: 'off' });

    const mehr = h('details', { class: 'mehr-klappe' }, h('summary', null, 'Mehr'),
      h('div', { class: 'mehr' },
        h('label', { class: 'feld' }, h('span', null, 'Hinweis'), h('input', { 'data-g': id, 'data-feld': 'hinweis', value: g.hinweis || '', placeholder: 'z. B. nicht abschalten' })),
        h('label', { class: 'feld' }, h('span', null, 'Leitung'), h('input', { 'data-g': id, 'data-feld': 'leitung', value: g.leitung || '', placeholder: 'z. B. NYM-J 3×1,5 mm²' })),
        MIT_ART.has(typ) && h('label', { class: 'feld' }, h('span', null, 'Art'),
          h('select', { 'data-g': id, 'data-feld': 'art' }, h('option', { value: '' }, '–'), ARTEN.map(a => h('option', { value: a, selected: g.art === a }, a)))),
        !leer && typ !== 'RCD' && h('label', { class: 'feld' }, h('span', null, 'RCD'),
          rcdAuswahl({ 'data-g': id, 'data-feld': 'rcd' }, g.rcd, rcdAnzahl, 'wie die Reihe')),
        h('label', { class: 'feld' }, h('span', null, 'Breite (TE)'),
          h('input', { 'data-g': id, 'data-feld': 'te', type: 'number', min: 1, max: 12, inputmode: 'numeric', value: g.te || '', placeholder: String(teVon(g)) })),
        h('label', { class: 'haken' }, h('input', { type: 'checkbox', 'data-g': id, 'data-feld': 'unsicher', checked: !!g.unsicher }), 'unsicher markieren')));

    return h('div', { class: 'geraet' + (g.unsicher ? ' unsicher' : ''), 'data-geraet': id },
      h('div', { class: 'nr' }, nr),
      h('div', { class: 'zeile' }, typWahl, wert, pole, knoepfe),
      h('div', { class: 'zeile2' }, text, mehr));
  }

  function neuesGeraet(art) {
    const alle = plan.reihen.flatMap(r => r.geraete);
    const letzter = t => [...alle].reverse().find(g => typVon(g) === t && g.wert);
    if (art === 'LS') return { typ: 'LS', wert: (letzter('LS') || {}).wert || 'B16' };
    if (art === 'RCD') { const v = letzter('RCD') || {}; return { typ: 'RCD', pole: 4, wert: v.wert || '40 A / 30 mA', art: v.art || 'Typ A' }; }
    if (art === 'LEER') return { typ: 'LEER', te: 1 };
    return { typ: 'SONST' };
  }

  /* ---------- 3 Plan ---------- */
  async function zeichnePlan() {
    const status = $('#plan-status');
    status.textContent = 'Plan wird gesetzt …';
    status.className = 'status';
    await Verteilerplan.schriftenLaden(5000);
    if (ansicht !== 'plan') return;
    const daten = KOPIE(plan);
    if (!daten.datum) daten.datum = heute();
    const erg = Verteilerplan.zeichne($('#druck'), FIRMA, daten, LOGO);
    status.textContent = '';
    if (erg.warnungen.length) {
      status.className = 'status fehler';
      status.append('Bitte prüfen: ' + erg.warnungen.join(' · '), h('button', { type: 'button', 'data-ziel': 'verteiler' }, 'Zum Verteiler'));
    } else if (erg.offen.length) {
      status.className = 'status entwurf';
      status.append(`Entwurf – ${erg.offen.length} offene${erg.offen.length === 1 ? 'r Punkt' : ' Punkte'}`, h('button', { type: 'button', 'data-ziel': 'daten' }, 'Ansehen'));
    } else {
      status.className = 'status gut';
      status.textContent = 'Fertig – bereit zum Speichern';
    }
    skalieren();
  }

  function skalieren() {
    const rahmen = $('#vorschau-rahmen'), vorschau = $('#vorschau');
    const blatt = 210 * 96 / 25.4;
    const s = Math.min(1, vorschau.clientWidth / blatt);
    rahmen.style.width = blatt + 'px';
    rahmen.style.transform = `scale(${s})`;
    vorschau.style.height = Math.ceil(rahmen.scrollHeight * s) + 'px';
  }

  /* ---------- Ereignisse ---------- */
  function verdrahten() {
    document.querySelector('.schritte').addEventListener('click', e => {
      const b = e.target.closest('button[data-ansicht]');
      if (b && plan) zeige(b.dataset.ansicht);
    });
    $('#knopf-start').addEventListener('click', () => { fehler(''); zeige('start'); });

    document.addEventListener('click', e => {
      const ziel = e.target.closest('[data-ziel]');
      if (ziel) { zeige(ziel.dataset.ziel); return; }
      const a = e.target.closest('[data-aktion]');
      if (!a) return;
      const aktion = a.dataset.aktion;
      if (aktion === 'bogen') { if (neuBeginnen()) $('#datei-bogen').click(); }
      else if (aktion === 'datei') { if (neuBeginnen()) $('#datei-json').click(); }
      else if (aktion === 'leer') { if (neuBeginnen()) { plan = leererPlan(); speichern(); zeige('daten'); } }
      else if (aktion === 'weiter') { plan = plan || gesichert(); zeige('plan'); }
    });

    $('#datei-bogen').addEventListener('change', e => { const d = e.target.files[0]; e.target.value = ''; if (d) bogenOeffnen(d); });
    $('#datei-json').addEventListener('change', e => { const d = e.target.files[0]; e.target.value = ''; if (d) jsonOeffnen(d); });

    // Daten
    const daten = $('#ansicht-daten');
    daten.addEventListener('input', e => {
      const k = e.target.dataset.kopf;
      if (k) { setze(plan, k, e.target.value.trim() ? e.target.value : ''); speichernSpaeter(); }
    });
    daten.addEventListener('click', e => {
      const n = e.target.closest('[data-netz]');
      if (n) { plan.netz = plan.netz === n.dataset.netz ? '' : n.dataset.netz; speichern(); zeichneDaten(); return; }
      const w = e.target.closest('[data-offen-weg]');
      if (w) { plan.offen.splice(Number(w.dataset.offenWeg), 1); speichern(); zeichneDaten(); return; }
      if (e.target.closest('[data-aktion="offen-dazu"]')) {
        const t = $('#offen-neu').value.trim();
        if (t) { (plan.offen = plan.offen || []).push(t); speichern(); zeichneDaten(); }
      }
    });

    // Verteiler
    const vt = $('#ansicht-verteiler');
    vt.addEventListener('input', e => {
      const t = e.target, id = t.dataset.g, f = t.dataset.feld;
      if (!id || !['wert', 'text', 'hinweis', 'leitung'].includes(f)) return;
      setze(geraetVon(id), f, t.value.trim() ? t.value : '');
      speichernSpaeter();
      if (f === 'wert') {
        const kachel = vt.querySelector(`[data-sprung="${id}"] b`);
        if (kachel) kachel.textContent = t.value || typVon(geraetVon(id));
      }
    });
    vt.addEventListener('change', e => {
      const t = e.target;
      if (t.dataset.reiheRcd !== undefined) {
        const r = plan.reihen[Number(t.dataset.reiheRcd)];
        setze(r, 'rcd', /^\d+$/.test(t.value) ? Number(t.value) : t.value);
        speichern(); zeichneVerteiler(); return;
      }
      const id = t.dataset.g, f = t.dataset.feld;
      if (!id) return;
      const g = geraetVon(id);
      if (f === 'typ') {
        const alt = typVon(g);
        g.typ = t.value;
        delete g.pole;
        if (t.value !== 'LEER') delete g.te; else g.te = g.te || 1;
        if (t.value === 'RCD' && alt !== 'RCD') { g.wert = g.wert && /mA/.test(g.wert) ? g.wert : '40 A / 30 mA'; g.art = g.art || 'Typ A'; g.pole = 4; }
        if (alt === 'RCD' && t.value !== 'RCD' && /mA/.test(g.wert || '')) delete g.wert;
        if (t.value === 'LEER') { delete g.wert; delete g.text; }
      } else if (f === 'pole') { setze(g, 'pole', /^\d+$/.test(t.value) ? Number(t.value) : t.value); delete g.te; }
      else if (f === 'te') setze(g, 'te', t.value ? Math.max(1, Math.round(Number(t.value))) : '');
      else if (f === 'rcd') setze(g, 'rcd', /^\d+$/.test(t.value) ? Number(t.value) : t.value);
      else if (f === 'art') setze(g, 'art', t.value);
      else if (f === 'unsicher') { if (t.checked) g.unsicher = true; else delete g.unsicher; }
      else return;
      speichern(); zeichneVerteiler();
    });
    vt.addEventListener('click', e => {
      const sprung = e.target.closest('[data-sprung]');
      if (sprung) {
        const karte = vt.querySelector(`[data-geraet="${sprung.dataset.sprung}"]`);
        if (karte) {
          karte.scrollIntoView({ behavior: 'smooth', block: 'center' });
          karte.classList.add('markiert');
          setTimeout(() => karte.classList.remove('markiert'), 1600);
        }
        return;
      }
      const hinzu = e.target.closest('[data-hinzu]');
      if (hinzu) {
        const ri = Number(hinzu.dataset.r);
        plan.reihen[ri].geraete.push(neuesGeraet(hinzu.dataset.hinzu));
        speichern(); zeichneVerteiler();
        const neu = vt.querySelector(`[data-geraet="${ri}.${plan.reihen[ri].geraete.length - 1}"] [data-feld="text"]`);
        if (neu && !neu.disabled) neu.focus();
        return;
      }
      const a = e.target.closest('[data-aktion]');
      if (!a) return;
      const aktion = a.dataset.aktion;
      if (aktion === 'reihe-neu') { plan.reihen.push({ geraete: [] }); speichern(); zeichneVerteiler(); return; }
      if (aktion === 'reihe-weg') {
        const ri = Number(a.dataset.r);
        if (plan.reihen[ri].geraete.length && !confirm(`Reihe ${ri + 1} mit allen Geräten löschen?`)) return;
        plan.reihen.splice(ri, 1); speichern(); zeichneVerteiler(); return;
      }
      if (!a.dataset.g) return;
      const [ri, gi] = a.dataset.g.split('.').map(Number);
      const liste = plan.reihen[ri].geraete;
      if (aktion === 'weg') liste.splice(gi, 1);
      else if (aktion === 'hoch' && gi > 0) [liste[gi - 1], liste[gi]] = [liste[gi], liste[gi - 1]];
      else if (aktion === 'runter' && gi < liste.length - 1) [liste[gi + 1], liste[gi]] = [liste[gi], liste[gi + 1]];
      else return;
      speichern(); zeichneVerteiler();
    });

    // Plan
    $('#knopf-drucken').addEventListener('click', () => {
      const titel = document.title;
      document.title = dateiname();
      window.print();
      setTimeout(() => { document.title = titel; }, 1500);
    });
    $('#knopf-json').addEventListener('click', () => herunterladen(dateiname('.json'), JSON.stringify(plan, null, 1), 'application/json'));
    window.addEventListener('resize', () => { if (ansicht === 'plan') skalieren(); });
  }

  function wertlistenAnlegen() {
    for (const [name, werte] of Object.entries(WERTE)) {
      document.body.append(h('datalist', { id: 'werte-' + name }, werte.map(w => h('option', { value: w }))));
    }
  }

  async function starten() {
    try {
      FIRMA = await (await fetch('firma.json', { cache: 'no-cache' })).json();
    } catch (e) {
      FIRMA = { name: 'Elektrotechnik Schilling' };
    }
    LOGO = FIRMA.logo || '';
    plan = gesichert();
    if (plan && !Array.isArray(plan.reihen)) plan = null;
    wertlistenAnlegen();
    verdrahten();
    // index.html#plan oeffnet direkt den zuletzt bearbeiteten Plan
    zeige(location.hash === '#plan' && plan ? 'plan' : 'start');
  }

  starten();
})();
