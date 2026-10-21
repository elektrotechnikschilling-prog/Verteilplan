/* Zeichnet Verteilerplan und Aufnahmebogen. Gemeinsam genutzt von der Web-App (index.html) und
   der PC-Ausgabe (vorlage/verteilerplan.html ueber erstellen.ps1).

   Verteilerplan.zeichne(ziel, firma, plan, logo) -> { titel, warnungen, offen }
     ziel  : leeres Element im Dokument; es bekommt die Klasse .vp und die A4-Blaetter
     firma : Inhalt von firma.json
     plan  : Plan-Daten (Format siehe CLAUDE.md); { aufnahmebogen: true } zeichnet den leeren Bogen
     logo  : Bild-Adresse (URL oder data:-URI) oder ''
   Vorher Verteilerplan.schriftenLaden() abwarten, sonst wird mit der Ersatzschrift gemessen. */
(function (global) {
  'use strict';

  // bmk = Kennbuchstabe nach DIN EN IEC 81346-2, pole/te = Standardwerte, kreis = eigener Stromkreis
  const TYPEN = {
    RCD:     { kurz: 'RCD',    lang: 'Fehlerstrom-Schutzschalter (FI)',        bmk: 'F', pole: 4 },
    LS:      { kurz: 'LS',     lang: 'Leitungsschutzschalter',                 bmk: 'F', pole: 1, kreis: true },
    FILS:    { kurz: 'FI/LS',  lang: 'FI/LS-Schalter (RCBO)',                  bmk: 'F', pole: '1+N', kreis: true },
    AFDD:    { kurz: 'AFDD',   lang: 'Brandschutzschalter',                    bmk: 'F', pole: '1+N', kreis: true },
    SLS:     { kurz: 'SLS',    lang: 'Selektiver Hauptleitungsschutzschalter', bmk: 'F', pole: 3, kreis: true },
    SI:      { kurz: 'Si',     lang: 'Schmelzsicherung',                       bmk: 'F', pole: 1, kreis: true },
    SPD:     { kurz: 'SPD',    lang: 'Überspannungsschutz',                    bmk: 'F', te: 4 },
    HS:      { kurz: 'HS',     lang: 'Hauptschalter',                          bmk: 'Q', pole: 3 },
    SCHUETZ: { kurz: 'Schütz', lang: 'Installationsschütz',                    bmk: 'Q', te: 2 },
    STS:     { kurz: 'StS',    lang: 'Stromstoßschalter',                      bmk: 'Q', te: 1 },
    UHR:     { kurz: 'Uhr',    lang: 'Zeitschaltuhr',                          bmk: 'K', te: 2 },
    TRAFO:   { kurz: 'Trafo',  lang: 'Klingeltransformator',                   bmk: 'T', te: 2 },
    ZAEHLER: { kurz: 'kWh',    lang: 'Zwischenzähler',                         bmk: 'P', te: 4 },
    SD:      { kurz: 'SD',     lang: 'Steckdose im Verteiler',                 bmk: 'X', te: 3 },
    SONST:   { kurz: '',       lang: 'Gerät',                                  bmk: '',  te: 1 },
    LEER:    { kurz: '',       lang: 'frei',                                   bmk: '',  te: 1 }
  };
  const AUTO_RCD = new Set(['LS', 'SI', 'AFDD']);
  const GRUPPENFARBEN = ['#1f6feb', '#e8590c', '#2b8a3e', '#9c36b5', '#0c8599', '#c2255c'];
  // Gruppe: Nummer des RCD, 'eigen' (FI/LS), 'offen' (bei der Aufnahme nicht geklaert) oder 0 (ohne RCD)
  const gruppenFarbe = g => g === 'eigen' ? '#3d4b5c' : g === 'offen' ? '#cfd5dd' : GRUPPENFARBEN[(g - 1) % GRUPPENFARBEN.length];
  const MM = 96 / 25.4; // CSS-Pixel je Millimeter
  const SCHRIFTEN = ['400 10pt Barlow', '500 10pt Barlow', '600 10pt Barlow', '700 10pt Barlow',
    '400 10pt "Barlow Semi Condensed"', '500 10pt "Barlow Semi Condensed"'];

  function h(tag, attrs, ...kinder) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v; else el.setAttribute(k, v);
    }
    for (const k of kinder.flat(Infinity)) {
      if (k == null || k === false || k === '') continue;
      el.append(k.nodeType ? k : document.createTextNode(String(k)));
    }
    return el;
  }

  function datumText(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
    if (m) return `${m[3]}.${m[2]}.${m[1]}`;
    if (iso) return String(iso);
    return new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  // Breite eines Geraets in Teilungseinheiten (TE)
  function teVon(g) {
    const T = TYPEN[String(g.typ || 'SONST').toUpperCase()] || TYPEN.SONST;
    const fest = Number(g.te) || Number(T.te);
    if (fest) return Math.max(1, Math.round(fest));
    const pol = String(g.pole ?? T.pole ?? 1).replace(/\s/g, '').toUpperCase();
    if (pol === '1+N') return 2;
    if (pol === '3+N') return 4;
    const n = parseInt(pol, 10) || 1;
    return String(g.typ).toUpperCase() === 'RCD' ? (n > 2 ? 4 : 2) : n;
  }

  // Wartet, bis die Planschriften geladen sind (hoechstens ms Millisekunden, z. B. ohne Netz)
  function schriftenLaden(ms = 8000) {
    if (!document.fonts || !document.fonts.load) return Promise.resolve(false);
    const geladen = Promise.all(SCHRIFTEN.map(s => document.fonts.load(s))).then(() => true, () => false);
    return Promise.race([geladen, new Promise(r => setTimeout(() => r(false), ms))]);
  }

  function zeichne(ziel, FIRMA, PLAN, LOGO) {
    FIRMA = FIRMA || {};
    PLAN = PLAN || {};
    LOGO = LOGO || '';
    ziel.textContent = '';
    ziel.className = 'vp';
    const wurzel = ziel.style;
    if (FIRMA.farbe) wurzel.setProperty('--akzent', FIRMA.farbe);
    if (FIRMA.farbe_dunkel) wurzel.setProperty('--dunkel', FIRMA.farbe_dunkel);
    if (Number(FIRMA.logo_hoehe)) wurzel.setProperty('--logo-h', Number(FIRMA.logo_hoehe) + 'mm');
    const MIT_BMK = (PLAN.bmk ?? FIRMA.bmk) !== false;
    ziel.classList.toggle('ohne-bmk', !MIT_BMK);

    /* ================= Daten aufbereiten ================= */
    const BREITE = Number(PLAN.te_pro_reihe) || 12;
    const warnungen = [];
    const rcds = [];

    function polText(roh) {
      if (roh == null || roh === '') return '';
      const pol = String(roh).replace(/\s/g, '').toUpperCase();
      if (pol.includes('+')) return pol;
      const n = parseInt(pol, 10) || 1;
      return n > 1 ? n + 'p' : '';
    }
    const spanne = (von, bis) => von === bis ? String(von) : `${von}–${bis}`;

    const reihen = (PLAN.reihen || []).map((r, i) => {
      const roh = Array.isArray(r) ? { geraete: r } : r;
      return { nr: i + 1, breite: Number(roh.te) || BREITE, rcdVorgabe: roh.rcd, geraete: (roh.geraete || []).map(g => ({ ...g })) };
    });

    let start = 1;
    for (const r of reihen) {
      r.von = start;
      let belegt = 0;
      for (const g of r.geraete) {
        g.typ = String(g.typ || 'SONST').toUpperCase();
        if (!TYPEN[g.typ]) { warnungen.push(`Reihe ${r.nr}: unbekannter Gerätetyp „${g.typ}“`); g.typ = 'SONST'; }
        g.T = TYPEN[g.typ];
        g.te = teVon(g);
        g.von = start + belegt;
        g.bis = g.von + g.te - 1;
        g.nr = g.nr != null && g.nr !== '' ? String(g.nr) : spanne(g.von, g.bis);
        g.bmk = g.bmk != null && g.bmk !== '' ? String(g.bmk) : (g.T.bmk ? '-' + g.T.bmk + g.von : '');
        g.reserve = g.reserve === true || /^reserve$/i.test(g.text || '');
        belegt += g.te;
        if (g.typ === 'RCD') { rcds.push(g); g.gruppe = rcds.length; }
      }
      if (belegt > r.breite) warnungen.push(`Reihe ${r.nr}: ${belegt} TE belegt, aber nur ${r.breite} TE vorhanden`);
      if (belegt < r.breite) {
        const von = start + belegt, bis = start + r.breite - 1;
        r.geraete.push({ typ: 'LEER', T: TYPEN.LEER, te: r.breite - belegt, von, bis, nr: spanne(von, bis) });
      }
      r.spalten = Math.max(belegt, r.breite);
      start += r.breite;
    }

    function rcdNummer(v, wo) {
      if (v == null || v === false || v === 0 || /^(ohne|kein|keiner|-|–)?$/i.test(String(v).trim())) return 0;
      if (String(v).trim() === '?') return 'offen';
      const n = parseInt(String(v).replace(/\D/g, ''), 10);
      if (!n || n > rcds.length) { warnungen.push(`${wo}: RCD „${v}“ gibt es nicht`); return 0; }
      return n;
    }
    for (const r of reihen) {
      let aktuell = rcdNummer(r.rcdVorgabe, `Reihe ${r.nr}`);
      for (const g of r.geraete) {
        if (g.typ === 'RCD') { aktuell = g.gruppe; continue; }
        if (g.typ === 'FILS') g.gruppe = 'eigen';
        else if (g.rcd !== undefined && g.rcd !== '') g.gruppe = rcdNummer(g.rcd, `Nr. ${g.nr}`);
        else g.gruppe = AUTO_RCD.has(g.typ) ? aktuell : 0;
      }
    }
    const alle = reihen.flatMap(r => r.geraete);

    // Was in Kachel und Liste steht
    function anzeige(g) {
      const T = g.T, pol = polText(g.pole ?? T.pole), detail = [];
      let haupt, neben = '', text = g.text || '';
      if (g.typ === 'RCD') {
        haupt = 'RCD ' + g.gruppe;
        text = [g.wert, g.art, pol.replace('p', '-polig'), g.text].filter(Boolean).join(' · ');
        return { haupt, neben, text, detail: [g.hinweis].filter(Boolean), kachelNeben: g.wert || '' };
      }
      if (T.kreis) {
        haupt = g.wert || T.kurz;
        const abweichend = polText(g.pole) && polText(g.pole) !== polText(T.pole) ? polText(g.pole) : '';
        neben = g.typ === 'LS' ? pol : [T.kurz, abweichend].filter(Boolean).join(' ');
        if (g.typ !== 'LS' && g.art) detail.push(g.art);
        if (g.reserve) text = 'Reserve';
      } else {
        haupt = T.kurz || '–';
        text = g.text || T.lang;
        if (g.wert) detail.push(g.wert);
      }
      if (g.leitung) detail.push(g.leitung);
      if (g.hinweis) detail.push(g.hinweis);
      return { haupt, neben, text: text || '–', detail, kachelNeben: T.kreis ? neben : (g.wert || '') };
    }

    /* ================= Bausteine ================= */
    function kopfGross(titel, klein) {
      const logo = LOGO
        ? h('div', { class: 'logo' }, h('img', { src: LOGO, alt: '' }))
        : h('div', { class: 'logo' }, h('div', { class: 'logo-ersatz' }));
      if (!LOGO) logo.firstChild.innerHTML = '<svg viewBox="0 0 24 24"><path d="M13.5 1.5 4 14h6.2l-1.4 8.5L19 9.6h-6.6z"/></svg>';
      const nurLogo = LOGO && FIRMA.logo_ersetzt_namen;
      return [
        h('header', { class: 'kopf' },
          h('div', { class: 'firma' }, logo,
            !nurLogo && h('div', null,
              h('div', { class: 'firma-name' }, FIRMA.name),
              FIRMA.zusatz && h('div', { class: 'firma-zusatz' }, FIRMA.zusatz))),
          h('div', { class: 'titel' },
            h('div', { class: 'titel-klein' }, klein),
            h('div', { class: 'titel-gross' }, titel))),
        h('div', { class: 'kopflinie' }, h('i'), h('i'))
      ];
    }
    function kopfKlein(titel) {
      return [
        h('header', { class: 'kopf-klein' }, h('b', null, FIRMA.name), h('span', null, titel)),
        h('div', { class: 'kopflinie' }, h('i'), h('i'))
      ];
    }
    function fusszeile() {
      const teile = [FIRMA.inhaber, FIRMA.strasse, FIRMA.ort, FIRMA.telefon && 'Tel. ' + FIRMA.telefon, FIRMA.email, FIRMA.web].filter(Boolean);
      return h('footer', { class: 'fusszeile' },
        h('span', null, h('b', null, FIRMA.name), teile.length ? ' · ' + teile.join(' · ') : ''),
        h('span', { class: 'seite' }));
    }
    // Fusszeile des Aufnahmebogens: Link zur Web-App, damit man aus dem ausgefuellten Bogen
    // (z. B. in Craftnote) direkt zum fertigen Plan kommt
    function fusszeileBogen() {
      if (!FIRMA.app_url) return fusszeile();
      return h('footer', { class: 'fusszeile mit-link' },
        h('span', null,
          h('a', { class: 'app-link', href: FIRMA.app_url }, 'Fertigen Verteilerplan erstellen ›'),
          h('span', { class: 'app-url' }, FIRMA.app_url.replace(/^https?:\/\//, '').replace(/\/$/, ''))),
        h('span', null, h('b', null, FIRMA.name), ' · ', h('span', { class: 'seite' })));
    }
    function seitenzahlen() {
      const s = ziel.querySelectorAll('.seite');
      s.forEach((el, i) => { el.textContent = `Seite ${i + 1} / ${s.length}`; });
    }

    function meta() {
      const feld = (l, w) => h('div', null, h('div', { class: 'm-l' }, l), h('div', { class: 'm-w' + (w ? '' : ' offen') }, w || '–'));
      return h('section', { class: 'meta' },
        feld('Kunde', PLAN.kunde),
        feld('Anlagenadresse', (PLAN.adresse || '').replace(/,\s*/g, '\n')),
        feld('Verteiler', PLAN.verteiler),
        feld('Standort', PLAN.standort),
        feld('Netzsystem', PLAN.netz),
        feld('Nennspannung', PLAN.spannung || '230/400 V · 50 Hz'),
        feld('Vorsicherung', PLAN.vorsicherung),
        feld('Stand', datumText(PLAN.datum)));
    }

    function spaltenkopf() {
      const eine = () => h('div', null,
        h('span', null, 'Nr.'), MIT_BMK && h('span', null, 'BMK'), h('span', null, 'Schutz'),
        h('span', null, 'Stromkreis / Verbraucher'), h('span', null, 'RCD'));
      return h('div', { class: 'spaltenkopf' }, eine(), eine());
    }

    function punkt(g) {
      if (g.typ === 'LEER' || (!g.T.kreis && g.typ !== 'RCD' && !g.gruppe)) return null;
      if (!g.gruppe) return h('span', { class: 'punkt ohne' }, '–');
      if (g.gruppe === 'offen') return h('span', { class: 'punkt fraglich' }, '?');
      return h('span', { class: 'punkt', style: `--gruppe:${gruppenFarbe(g.gruppe)}` }, g.gruppe === 'eigen' ? 'Δ' : g.gruppe);
    }

    function modul(g) {
      const kl = ['modul', 'typ-' + g.typ.toLowerCase()];
      if (g.reserve) kl.push('reserve');
      if (g.unsicher) kl.push('unsicher');
      if (!g.T.kreis && g.typ !== 'RCD' && g.typ !== 'LEER') kl.push('geraet');
      const el = h('div', { class: kl.join(' ') }, h('span', { class: 'm-nr' }, g.nr));
      el.style.gridColumn = 'span ' + g.te;
      if (g.gruppe) el.style.setProperty('--gruppe', gruppenFarbe(g.gruppe));
      if (g.typ === 'LEER') return el;
      const a = anzeige(g);
      el.append(h('span', { class: 'm-wert' }, a.haupt), a.kachelNeben && h('span', { class: 'm-sub' }, a.kachelNeben));
      return el;
    }

    function eintrag(g) {
      const a = anzeige(g);
      const el = h('div', { class: 'eintrag' + (g.typ === 'RCD' ? ' ist-rcd' : '') + (g.reserve ? ' reserve' : '') + (g.unsicher ? ' unsicher' : '') },
        h('span', { class: 'e-nr' }, g.nr),
        MIT_BMK && h('span', { class: 'e-bmk' }, g.bmk),
        h('span', { class: 'e-schutz' }, h('b', null, a.haupt), a.neben && h('small', null, a.neben)),
        h('span', { class: 'e-text' }, a.text, a.detail.length ? h('span', { class: 'e-detail' }, a.detail.join(' · ')) : null),
        h('span', { class: 'e-rcd' }, punkt(g)));
      if (g.gruppe) el.style.setProperty('--gruppe', gruppenFarbe(g.gruppe));
      return el;
    }

    function reiheKarte(r) {
      const streifen = h('div', { class: 'streifen' }, r.geraete.map(modul));
      streifen.style.setProperty('--te', r.spalten);
      const gelistet = r.geraete.filter(g => g.typ !== 'LEER');
      const halb = Math.ceil(gelistet.length / 2);
      return h('section', { class: 'reihe' },
        h('div', { class: 'reihe-kopf' }, h('small', null, 'Reihe'), h('b', null, r.nr)),
        h('div', null, streifen,
          h('div', { class: 'liste' },
            h('div', null, gelistet.slice(0, halb).map(eintrag)),
            h('div', null, gelistet.slice(halb).map(eintrag)))));
    }

    // "5–12, 17–20" aus den Plaetzen aller Geraete einer RCD-Gruppe
    function bereiche(geraete) {
      const aus = [];
      for (const g of [...geraete].sort((a, b) => a.von - b.von)) {
        const letzter = aus[aus.length - 1];
        if (letzter && g.von <= letzter[1] + 1) letzter[1] = Math.max(letzter[1], g.bis);
        else aus.push([g.von, g.bis]);
      }
      return aus.map(b => spanne(b[0], b[1])).join(', ');
    }

    function legende() {
      const links = h('div', null, h('h3', null, 'Fehlerstrom-Schutz (RCD)'));
      for (const r of rcds) {
        const geschuetzt = alle.filter(g => g.gruppe === r.gruppe && g.typ !== 'RCD');
        links.append(h('div', { class: 'l-rcd' },
          h('span', { class: 'punkt', style: `--gruppe:${gruppenFarbe(r.gruppe)}` }, r.gruppe),
          h('span', null, h('b', null, 'RCD ' + r.gruppe),
            ' ' + [r.wert, r.art].filter(Boolean).join(' · ') + ' ',
            h('small', null, geschuetzt.length ? `– schützt Nr. ${bereiche(geschuetzt)}` : '– keine Stromkreise zugeordnet'))));
      }
      if (alle.some(g => g.gruppe === 'eigen')) links.append(h('div', { class: 'l-rcd' },
        h('span', { class: 'punkt', style: `--gruppe:${gruppenFarbe('eigen')}` }, 'Δ'),
        h('span', null, h('b', null, 'FI/LS'), ' ', h('small', null, '– Stromkreis mit eigenem Fehlerstromschutz'))));
      const fraglich = alle.filter(g => g.gruppe === 'offen');
      if (fraglich.length) links.append(h('div', { class: 'l-rcd' },
        h('span', { class: 'punkt fraglich' }, '?'),
        h('span', null, h('small', null, `RCD-Zuordnung noch offen: Nr. ${bereiche(fraglich)}`))));
      const ohne = alle.filter(g => g.T.kreis && !g.gruppe);
      if (ohne.length) links.append(h('div', { class: 'l-rcd' },
        h('span', { class: 'punkt ohne' }, '–'),
        h('span', null, h('small', null, `ohne RCD: Nr. ${bereiche(ohne)}`))));

      const kurz = [['Nr.', 'Platz im Verteiler (Teilungseinheit), gezählt von links nach rechts, Reihe 1 oben']];
      if (MIT_BMK) kurz.push(['BMK', 'Betriebsmittelkennzeichen']);
      const genutzt = [...new Set(alle.map(g => g.typ))].filter(t => TYPEN[t].kurz);
      for (const t of genutzt) kurz.push([TYPEN[t].kurz, TYPEN[t].lang]);
      const bsp = alle.map(g => /^([A-Z])\s?(\d+)$/.exec(g.T.kreis && g.wert || '')).find(Boolean);
      if (bsp) kurz.push([bsp[0], `Auslösecharakteristik ${bsp[1]}, Bemessungsstrom ${bsp[2]} A`]);
      if (alle.some(g => /\dp$/.test(anzeige(g).neben))) kurz.push(['3p', '3-polig']);
      const rechts = h('div', null, h('h3', null, 'Kurzzeichen'),
        h('div', { class: 'l-kurz' }, kurz.map((k, i) => [i ? ' · ' : '', h('span', null, h('b', null, k[0])), ' ' + k[1]])));
      return h('section', { class: 'legende' }, links, rechts);
    }

    function nachtrag() {
      return h('section', { class: 'nachtrag' },
        h('div', { class: 'nachtrag-kopf' }, h('span', null, 'Datum'), h('span', null, 'Änderung / Nachtrag'), h('span', null, 'Name')),
        h('div', { class: 'nachtrag-linien' }));
    }

    function schluss() {
      const hinweis = FIRMA.hinweis ?? 'Arbeiten an elektrischen Anlagen dürfen nur von Elektrofachkräften ausgeführt werden. Änderungen an der Anlage bitte in diesem Plan nachtragen lassen.';
      return h('section', { class: 'schluss' },
        h('div', { class: 'hinweis' },
          (PLAN.bemerkung || hinweis) && h('p', null, PLAN.bemerkung && h('b', null, PLAN.bemerkung + ' '), hinweis),
          FIRMA.normhinweis && h('p', null, FIRMA.normhinweis)),
        h('div', { class: 'unterschrift' },
          h('div', null, `Erstellt am ${datumText(PLAN.datum)}`, PLAN.bearbeiter ? ` · ${PLAN.bearbeiter}` : ''),
          h('i'), h('small', null, 'Unterschrift')));
    }

    function warnbox() {
      if (!warnungen.length) return null;
      return h('div', { class: 'warnung' }, h('b', null, 'Bitte Daten prüfen – dieser Plan ist so nicht stimmig:'), warnungen.join(' · '));
    }

    // Solange offene Punkte im Plan stehen, ist er als Entwurf gekennzeichnet
    const OFFEN = (PLAN.offen || []).filter(Boolean);
    function entwurfbox() {
      if (!OFFEN.length) return null;
      return h('div', { class: 'entwurf' }, h('b', null, 'Entwurf – vor Ausgabe an den Kunden klären'),
        h('ol', null, OFFEN.map(p => h('li', null, p))));
    }

    /* ================= Seiten setzen ================= */
    const titelzeile = [OFFEN.length ? 'ENTWURF Verteilerplan' : 'Verteilerplan', PLAN.kunde, PLAN.verteiler].filter(Boolean).join(' – ');

    function neuesBlatt(seite) {
      const rumpf = h('main', { class: 'rumpf' });
      const blatt = h('section', { class: 'blatt' },
        seite === 1 ? kopfGross('Verteilerplan', OFFEN.length ? 'Entwurf · Stromkreisverzeichnis' : 'Stromkreisverzeichnis') : kopfKlein(titelzeile),
        seite === 1 && meta(), seite === 1 && warnbox(), seite === 1 && entwurfbox(), spaltenkopf(), rumpf, fusszeile());
      ziel.append(blatt);
      return rumpf;
    }
    const passt = rumpf => rumpf.scrollHeight <= rumpf.clientHeight + 1;
    const leeren = () => ziel.querySelectorAll('.blatt').forEach(b => b.remove());

    function plan() {
      const dichten = ['gross', 'normal', 'kompakt', 'eng'];
      let nach, ende;
      for (const d of dichten) {
        ziel.classList.remove(...dichten.map(x => 'd-' + x));
        ziel.classList.add('d-' + d);
        leeren();
        const karten = reihen.map(reiheKarte), leg = legende();
        nach = nachtrag(); ende = schluss();
        let rumpf = neuesBlatt(1);
        rumpf.append(...karten, leg, nach, ende);
        if (passt(rumpf)) break;
        if (d !== dichten[dichten.length - 1]) continue;
        // passt auch die engste Stufe nicht auf ein Blatt: Reihen auf mehrere Seiten verteilen
        leeren();
        let seite = 1;
        rumpf = neuesBlatt(seite);
        for (const teil of [...karten, leg]) {
          rumpf.append(teil);
          if (!passt(rumpf) && rumpf.children.length > 1) { rumpf = neuesBlatt(++seite); rumpf.append(teil); }
        }
        rumpf.append(nach, ende);
        if (!passt(rumpf)) { rumpf = neuesBlatt(++seite); rumpf.append(nach, ende); }
      }
      // Seiten ohne Reihen brauchen keinen Spaltenkopf
      for (const blatt of ziel.querySelectorAll('.blatt')) {
        if (!blatt.querySelector('.reihe')) blatt.querySelector('.spaltenkopf').remove();
      }
      // Nachtragsfeld auf ganze Zeilen kuerzen; bleibt zu wenig Platz, entfaellt es
      const linien = nach.querySelector('.nachtrag-linien');
      const zeilen = Math.floor(linien.clientHeight / (7.5 * MM) + .02);
      if (zeilen < 2) { nach.remove(); ende.classList.add('unten'); }
      else {
        nach.style.flex = 'none'; nach.style.maxHeight = 'none'; linien.style.flex = 'none';
        for (let i = 0; i < zeilen; i++) linien.append(h('div', { class: 'n-zeile' }, h('span'), h('span'), h('span')));
      }
      seitenzahlen();
      return { titel: titelzeile, warnungen, offen: OFFEN };
    }

    /* ================= Aufnahmebogen ================= */
    function aufnahmebogen() {
      ziel.classList.add('bogen');
      const gesamt = Number(PLAN.reihen_gesamt) || 5, erste = Math.min(Number(PLAN.reihen_seite1) || 3, gesamt);
      // Platzhalter fuer ein Formularfeld. Art: text | auto (Schrift passt sich an) | mitte | mehrzeilig | haken.
      // Namen: nur a-z, 0-9, _ . Felder namens craftnote_1_... fuellt Craftnote beim Oeffnen im Projekt selbst aus.
      const eingabe = (art, name) => h('a', { class: 'feld', href: `https://feld.invalid/${art}/${name}` });
      const zelle = (l, name, art = 'text') => h('div', null, h('div', { class: 'm-l' }, l), eingabe(art, name));
      const k = name => h('i', { class: 'kaestchen' }, eingabe('haken', name));
      const zwei = p => String(p).padStart(2, '0');
      const felder = h('section', { class: 'meta' },
        zelle('Projekt', 'craftnote_1_project_name', 'auto'), zelle('Kunde', 'craftnote_1_customer_name', 'auto'),
        zelle('Straße (Anlage)', 'craftnote_1_project_street', 'auto'),
        h('div', null, h('div', { class: 'm-l' }, 'PLZ · Ort'),
          h('div', { class: 'm-felder' }, eingabe('text', 'craftnote_1_project_zipcode'), eingabe('auto', 'craftnote_1_project_city'))),
        zelle('Verteiler', 'verteiler'), zelle('Standort', 'standort'),
        h('div', null, h('div', { class: 'm-l' }, 'Netzsystem'), h('div', { class: 'm-w' },
          k('netz_tncs'), 'TN-C-S', h('span', { class: 'abstand' }), k('netz_tns'), 'TN-S', h('span', { class: 'abstand' }), k('netz_tt'), 'TT')),
        zelle('Vorsicherung', 'vorsicherung'),
        zelle('Datum', 'datum'), zelle('LS ohne Angabe sind', 'ls_standard'), zelle('RCD ohne Angabe sind', 'rcd_standard', 'auto'),
        zelle('RCD-Zuordnung', 'rcd_zuordnung', 'auto'));
      const tipp = h('div', { class: 'bogen-tipp' },
        h('b', null, 'Kästchen: '), 'Schutzorgan je Platz (z. B. C20, RCD, FI/LS) – normale LS leer lassen, wenn „LS ohne Angabe sind“ ausgefüllt ist; weitere Plätze desselben Geräts „=“. ',
        h('b', null, 'Linie: '), 'Stromkreis / Raum. Freie Plätze ganz leer. ',
        h('b', null, 'RCD-Zuordnung: '), 'nur wenn ein RCD mehrere Reihen schützt oder Stromkreise ohne RCD sind.');

      function bogenReihe(nr) {
        const von = (nr - 1) * BREITE + 1;
        const plaetze = Array.from({ length: BREITE }, (_, i) => von + i);
        const streifen = h('div', { class: 'streifen' }, plaetze.map(p =>
          h('div', { class: 'modul' }, h('span', { class: 'm-nr' }, p), eingabe('mitte', 's' + zwei(p)))));
        streifen.style.setProperty('--te', BREITE);
        const zeile = p => h('div', { class: 'eintrag' }, h('span', { class: 'e-nr' }, p), eingabe('text', 't' + zwei(p)));
        const halb = Math.ceil(BREITE / 2);
        return h('section', { class: 'reihe' },
          h('div', { class: 'reihe-kopf' }, h('small', null, 'Reihe'), h('b', null, nr)),
          h('div', null, streifen, h('div', { class: 'liste' },
            h('div', null, plaetze.slice(0, halb).map(zeile)),
            h('div', null, plaetze.slice(halb).map(zeile)))));
      }
      const nummern = Array.from({ length: gesamt }, (_, i) => i + 1);

      const rumpf1 = h('main', { class: 'rumpf' }, nummern.slice(0, erste).map(bogenReihe));
      ziel.append(h('section', { class: 'blatt' }, kopfGross('Aufnahmebogen', 'Elektroverteiler'), felder, tipp, rumpf1, fusszeileBogen()));
      if (gesamt > erste) {
        const rumpf2 = h('main', { class: 'rumpf' }, nummern.slice(erste).map(bogenReihe),
          h('section', { class: 'notizen' }, h('h3', null, 'Notizen'), h('div')));
        ziel.append(h('section', { class: 'blatt' }, kopfKlein(`Elektroverteiler Aufnahmebogen · Reihe ${erste + 1}–${gesamt}`), rumpf2, fusszeileBogen()));
        const feld = rumpf2.querySelector('.notizen > div');
        const zeilen = Math.floor(feld.clientHeight / (8.6 * MM) + .02);
        for (let i = 0; i < zeilen; i++) feld.append(h('i'));
        feld.append(eingabe('mehrzeilig', 'notizen'));
      }
      seitenzahlen();
      return { titel: 'Elektroverteiler Aufnahmebogen', warnungen: [], offen: [] };
    }

    return PLAN.aufnahmebogen ? aufnahmebogen() : plan();
  }

  global.Verteilerplan = { zeichne, schriftenLaden, teVon, TYPEN, datumText };
})(window);
