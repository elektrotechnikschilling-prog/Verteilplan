/* Bedienung der Web-App: Verteiler fotografieren oder Aufnahmebogen oeffnen, Plaetze per Antippen
   bearbeiten, Plan ansehen und als PDF speichern. Gezeichnet wird mit plan.js (dasselbe wie am PC),
   der Bogen wird mit bogen-import.js umgesetzt, Fotos mit foto-ki.js ausgewertet.
   Der Plan liegt nur im Geraet (localStorage); nur zur Fotoauswertung gehen die Fotos an die KI. */
(function () {
  'use strict';
  const SPEICHER = 'verteilerplan.aktuell';
  const SCHLUESSEL = 'verteilerplan.ki-schluessel';
  const MAX_FOTOS = 8;
  const $ = s => document.querySelector(s);
  const KOPIE = o => JSON.parse(JSON.stringify(o));

  const TYP_NAMEN = [
    ['LS', 'LS – Leitungsschutz'], ['RCD', 'RCD – Fehlerstrom'], ['FILS', 'FI/LS'], ['AFDD', 'AFDD – Brandschutz'],
    ['SLS', 'SLS'], ['SI', 'Sicherung'], ['SPD', 'Überspannungsschutz'], ['HS', 'Hauptschalter'],
    ['SCHUETZ', 'Schütz / Relais'], ['STS', 'Stromstoßschalter'], ['UHR', 'Zeitschaltuhr'], ['TRAFO', 'Klingeltrafo / Netzteil'],
    ['ZAEHLER', 'Zwischenzähler'], ['SD', 'Steckdose'], ['SONST', 'Sonstiges'], ['LEER', 'Freier Platz']
  ];
  const HAUPT_TYPEN = [['LS', 'LS'], ['RCD', 'RCD'], ['FILS', 'FI/LS'], ['AFDD', 'AFDD'], ['LEER', 'Frei']];
  const WERTE = {
    LS: [['B6', 'B10', 'B13', 'B16', 'B20', 'B25', 'B32'], ['C6', 'C10', 'C13', 'C16', 'C20', 'C25', 'C32', 'C40']],
    RCD: [['25 A / 30 mA', '40 A / 30 mA', '63 A / 30 mA'], ['40 A / 300 mA', '63 A / 300 mA']]
  };
  const LS_WERT = new Set(['LS', 'FILS', 'AFDD', 'SLS']);
  const POLE = { LS: ['1', '2', '3'], RCD: ['2', '4'], FILS: ['1+N', '3+N'], AFDD: ['1+N'], SLS: ['3'], SI: ['1', '3'], HS: ['3', '4'] };
  const ARTEN = ['Typ A', 'Typ F', 'Typ B', 'Typ AC'];
  const MIT_ART = new Set(['RCD', 'FILS']);
  // Schnellwahl fuer den Stromkreis: Ort und Raum gehen in den Text ("KG – Küche"),
  // Verbraucher in die zweite Zeile ("Steckdosen + Licht")
  const ORTE = ['KG', 'EG', 'OG', 'DG', 'Außen'];
  const RAEUME = ['Küche', 'Bad', 'WC', 'Wohnzimmer', 'Esszimmer', 'Schlafzimmer', 'Kinderzimmer', 'Gästezimmer', 'Büro',
    'Flur', 'Treppenhaus', 'Keller', 'Hauswirtschaft', 'Garage', 'Dachboden', 'Terrasse', 'Garten', 'Wohnung'];
  const VERBRAUCHER = ['Steckdosen', 'Licht', 'Herd', 'Backofen', 'Kochfeld', 'Spülmaschine', 'Waschmaschine', 'Trockner',
    'Kühlschrank', 'Gefriertruhe', 'Heizung', 'Therme', 'Durchlauferhitzer', 'Boiler', 'Rollladen', 'Klingel',
    'Sprechanlage', 'Netzwerk', 'Wallbox', 'Pumpe'];
  const TRENNER = /\s+[–-]\s+/;

  let FIRMA = {}, LOGO = '';
  let plan = null;
  let ansicht = 'start';
  let planArt = 'plan';          // Plan-Ansicht zeigt 'plan' oder 'beschriftung' (Streifen zum Ausschneiden)
  let auswahl = null;            // Geraet (Objekt aus plan.reihen), das im Editor offen ist
  let fotos = [];                // vorbereitete Fotos, nur im Speicher
  let fotoHinweis = '', mitSonstigen = false, fotoVorbereitung = false;
  let fotoLauf = null;           // { ctrl, start, uhr } waehrend der Auswertung
  let fotoMeldung = null;        // { art: 'fehler' | 'info', text }
  let schluesselMeldung = null, schluesselEntwurf = '';
  let letzteAuswertung = null;   // { kosten, dauer, anzahl, fotoHinweis }

  /* ---------- Hilfen ---------- */
  function h(tag, attrs, ...kinder) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
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
  const kostenText = k => '≈ ' + (k < 0.01 ? '0,01' : k.toFixed(2).replace('.', ',')) + ' $';

  function speichern() { try { localStorage.setItem(SPEICHER, JSON.stringify(plan)); } catch (e) { /* privater Modus */ } }
  let speicherUhr = 0;
  function speichernSpaeter() { clearTimeout(speicherUhr); speicherUhr = setTimeout(speichern, 300); }
  function gesichert() { try { return JSON.parse(localStorage.getItem(SPEICHER) || 'null'); } catch (e) { return null; } }
  const hatInhalt = p => p && (p.kunde || p.adresse || (p.reihen || []).some(r => (r.geraete || []).length));
  function schluessel() { try { return localStorage.getItem(SCHLUESSEL) || ''; } catch (e) { return ''; } }

  function leererPlan() {
    return { kunde: '', adresse: '', verteiler: '', standort: '', netz: '', vorsicherung: '', datum: heute(),
      bearbeiter: '', bemerkung: '', te_pro_reihe: 12, reihen: [{ geraete: [] }], offen: [] };
  }
  function setze(obj, feld, wert) { if (wert === '' || wert == null) delete obj[feld]; else obj[feld] = wert; }

  // Alle Geraete mit Reihe, Index und Platznummer
  function alleGeraete() {
    const aus = [];
    plan.reihen.forEach((r, ri) => {
      let p = ri * breite() + 1;
      r.geraete.forEach((g, gi) => {
        const te = teVon(g);
        aus.push({ g, ri, gi, von: p, nr: te > 1 ? `${p}–${p + te - 1}` : String(p) });
        p += te;
      });
    });
    return aus;
  }
  const stelleVon = g => alleGeraete().find(x => x.g === g) || null;
  const echte = () => alleGeraete().filter(x => typVon(x.g) !== 'LEER');
  function letzterLsWert() {
    const g = [...alleGeraete()].reverse().find(x => typVon(x.g) === 'LS' && x.g.wert);
    return g ? g.g.wert : 'B16';
  }

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
    if (neu !== 'verteiler') { auswahl = null; zeichneEditor(); }
    ansicht = neu;
    for (const id of ['start', 'fotos', 'daten', 'verteiler', 'plan']) $('#ansicht-' + id).hidden = id !== neu;
    document.querySelectorAll('.schritte button').forEach(b => {
      b.classList.toggle('aktiv', b.dataset.ansicht === neu);
      b.disabled = !plan;
    });
    if (neu === 'start') zeichneStart();
    if (neu === 'fotos') zeichneFotos();
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
    fotos = []; letzteAuswertung = null; fotoMeldung = null; fotoHinweis = '';
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

  const offenesDa = p => (p.offen || []).length || p.reihen.some(r => r.geraete.some(g => g.unsicher));

  async function bogenOeffnen(datei) {
    fehler('');
    try {
      if (!window.PDFLib) throw new Error('Die PDF-Funktion konnte nicht geladen werden. Bitte Internetverbindung prüfen und die Seite neu laden.');
      const werte = await pdfFelder(datei);
      const bekannt = Object.keys(werte).map(k => k.split('.').pop()).filter(k => /^[st]\d\d$|^craftnote_1_|^ls_standard$|^verteiler$/.test(k));
      if (!bekannt.length) throw new Error('In dieser PDF stecken keine Felder des Aufnahmebogens. Bitte den Aufnahmebogen aus Craftnote nehmen, ausfüllen und als PDF speichern.');
      const neu = BogenImport.zuPlan(werte);
      if (!neu.datum) neu.datum = heute();
      if (!neu.reihen.length) neu.reihen.push({ geraete: [] });
      plan = neu;
      speichern();
      zeige(offenesDa(plan) ? 'verteiler' : 'plan');
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

  /* ---------- Fotos ---------- */
  function zeichneFotos() {
    const el = $('#ansicht-fotos');
    el.textContent = '';
    const schl = schluessel();
    const sperre = !!fotoLauf || fotoVorbereitung;
    el.append(h('div', { class: 'karte' },
      h('h2', null, 'Fotos vom Verteiler'),
      h('ol', { class: 'foto-tipps' },
        h('li', null, h('b', null, 'Ganzer Verteiler'), ' – Abdeckung ab, alle Reihen im Bild'),
        h('li', null, h('b', null, 'Jede Reihe nah'), ' – gerade von vorn, Aufdrucke wie B16 lesbar'),
        h('li', null, h('b', null, 'Beschriftung'), ' – Streifen oder Liste in der Tür, falls vorhanden')),
      h('div', { class: 'foto-knoepfe' },
        h('button', { type: 'button', class: 'knopf haupt', 'data-aktion': 'foto-kamera', disabled: sperre || fotos.length >= MAX_FOTOS }, 'Foto aufnehmen'),
        h('button', { type: 'button', class: 'knopf', 'data-aktion': 'foto-galerie', disabled: sperre || fotos.length >= MAX_FOTOS }, 'Bilder auswählen')),
      fotos.length
        ? h('div', { class: 'foto-raster' }, fotos.map((f, i) => h('figure', { class: 'foto' },
            h('img', { src: f.url, alt: `Foto ${i + 1}`, 'data-foto-gross': i }),
            h('figcaption', null, `Foto ${i + 1}`),
            !sperre && h('button', { type: 'button', class: 'knopf-icon loeschen', 'data-foto-weg': i, 'aria-label': `Foto ${i + 1} entfernen` }, '✕'))))
        : h('p', { class: 'leise' }, fotoVorbereitung ? 'Fotos werden vorbereitet …' : `Noch keine Fotos (bis zu ${MAX_FOTOS}).`),
      fotos.length && fotoVorbereitung ? h('p', { class: 'leise' }, 'Fotos werden vorbereitet …') : null));

    el.append(h('div', { class: 'karte' },
      h('h2', null, 'Hinweise für die Auswertung ', h('small', null, '(optional)')),
      h('textarea', { class: 'eingabe', id: 'foto-hinweis', rows: 2, value: fotoHinweis,
        placeholder: 'z. B. „Obere Reihe ist alt und hat keinen RCD“ – gern auch diktieren' }),
      h('label', { class: 'haken' }, h('input', { type: 'checkbox', id: 'foto-sonstige', checked: mitSonstigen }),
        'Auch Reihen ohne Schutzgeräte übernehmen (Zähler, Uhren, Netzteile)')));

    el.append(zugangKarte(schl));
    el.append(h('div', { class: 'weiter foto-weiter' },
      h('div', { id: 'foto-status', class: 'foto-status', role: 'status' }),
      fotoLauf
        ? h('button', { type: 'button', class: 'knopf', 'data-aktion': 'foto-abbrechen' }, 'Abbrechen')
        : h('button', { type: 'button', class: 'knopf haupt', 'data-aktion': 'foto-auswerten', disabled: !fotos.length || !schl || fotoVorbereitung }, 'Auswerten →')));
    statusZeigen();
  }

  function zugangKarte(schl) {
    if (schl) {
      return h('div', { class: 'karte zugang' },
        h('h2', null, 'KI-Zugang'),
        h('p', null, `Eingerichtet – der Schlüssel endet auf „…${schl.slice(-4)}“ und ist nur auf diesem Gerät gespeichert.`),
        h('button', { type: 'button', class: 'knopf klein', 'data-aktion': 'schluessel-weg', disabled: !!fotoLauf }, 'Schlüssel entfernen'));
    }
    return h('div', { class: 'karte zugang' },
      h('h2', null, 'KI-Zugang einrichten'),
      h('p', null, 'Die Fotos werden zur Auswertung an Claude (Anthropic) geschickt – nur die Fotos und die Hinweise oben, ohne Kundenname und Adresse. ',
        'Dafür braucht dieses Gerät einmalig einen API-Schlüssel aus dem Firmenkonto (platform.claude.com → API Keys). Er wird nur hier gespeichert.'),
      h('div', { class: 'zeile-knoepfe' },
        h('input', { class: 'eingabe', id: 'schluessel-neu', type: 'password', autocomplete: 'off', spellcheck: 'false',
          placeholder: 'sk-ant-…', 'aria-label': 'API-Schlüssel', value: schluesselEntwurf }),
        h('button', { type: 'button', class: 'knopf', 'data-aktion': 'schluessel-speichern' }, 'Speichern')),
      schluesselMeldung && h('p', { class: 'meldung ' + schluesselMeldung.art }, schluesselMeldung.text));
  }

  function statusZeigen() {
    const el = $('#foto-status');
    if (!el) return;
    el.className = 'foto-status';
    el.textContent = '';
    if (fotoLauf) {
      const s = Math.round((Date.now() - fotoLauf.start) / 1000);
      el.classList.add('laeuft');
      el.append(h('span', { class: 'kreisel', 'aria-hidden': 'true' }),
        `Fotos werden ausgewertet … ${Math.floor(s / 60)}:${zwei(s % 60)} (meist 1–3 Minuten)`);
    } else if (fotoMeldung) {
      el.classList.add(fotoMeldung.art);
      el.textContent = fotoMeldung.text;
    } else if (!schluessel()) el.textContent = 'Zuerst den KI-Zugang einrichten.';
    else if (!fotos.length) el.textContent = 'Zuerst Fotos aufnehmen.';
    else el.textContent = `${fotos.length} Foto${fotos.length > 1 ? 's' : ''} bereit.`;
  }

  async function fotosHinzu(dateien) {
    fotoMeldung = null;
    fotoVorbereitung = true;
    zeichneFotos();
    for (const d of dateien) {
      if (fotos.length >= MAX_FOTOS) { fotoMeldung = { art: 'fehler', text: `Höchstens ${MAX_FOTOS} Fotos je Auswertung.` }; break; }
      try { fotos.push(await FotoKI.bildVorbereiten(d)); }
      catch (e) { fotoMeldung = { art: 'fehler', text: e.message || String(e) }; }
    }
    fotoVorbereitung = false;
    if (ansicht === 'fotos') zeichneFotos();
  }

  async function schluesselSpeichern() {
    const k = ($('#schluessel-neu').value || '').trim();
    schluesselEntwurf = k;
    if (!/^sk-ant-\S{10,}$/.test(k)) {
      schluesselMeldung = { art: 'fehler', text: 'Das sieht nicht wie ein API-Schlüssel aus (er beginnt mit „sk-ant-“).' };
      zeichneFotos(); return;
    }
    schluesselMeldung = { art: 'info', text: 'Schlüssel wird geprüft …' };
    zeichneFotos();
    try {
      await FotoKI.pruefen(k);
      try { localStorage.setItem(SCHLUESSEL, k); } catch (e) { throw new Error('Der Schlüssel konnte auf diesem Gerät nicht gespeichert werden (privater Modus?).'); }
      schluesselMeldung = null; schluesselEntwurf = '';
    } catch (e) {
      schluesselMeldung = { art: 'fehler', text: e.message || String(e) };
    }
    if (ansicht === 'fotos') zeichneFotos();
  }

  async function fotosAuswerten() {
    const schl = schluessel();
    if (!fotos.length || !schl || fotoLauf) return;
    fotoMeldung = null;
    fotoLauf = { ctrl: new AbortController(), start: Date.now() };
    fotoLauf.uhr = setInterval(statusZeigen, 1000);
    zeichneFotos();
    try {
      const erg = await FotoKI.auswerten({ bilder: fotos, hinweis: fotoHinweis, schluessel: schl, signal: fotoLauf.ctrl.signal, mitSonstigen });
      if (plan.reihen.some(r => r.geraete.length) &&
          !confirm('Die Geräte im Plan werden durch das Ergebnis der Fotoauswertung ersetzt (Kunde, Adresse usw. bleiben). Weiter?')) {
        fotoMeldung = { art: 'info', text: 'Ergebnis nicht übernommen.' };
        return;
      }
      plan.reihen = erg.reihen.length ? erg.reihen : [{ geraete: [] }];
      plan.offen = erg.offen;
      speichern();
      letzteAuswertung = { kosten: erg.kosten, dauer: erg.dauer, anzahl: fotos.length, fotoHinweis: erg.fotoHinweis };
      clearInterval(fotoLauf.uhr);
      fotoLauf = null;
      zeige('verteiler');
    } catch (e) {
      fotoMeldung = { art: 'fehler', text: e.message || String(e) };
    } finally {
      if (fotoLauf) { clearInterval(fotoLauf.uhr); fotoLauf = null; }
      if (ansicht === 'fotos') zeichneFotos();
    }
  }

  function grossZeigen(url) {
    const box = h('div', { class: 'grossbild', role: 'dialog', 'aria-label': 'Foto groß' },
      h('img', { src: url, alt: 'Foto' }),
      h('button', { type: 'button', class: 'knopf haupt', 'aria-label': 'Schließen' }, 'Schließen'));
    box.addEventListener('click', e => { if (e.target.tagName !== 'IMG') box.remove(); });
    document.body.append(box);
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

    const unsichere = echte().filter(x => x.g.unsicher);
    if (unsichere.length) {
      el.append(h('div', { class: 'karte offen' },
        h('h2', null, `Unsichere Plätze (${unsichere.length})`),
        h('ul', { class: 'offen-liste' }, unsichere.map(x => h('li', null,
          h('span', null, `Nr. ${x.nr}: ${x.g.grund || 'als unsicher markiert'}`),
          h('button', { type: 'button', class: 'knopf klein', 'data-zu-platz': `${x.ri}.${x.gi}` }, 'Ansehen'))))));
    }

    const offen = plan.offen || [];
    el.append(h('div', { class: 'karte' + (offen.length ? ' offen' : '') },
      h('h2', null, offen.length ? `Offene Punkte (${offen.length})` : 'Offene Punkte'),
      offen.length
        ? h('ul', { class: 'offen-liste' }, offen.map((p, i) => h('li', null, h('span', null, p),
            h('button', { type: 'button', class: 'knopf klein', 'data-offen-weg': i }, 'Erledigt'))))
        : h('p', { style: 'margin:0 0 12px;color:var(--a-grau)' },
            unsichere.length ? 'Keine weiteren.' : 'Keine – der Plan ist kein Entwurf.'),
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
  const rcdAnzahl = () => plan.reihen.reduce((n, r) => n + r.geraete.filter(g => typVon(g) === 'RCD').length, 0);

  function kachelText(g) {
    const typ = typVon(g);
    if (typ === 'RCD') return 'RCD';
    if (LS_WERT.has(typ)) return g.wert || (Verteilerplan.TYPEN[typ] || {}).kurz || typ;
    return (Verteilerplan.TYPEN[typ] || {}).kurz || 'Gerät';
  }
  function kachelKlein(g) {
    const typ = typVon(g);
    if (typ === 'RCD') return (g.wert || '').replace(/\s*A\s*\/\s*/, '/').replace(/\s*mA/, '');
    if (typ === 'FILS' || typ === 'AFDD') return (Verteilerplan.TYPEN[typ] || {}).kurz;
    const p = String(g.pole || '');
    return /^[23]$/.test(p) ? p + '-pol.' : '';
  }

  function zeichneVerteiler() {
    const el = $('#ansicht-verteiler');
    el.textContent = '';
    if (!plan.reihen.length) plan.reihen.push({ geraete: [] });
    if (auswahl && !stelleVon(auswahl)) auswahl = null;
    el.append(h('div', { id: 'verteiler-kopf' }), h('div', { id: 'reihen' }),
      h('div', { class: 'weiter' },
        h('button', { type: 'button', class: 'knopf', 'data-aktion': 'reihe-neu' }, '+ Reihe'),
        h('button', { type: 'button', class: 'knopf', 'data-ziel': 'fotos' }, 'Aus Fotos erkennen'),
        h('button', { type: 'button', class: 'knopf haupt', 'data-ziel': 'plan' }, 'Plan ansehen →')));
    zeichneReihen();
    zeichneEditor();
  }

  function verteilerKopf() {
    const bereich = $('#verteiler-kopf');
    if (!bereich) return;
    bereich.textContent = '';
    const unsichere = echte().filter(x => x.g.unsicher);
    if (letzteAuswertung) {
      const a = letzteAuswertung;
      bereich.append(h('div', { class: 'meldung info' },
        h('b', null, `Vorschlag aus ${a.anzahl} Foto${a.anzahl > 1 ? 's' : ''}`), ` – ${a.dauer} s, Kosten ${kostenText(a.kosten)}. Bitte alles kurz prüfen.`,
        a.fotoHinweis && h('div', null, 'Tipp: ', a.fotoHinweis)));
    }
    if (unsichere.length) {
      bereich.append(h('div', { class: 'meldung warn' },
        h('span', null, `${unsichere.length} ${unsichere.length > 1 ? 'Plätze sind' : 'Platz ist'} unsicher (gelb). Antippen, prüfen, „Stimmt so“.`),
        h('button', { type: 'button', class: 'knopf klein', 'data-aktion': 'naechster-unsicher' }, 'Zum ersten')));
    } else {
      bereich.append(h('p', { class: 'leise tipp' }, 'Platz antippen zum Bearbeiten · freie Plätze (+) antippen, um ein Gerät einzusetzen.'));
    }
    if (fotos.length) {
      bereich.append(h('div', { class: 'foto-leiste' }, fotos.map((f, i) =>
        h('img', { src: f.url, alt: `Foto ${i + 1}`, 'data-foto-gross': i, title: 'Foto groß ansehen' }))));
    }
  }

  function zeichneReihen() {
    verteilerKopf();
    const bereich = $('#reihen');
    if (!bereich) return;
    bereich.textContent = '';
    const n = rcdAnzahl();
    plan.reihen.forEach((r, ri) => bereich.append(reiheKarte(r, ri, n)));
  }

  function reiheKarte(r, ri, rcdN) {
    const start = ri * breite() + 1;
    const belegt = r.geraete.reduce((s, g) => s + teVon(g), 0);
    const frei = Math.max(0, breite() - belegt);
    const zellen = [], eintraege = [];
    let p = start;
    r.geraete.forEach((g, gi) => {
      const typ = typVon(g), te = teVon(g);
      const nr = te > 1 ? `${p}–${p + te - 1}` : String(p);
      if (typ === 'LEER') {
        for (let k = 0; k < te; k++) {
          zellen.push(h('button', { type: 'button', class: 'zelle frei', 'data-frei': `${ri}.${gi}.${k}`, 'aria-label': `Platz ${p + k} frei – Gerät einsetzen` },
            h('i', null, p + k), h('b', null, '+')));
        }
      } else {
        const an = auswahl === g;
        zellen.push(h('button', {
          type: 'button', 'data-wahl': `${ri}.${gi}`, style: `--te:${te}`,
          class: ['zelle', typ === 'RCD' ? 'rcd' : '', g.unsicher ? 'unsicher' : '', an ? 'gewaehlt' : ''].filter(Boolean).join(' '),
          'aria-label': `Platz ${nr}: ${kachelText(g)} ${g.text || ''}`.trim()
        }, h('i', null, nr), h('b', null, kachelText(g)), kachelKlein(g) && h('small', null, kachelKlein(g))));
        eintraege.push(h('button', { type: 'button', 'data-wahl': `${ri}.${gi}`,
          class: ['kurz', g.unsicher ? 'unsicher' : '', an ? 'gewaehlt' : ''].filter(Boolean).join(' ') },
          h('span', { class: 'k-nr' }, nr),
          h('b', { class: 'k-wert' }, [kachelText(g), kachelKlein(g)].filter(Boolean).join(' ')),
          h('span', { class: 'k-text' }, [g.text, g.hinweis].filter(Boolean).join(' · ') ||
            (typ === 'RCD' ? [g.wert, g.art].filter(Boolean).join(' · ') : h('em', null, 'Stromkreis fehlt'))),
          g.unsicher && h('span', { class: 'k-warn', title: g.grund || '' }, '!')));
      }
      p += te;
    });
    for (let k = 0; k < frei; k++) {
      zellen.push(h('button', { type: 'button', class: 'zelle frei', 'data-ende': `${ri}.${k}`, 'aria-label': `Platz ${p + k} frei – Gerät einsetzen` },
        h('i', null, p + k), h('b', null, '+')));
    }

    const kopf = h('div', { class: 'reihe-kopfzeile' },
      h('h2', null, `Reihe ${ri + 1} `, h('small', null, `Platz ${start}–${start + breite() - 1}`)),
      h('span', { class: 'te-zaehler' + (belegt > breite() ? ' zu-viel' : '') }, `${belegt} / ${breite()} TE`),
      h('div', { class: 'rechts' },
        rcdAuswahl({ 'data-reihe-rcd': ri, 'aria-label': 'RCD für diese Reihe' }, r.rcd, rcdN, 'RCD automatisch'),
        h('button', { type: 'button', class: 'knopf-icon loeschen', 'data-aktion': 'reihe-weg', 'data-r': ri, title: 'Reihe löschen', 'aria-label': `Reihe ${ri + 1} löschen` }, '✕')));
    const streifen = h('div', { class: 'streifen-edit', style: `--spalten:${Math.max(breite(), belegt)}` }, zellen);
    const fuss = frei
      ? h('div', { class: 'hinzu' }, h('button', { type: 'button', class: 'knopf klein', 'data-aktion': 'reihe-fuellen', 'data-r': ri },
          `${frei} freie${frei > 1 ? '' : 'n'} Pl${frei > 1 ? 'ätze' : 'atz'} mit ${letzterLsWert()} füllen`))
      : null;
    return h('section', { class: 'karte reihe-karte', 'data-reihe': ri }, kopf, streifen,
      eintraege.length ? h('div', { class: 'kurzliste' }, eintraege) : h('p', { class: 'leise leer-hinweis' }, 'Noch keine Geräte – freie Plätze antippen.'),
      fuss);
  }

  /* ----- Aenderungen an den Geraeten (Plaetze bleiben stehen, wo es geht) ----- */
  function neuesLs() { return { typ: 'LS', wert: letzterLsWert() }; }

  // Benachbarte freie Plaetze zusammenfassen, freie Plaetze am Ende weglassen
  function aufraeumen(liste) {
    for (let i = liste.length - 1; i >= 0; i--) {
      const g = liste[i];
      if (typVon(g) !== 'LEER') continue;
      g.te = teVon(g);
      if (g.te <= 0) { liste.splice(i, 1); continue; }
      const n = liste[i + 1];
      if (n && typVon(n) === 'LEER') { g.te += teVon(n); liste.splice(i + 1, 1); }
    }
    while (liste.length && typVon(liste[liste.length - 1]) === 'LEER') liste.pop();
  }

  // Wird ein Geraet breiter, nimmt es zuerst freie Plaetze und leere Platzhalter-LS rechts daneben
  // (ohne Text) auf; wird es schmaler, bleibt rechts ein freier Platz. So verrutschen die Nummern nicht.
  function breiteAnpassen(g, alt) {
    const st = stelleVon(g);
    if (!st) return;
    const liste = plan.reihen[st.ri].geraete;
    const neu = teVon(g);
    if (neu < alt) liste.splice(st.gi + 1, 0, { typ: 'LEER', te: alt - neu });
    let mehr = neu - alt, i = st.gi + 1;
    while (mehr > 0 && i < liste.length) {
      const n = liste[i], typ = typVon(n), te = teVon(n);
      if (typ === 'LEER') {
        const nimm = Math.min(mehr, te);
        n.te = te - nimm; mehr -= nimm;
        if (!n.te) liste.splice(i, 1); else i++;
      } else if (typ === 'LS' && !n.text && !n.hinweis && !n.unsicher) {
        liste.splice(i, 1); mehr -= te;
        if (mehr < 0) { liste.splice(i, 0, { typ: 'LEER', te: -mehr }); mehr = 0; }
      } else break;
    }
    aufraeumen(liste);
  }

  function setzeTyp(g, typ) {
    const alt = typVon(g), altTe = teVon(g);
    if (alt === typ) return;
    g.typ = typ;
    delete g.pole;
    if (typ === 'LEER') {
      g.te = altTe;
      for (const k of ['wert', 'art', 'text', 'hinweis', 'leitung', 'rcd', 'bmk', 'unsicher', 'grund', 'typbez']) delete g[k];
      aufraeumen(plan.reihen[stelleVon(g).ri].geraete);
      return;
    }
    delete g.te;
    if (typ === 'RCD') {
      if (!/mA/.test(g.wert || '')) g.wert = (([...alleGeraete()].reverse().find(x => typVon(x.g) === 'RCD' && x.g !== g && x.g.wert) || {}).g || {}).wert || '40 A / 30 mA';
      g.art = g.art || 'Typ A';
      g.pole = 4;
      delete g.rcd;
    } else {
      if (alt === 'RCD') { delete g.wert; delete g.art; }
      if (LS_WERT.has(typ) && !g.wert) g.wert = letzterLsWert();
      if (!LS_WERT.has(typ) && /^[BCDKZ]\d+$/.test(g.wert || '')) delete g.wert;
      if (!MIT_ART.has(typ)) delete g.art;
    }
    breiteAnpassen(g, altTe);
  }

  function setzePole(g, p) {
    const alt = teVon(g);
    setze(g, 'pole', /^\d+$/.test(p) ? Number(p) : p);
    if (typVon(g) === 'LS' && g.pole === 1) delete g.pole;
    delete g.te;
    breiteAnpassen(g, alt);
  }

  const teile = (text, trenner) => String(text || '').split(trenner).map(s => s.trim()).filter(Boolean);
  function textUmschalten(g, wort, liste) {
    const t = teile(g.text, TRENNER);
    const i = t.findIndex(x => liste.includes(x));
    if (i >= 0) { if (t[i] === wort) t.splice(i, 1); else t[i] = wort; }
    else if (liste === ORTE) t.unshift(wort);
    else { const o = t.findIndex(x => ORTE.includes(x)); t.splice(o >= 0 ? o + 1 : 0, 0, wort); }
    if (t[0] === 'Reserve' && t.length > 1) t.shift();
    setze(g, 'text', t.join(' – '));
  }
  function hinweisUmschalten(g, wort) {
    const t = teile(g.hinweis, /\s*\+\s*/);
    const i = t.indexOf(wort);
    if (i >= 0) t.splice(i, 1); else t.push(wort);
    setze(g, 'hinweis', t.join(' + '));
  }

  // Bisher benutzte Stromkreis-Anfaenge ("KG – Küche") zum schnellen Wiederverwenden
  function zuletztTexte(g) {
    const aus = [];
    for (const x of echte()) {
      if (x.g === g || !x.g.text || typVon(x.g) === 'RCD' || x.g.text === 'Reserve') continue;
      const t = teile(x.g.text, TRENNER);
      const vorn = t.length > 2 ? t.slice(0, 2).join(' – ') : t.join(' – ');
      if (vorn && !aus.includes(vorn)) aus.push(vorn);
    }
    return aus.slice(-8);
  }

  /* ----- Editor fuer einen Platz (unten eingeblendet) ----- */
  const chip = (text, an, attrs) => h('button', Object.assign({ type: 'button', class: 'chip' + (an ? ' an' : ''), 'aria-pressed': an ? 'true' : 'false' }, attrs), text);
  const chips = (liste, kl) => h('div', { class: 'chips' + (kl ? ' ' + kl : '') }, liste);
  const gruppe = (titel, ...inhalt) => h('div', { class: 'ed-gruppe' }, h('span', { class: 'ed-titel' }, titel), inhalt);

  function zeichneEditor(fokus) {
    const ed = $('#editor');
    if (!auswahl || ansicht !== 'verteiler' || !stelleVon(auswahl)) {
      auswahl = null;
      ed.hidden = true;
      ed.textContent = '';
      document.body.classList.remove('mit-editor');
      return;
    }
    const st = stelleVon(auswahl), g = auswahl, typ = typVon(g);
    const liste = echte(), pos = liste.findIndex(x => x.g === g);
    ed.hidden = false;
    document.body.classList.add('mit-editor');
    const scrollAlt = (ed.querySelector('.ed-inhalt') || {}).scrollTop || 0;
    ed.textContent = '';

    const kopf = h('div', { class: 'ed-kopf' },
      h('button', { type: 'button', class: 'knopf-icon', 'data-e': 'zurueck', 'aria-label': 'vorheriger Platz', disabled: pos <= 0 }, '‹'),
      h('div', { class: 'ed-name' }, h('b', null, `Platz ${st.nr}`), h('small', null, `Reihe ${st.ri + 1}`)),
      h('button', { type: 'button', class: 'knopf-icon', 'data-e': 'vor', 'aria-label': 'nächster Platz', disabled: pos < 0 || pos >= liste.length - 1 }, '›'),
      h('button', { type: 'button', class: 'knopf haupt klein', 'data-e': 'fertig' }, 'Fertig'));

    const inhalt = h('div', { class: 'ed-inhalt' });
    if (g.unsicher) {
      inhalt.append(h('div', { class: 'ed-warn' }, h('span', null, g.grund || 'Als unsicher markiert'),
        h('button', { type: 'button', class: 'knopf klein', 'data-e': 'ok' }, 'Stimmt so')));
    }
    if (g.typbez) inhalt.append(h('p', { class: 'ed-info' }, 'Auf dem Foto erkannt: ', h('b', null, g.typbez)));

    // Geraet: Typ, Wert, Art, Pole
    const geraetTeil = [];
    const weitere = TYP_NAMEN.filter(([w]) => !HAUPT_TYPEN.some(([x]) => x === w));
    geraetTeil.push(gruppe('Gerät',
      chips([...HAUPT_TYPEN.map(([w, t]) => chip(t, typ === w, { 'data-e-typ': w })),
        h('select', { class: 'chip-wahl' + (weitere.some(([w]) => w === typ) ? ' an' : ''), 'data-e-feld': 'typ', 'aria-label': 'weitere Gerätetypen' },
          h('option', { value: '' }, 'Weitere …'),
          weitere.map(([w, t]) => h('option', { value: w, selected: w === typ }, t)))])));
    if (typ !== 'LEER') {
      const andere = liste => h('input', { class: 'eingabe klein', 'data-e-feld': 'wert', value: liste.flat().includes(g.wert) ? '' : (g.wert || ''),
        placeholder: 'anderer Wert', autocomplete: 'off', 'aria-label': 'anderer Wert' });
      if (LS_WERT.has(typ)) {
        geraetTeil.push(gruppe('Wert', WERTE.LS.map(z => chips(z.map(w => chip(w, g.wert === w, { 'data-e-wert': w })))), andere(WERTE.LS)));
      } else if (typ === 'RCD') {
        geraetTeil.push(gruppe('Wert', WERTE.RCD.map(z => chips(z.map(w => chip(w.replace(' / ', '/'), g.wert === w, { 'data-e-wert': w })))), andere(WERTE.RCD)));
      } else {
        geraetTeil.push(gruppe('Wert', h('input', { class: 'eingabe', 'data-e-feld': 'wert', value: g.wert || '', placeholder: 'optional', autocomplete: 'off' })));
      }
      if (MIT_ART.has(typ)) geraetTeil.push(gruppe('Art', chips(ARTEN.map(a => chip(a, g.art === a, { 'data-e-art': a })))));
      if (POLE[typ]) {
        const T = Verteilerplan.TYPEN[typ] || {};
        const jetzt = String(g.pole ?? T.pole ?? '');
        geraetTeil.push(gruppe('Pole', chips(POLE[typ].map(p => chip(p.includes('+') ? p : p + '-polig', jetzt === p, { 'data-e-pole': p })))));
      }
    }

    // Stromkreis: Text und was dranhaengt. Bei Stromkreisen (LS, FI/LS …) steht das oben, weil es
    // nach Fotoauswertung oder "Plaetze fuellen" fast immer das ist, was noch fehlt.
    const kreisTeil = [];
    if (typ === 'RCD') {
      kreisTeil.push(gruppe('Bezeichnung (optional)', h('input', { class: 'eingabe', 'data-e-feld': 'text', value: g.text || '', autocomplete: 'off' })));
    } else if (typ !== 'LEER') {
      const zuletzt = zuletztTexte(g), t = teile(g.text, TRENNER);
      kreisTeil.push(gruppe('Stromkreis / Raum',
        h('input', { class: 'eingabe', 'data-e-feld': 'text', value: g.text || '', autocomplete: 'off', enterkeyhint: 'next',
          placeholder: 'antippen oder tippen / diktieren', 'aria-label': 'Stromkreis' }),
        zuletzt.length ? chips(zuletzt.map(z => chip(z, g.text === z, { 'data-e-text': z })), 'zuletzt') : null,
        chips([...ORTE.map(o => chip(o, t.includes(o), { 'data-e-ort': o })), chip('Reserve', g.text === 'Reserve', { 'data-e-reserve': '1' })]),
        chips(RAEUME.map(r => chip(r, t.includes(r), { 'data-e-raum': r })))));
      const hw = teile(g.hinweis, /\s*\+\s*/);
      kreisTeil.push(gruppe('Was hängt dran',
        chips(VERBRAUCHER.map(v => chip(v, hw.includes(v), { 'data-e-verbr': v }))),
        h('input', { class: 'eingabe', 'data-e-feld': 'hinweis', value: g.hinweis || '', autocomplete: 'off', placeholder: 'Ergänzung, z. B. „Boiler oben“', 'aria-label': 'Ergänzung' })));
    }
    const kreis = (Verteilerplan.TYPEN[typ] || {}).kreis;
    inhalt.append(...(kreis ? [...kreisTeil, ...geraetTeil] : [...geraetTeil, ...kreisTeil]));

    const mehrFeld = (titel, el) => h('label', { class: 'feld' }, h('span', null, titel), el);
    inhalt.append(h('details', { class: 'ed-mehr' }, h('summary', null, 'Mehr'),
      h('div', { class: 'raster' },
        typ !== 'LEER' && mehrFeld('Leitung', h('input', { 'data-e-feld': 'leitung', value: g.leitung || '', placeholder: 'z. B. NYM-J 3×1,5 mm²', autocomplete: 'off' })),
        typ !== 'LEER' && typ !== 'RCD' && mehrFeld('RCD', rcdAuswahl({ 'data-e-feld': 'rcd' }, g.rcd, rcdAnzahl(), 'wie die Reihe')),
        mehrFeld('Breite (TE)', h('input', { 'data-e-feld': 'te', type: 'number', min: 1, max: 12, inputmode: 'numeric', value: g.te || '', placeholder: String(teVon(g)) })),
        typ !== 'LEER' && mehrFeld('BMK', h('input', { 'data-e-feld': 'bmk', value: g.bmk || '', placeholder: 'automatisch', autocomplete: 'off' })),
        typ !== 'LEER' && h('label', { class: 'haken' }, h('input', { type: 'checkbox', 'data-e-feld': 'unsicher', checked: !!g.unsicher }), 'als unsicher markieren')),
      h('div', { class: 'ed-aktionen' },
        h('button', { type: 'button', class: 'knopf klein', 'data-e': 'links', disabled: st.gi === 0 }, '◀ nach links'),
        h('button', { type: 'button', class: 'knopf klein', 'data-e': 'rechts', disabled: st.gi >= plan.reihen[st.ri].geraete.length - 1 }, 'nach rechts ▶'),
        h('button', { type: 'button', class: 'knopf klein', 'data-e': 'davor' }, 'Freien Platz davor'),
        typ !== 'LEER' && h('button', { type: 'button', class: 'knopf klein', 'data-e': 'leeren' }, 'Entfernen (Platz bleibt frei)'),
        h('button', { type: 'button', class: 'knopf klein loeschen', 'data-e': 'weg' }, 'Löschen (Rest rückt nach)'))));

    ed.append(kopf, inhalt);
    inhalt.scrollTop = fokus ? 0 : scrollAlt;
    if (fokus === 'text') { const f = ed.querySelector('[data-e-feld="text"]'); if (f) f.focus(); }
  }

  function waehle(g, fokus) {
    const neu = auswahl !== g;
    auswahl = g;
    zeichneReihen();
    zeichneEditor(neu ? (fokus || 'oben') : fokus);
    if (neu) setTimeout(sichtbarMachen, 0);
  }
  function sichtbarMachen() {
    const z = document.querySelector('.zelle.gewaehlt');
    if (!z) return;
    const r = z.getBoundingClientRect();
    const oben = $('.leiste').offsetHeight + 8;
    const unten = window.innerHeight - ($('#editor').hidden ? 0 : $('#editor').offsetHeight) - 8;
    if (r.top < oben || r.bottom > unten) window.scrollBy(0, r.top - oben - 40);
  }
  function naechster(richtung, nurUnsichere) {
    const liste = echte().filter(x => !nurUnsichere || x.g.unsicher);
    if (!liste.length) return null;
    if (!auswahl) return liste[0].g;
    const alle = echte(), hier = alle.findIndex(x => x.g === auswahl);
    const kandidaten = richtung > 0 ? alle.slice(hier + 1) : alle.slice(0, Math.max(0, hier)).reverse();
    const t = kandidaten.find(x => !nurUnsichere || x.g.unsicher);
    return t ? t.g : null;
  }

  function editorKlick(e) {
    const g = auswahl;
    if (!g) return;
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    const st = stelleVon(g);
    const liste = plan.reihen[st.ri].geraete;
    if (d.e === 'fertig') { auswahl = null; zeichneReihen(); zeichneEditor(); return; }
    if (d.e === 'vor' || d.e === 'zurueck') { const n = naechster(d.e === 'vor' ? 1 : -1); if (n) waehle(n); return; }
    if (d.e === 'ok') {
      delete g.unsicher; delete g.grund; speichern();
      const n = naechster(1, true) || naechster(-1, true);
      if (n) waehle(n); else { zeichneReihen(); zeichneEditor(); }
      return;
    }
    if (d.e === 'links' || d.e === 'rechts') {
      const j = st.gi + (d.e === 'links' ? -1 : 1);
      if (j < 0 || j >= liste.length) return;
      [liste[st.gi], liste[j]] = [liste[j], liste[st.gi]];
    } else if (d.e === 'davor') {
      liste.splice(st.gi, 0, { typ: 'LEER', te: 1 });
      aufraeumen(liste);
    } else if (d.e === 'leeren') {
      liste.splice(st.gi, 1, { typ: 'LEER', te: teVon(g) });
      aufraeumen(liste);
      auswahl = null;
    } else if (d.e === 'weg') {
      liste.splice(st.gi, 1);
      aufraeumen(liste);
      auswahl = null;
    } else if (d.eTyp) setzeTyp(g, d.eTyp);
    else if (d.eWert) g.wert = d.eWert;
    else if (d.eArt) setze(g, 'art', g.art === d.eArt ? '' : d.eArt);
    else if (d.ePole) setzePole(g, d.ePole);
    else if (d.eText) setze(g, 'text', g.text === d.eText ? '' : d.eText);
    else if (d.eOrt) textUmschalten(g, d.eOrt, ORTE);
    else if (d.eRaum) textUmschalten(g, d.eRaum, RAEUME);
    else if (d.eReserve) { if (g.text === 'Reserve') delete g.text; else { g.text = 'Reserve'; delete g.hinweis; } }
    else if (d.eVerbr) hinweisUmschalten(g, d.eVerbr);
    else return;
    if (auswahl && typVon(auswahl) === 'LEER') auswahl = null;
    speichern();
    zeichneReihen();
    zeichneEditor();
  }

  function editorEingabe(e) {
    const t = e.target, f = t.dataset.eFeld, g = auswahl;
    if (!g || !['wert', 'text', 'hinweis', 'leitung', 'bmk'].includes(f)) return;
    setze(g, f, t.value.trim() ? t.value : '');
    speichernSpaeter();
    zeichneReihen();
  }

  function editorAenderung(e) {
    const t = e.target, f = t.dataset.eFeld, g = auswahl;
    if (!g || !f) return;
    if (f === 'typ') { if (!t.value) return; setzeTyp(g, t.value); if (typVon(g) === 'LEER') auswahl = null; }
    else if (f === 'te') { const alt = teVon(g); setze(g, 'te', t.value ? Math.max(1, Math.round(Number(t.value))) : ''); breiteAnpassen(g, alt); }
    else if (f === 'rcd') setze(g, 'rcd', /^\d+$/.test(t.value) ? Number(t.value) : t.value);
    else if (f === 'unsicher') {
      if (t.checked) { g.unsicher = true; g.grund = g.grund || 'von Hand als unsicher markiert'; } else { delete g.unsicher; delete g.grund; }
    } else return;
    speichern();
    zeichneReihen();
    zeichneEditor();
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
    daten.beschriftung = planArt === 'beschriftung';
    document.querySelectorAll('#plan-art button').forEach(b => b.classList.toggle('an', b.dataset.planart === planArt));
    const erg = Verteilerplan.zeichne($('#druck'), FIRMA, daten, LOGO);
    status.textContent = '';
    if (erg.warnungen.length) {
      status.className = 'status fehler';
      status.append('Bitte prüfen: ' + erg.warnungen.join(' · '), h('button', { type: 'button', 'data-ziel': 'verteiler' }, 'Zum Verteiler'));
    } else if (erg.offen.length) {
      status.className = 'status entwurf';
      status.append(`Entwurf – ${erg.offen.length} offene${erg.offen.length === 1 ? 'r Punkt' : ' Punkte'}`, h('button', { type: 'button', 'data-ziel': 'daten' }, 'Ansehen'));
    } else if (planArt === 'beschriftung') {
      status.className = 'status gut';
      status.textContent = 'Originalgröße – beim Drucken Skalierung 100 % wählen';
    } else {
      status.className = 'status gut';
      status.textContent = 'Fertig – bereit zum Speichern';
    }
    skalieren();
  }

  function skalieren() {
    const rahmen = $('#vorschau-rahmen'), vorschau = $('#vorschau');
    const blatt = (planArt === 'beschriftung' ? 297 : 210) * 96 / 25.4;
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
      if (e.target.closest('#editor')) return;
      const gross = e.target.closest('[data-foto-gross]');
      if (gross) { const f = fotos[Number(gross.dataset.fotoGross)]; if (f) grossZeigen(f.url); return; }
      const ziel = e.target.closest('[data-ziel]');
      if (ziel) { zeige(ziel.dataset.ziel); return; }
      const platz = e.target.closest('[data-zu-platz]');
      if (platz) {
        const [ri, gi] = platz.dataset.zuPlatz.split('.').map(Number);
        const g = plan.reihen[ri] && plan.reihen[ri].geraete[gi];
        zeige('verteiler');
        if (g) waehle(g);
        return;
      }
      const a = e.target.closest('[data-aktion]');
      if (!a) return;
      const aktion = a.dataset.aktion;
      if (aktion === 'fotos-neu') { if (neuBeginnen()) { plan = leererPlan(); speichern(); zeige('fotos'); } }
      else if (aktion === 'bogen') { if (neuBeginnen()) $('#datei-bogen').click(); }
      else if (aktion === 'datei') { if (neuBeginnen()) $('#datei-json').click(); }
      else if (aktion === 'leer') { if (neuBeginnen()) { plan = leererPlan(); speichern(); zeige('daten'); } }
      else if (aktion === 'weiter') { plan = plan || gesichert(); zeige('plan'); }
    });

    $('#datei-bogen').addEventListener('change', e => { const d = e.target.files[0]; e.target.value = ''; if (d) bogenOeffnen(d); });
    $('#datei-json').addEventListener('change', e => { const d = e.target.files[0]; e.target.value = ''; if (d) jsonOeffnen(d); });
    for (const id of ['#datei-kamera', '#datei-bilder']) {
      $(id).addEventListener('change', e => { const d = [...e.target.files]; e.target.value = ''; if (d.length) fotosHinzu(d); });
    }

    // Fotos
    const fv = $('#ansicht-fotos');
    fv.addEventListener('click', e => {
      const weg = e.target.closest('[data-foto-weg]');
      if (weg) { const [f] = fotos.splice(Number(weg.dataset.fotoWeg), 1); if (f) URL.revokeObjectURL(f.url); fotoMeldung = null; zeichneFotos(); return; }
      const a = e.target.closest('[data-aktion]');
      if (!a) return;
      const aktion = a.dataset.aktion;
      if (aktion === 'foto-kamera') $('#datei-kamera').click();
      else if (aktion === 'foto-galerie') $('#datei-bilder').click();
      else if (aktion === 'foto-auswerten') fotosAuswerten();
      else if (aktion === 'foto-abbrechen') { if (fotoLauf) fotoLauf.ctrl.abort(); }
      else if (aktion === 'schluessel-speichern') schluesselSpeichern();
      else if (aktion === 'schluessel-weg') {
        if (confirm('API-Schlüssel von diesem Gerät entfernen?')) { try { localStorage.removeItem(SCHLUESSEL); } catch (err) { /* egal */ } zeichneFotos(); }
      }
    });
    fv.addEventListener('input', e => {
      if (e.target.id === 'foto-hinweis') fotoHinweis = e.target.value;
      if (e.target.id === 'schluessel-neu') schluesselEntwurf = e.target.value;
    });
    fv.addEventListener('change', e => { if (e.target.id === 'foto-sonstige') mitSonstigen = e.target.checked; });
    fv.addEventListener('keydown', e => { if (e.target.id === 'schluessel-neu' && e.key === 'Enter') schluesselSpeichern(); });

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
    vt.addEventListener('change', e => {
      const t = e.target;
      if (t.dataset.reiheRcd === undefined) return;
      const r = plan.reihen[Number(t.dataset.reiheRcd)];
      setze(r, 'rcd', /^\d+$/.test(t.value) ? Number(t.value) : t.value);
      speichern(); zeichneReihen(); zeichneEditor();
    });
    vt.addEventListener('click', e => {
      const wahl = e.target.closest('[data-wahl]');
      if (wahl) {
        const [ri, gi] = wahl.dataset.wahl.split('.').map(Number);
        const g = plan.reihen[ri].geraete[gi];
        if (auswahl === g) { auswahl = null; zeichneReihen(); zeichneEditor(); } else waehle(g);
        return;
      }
      const frei = e.target.closest('[data-frei]');
      if (frei) {
        const [ri, gi, k] = frei.dataset.frei.split('.').map(Number);
        const liste = plan.reihen[ri].geraete, leer = liste[gi], te = teVon(leer);
        const neu = neuesLs();
        const ersatz = [];
        if (k > 0) ersatz.push({ typ: 'LEER', te: k });
        ersatz.push(neu);
        if (te - k - 1 > 0) ersatz.push({ typ: 'LEER', te: te - k - 1 });
        liste.splice(gi, 1, ...ersatz);
        speichern(); waehle(neu);
        return;
      }
      const ende = e.target.closest('[data-ende]');
      if (ende) {
        const [ri, k] = ende.dataset.ende.split('.').map(Number);
        const liste = plan.reihen[ri].geraete, neu = neuesLs();
        if (k > 0) liste.push({ typ: 'LEER', te: k });
        liste.push(neu);
        aufraeumen(liste);
        speichern(); waehle(neu);
        return;
      }
      const a = e.target.closest('[data-aktion]');
      if (!a) return;
      const aktion = a.dataset.aktion;
      if (aktion === 'reihe-neu') { plan.reihen.push({ geraete: [] }); speichern(); zeichneReihen(); return; }
      if (aktion === 'reihe-weg') {
        const ri = Number(a.dataset.r);
        if (plan.reihen[ri].geraete.length && !confirm(`Reihe ${ri + 1} mit allen Geräten löschen?`)) return;
        plan.reihen.splice(ri, 1);
        if (!plan.reihen.length) plan.reihen.push({ geraete: [] });
        speichern(); zeichneReihen(); zeichneEditor(); return;
      }
      if (aktion === 'reihe-fuellen') {
        const liste = plan.reihen[Number(a.dataset.r)].geraete;
        const frei = breite() - liste.reduce((s, g) => s + teVon(g), 0);
        const wert = letzterLsWert();
        for (let i = 0; i < frei; i++) liste.push({ typ: 'LS', wert });
        speichern(); zeichneReihen(); zeichneEditor(); return;
      }
      if (aktion === 'naechster-unsicher') { const n = naechster(1, true) || naechster(-1, true); if (n) waehle(n); }
    });

    // Editor
    const ed = $('#editor');
    ed.addEventListener('click', editorKlick);
    ed.addEventListener('input', editorEingabe);
    ed.addEventListener('change', editorAenderung);
    ed.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || e.target.dataset.eFeld !== 'text') return;
      e.preventDefault();
      const n = naechster(1);
      if (n) waehle(n, 'text'); else e.target.blur();
    });

    // Plan
    $('#plan-art').addEventListener('click', e => {
      const b = e.target.closest('button[data-planart]');
      if (!b || b.dataset.planart === planArt) return;
      planArt = b.dataset.planart;
      zeichnePlan();
    });
    $('#knopf-drucken').addEventListener('click', () => {
      const titel = document.title;
      document.title = planArt === 'beschriftung' ? dateiname().replace(/^Verteilerplan/, 'Beschriftung') : dateiname();
      window.print();
      setTimeout(() => { document.title = titel; }, 1500);
    });
    $('#knopf-json').addEventListener('click', () => herunterladen(dateiname('.json'), JSON.stringify(plan, null, 1), 'application/json'));
    window.addEventListener('resize', () => { if (ansicht === 'plan') skalieren(); });
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
    verdrahten();
    // index.html#plan oeffnet direkt den zuletzt bearbeiteten Plan
    zeige(location.hash === '#plan' && plan ? 'plan' : 'start');
  }

  starten();
})();
