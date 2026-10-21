/* Wandelt die Felder eines ausgefuellten Aufnahmebogens (Aufnahmebogen.pdf) in Plan-Daten um.
   Nutzbar in der Web-App (window.BogenImport) und in Node (require).

   BogenImport.zuPlan(felder) -> plan
     felder: { feldname: Text oder true/false }, z. B. aus pdf-lib oder pypdf
     plan:   Plan-Daten wie in Plaene/*.json; alles Unklare steht in plan.offen

   Lesart (steht so auch auf dem Bogen): Kaestchen = Schutzorgan, Linie = Stromkreis.
   "=" im Kaestchen: gehoert zum Geraet links daneben. Kaestchen leer + Linie gefuellt: LS mit dem
   Wert aus "LS ohne Angabe sind". Beides leer: freier Platz. */
(function (global) {
  'use strict';
  const REIHEN = 5, BREITE = 12;
  const KREISE = ['LS', 'SI', 'AFDD'];
  const zwei = p => String(p).padStart(2, '0');

  function isoDatum(t) {
    const m = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/.exec(t);
    if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : '';
  }

  // "b 16" -> "B16"
  function kennung(t) {
    const m = /(?:^|[^A-Z])([BCDKZE])\s*-?\s*(\d{1,3})(?!\d)/i.exec(t || '');
    return m ? m[1].toUpperCase() + m[2] : '';
  }

  // "40/0,03 A Typ A" -> { wert: "40 A / 30 mA", art: "Typ A" }
  function rcdDaten(t) {
    t = (t || '').trim();
    if (!t) return { wert: '', art: '' };
    const typ = /\bTyp\s*(AC|A|B\+|B|F|EV)\b/i.exec(t);
    const strom = /(\d{2,3})\s*A?\s*\/\s*(\d+(?:[.,]\d+)?)\s*(mA|A)?/i.exec(t);
    let wert;
    if (strom) {
      let fi = parseFloat(strom[2].replace(',', '.'));
      const einheit = (strom[3] || '').toLowerCase();
      if (einheit === 'a' || (!einheit && fi < 1)) fi = Math.round(fi * 1000);
      wert = `${strom[1]} A / ${fi} mA`;
    } else {
      wert = t.replace(/\bTyp\s*\S+/i, '').replace(/\s{2,}/g, ' ').trim();
    }
    return { wert, art: typ ? 'Typ ' + typ[1].toUpperCase() : '' };
  }

  // Inhalt eines Kaestchens -> Geraet
  function geraetAus(roh, std, p, offen) {
    roh = roh.replace(/\s+/g, ' ').trim();
    if (!roh) {
      if (std.ls) return { typ: 'LS', wert: std.ls };
      offen.push(`Nr. ${p}: Schutzorgan fehlt (oben „LS ohne Angabe sind“ ist leer)`);
      return { typ: 'LS', unsicher: true };
    }
    if (/fi\s*\/\s*ls|rcbo/i.test(roh)) return { typ: 'FILS', wert: kennung(roh) || std.ls };
    if (/^(rcd|fi\b|fehlerstrom)/i.test(roh)) {
      const d = rcdDaten(roh.replace(/^(rcd|fi|fehlerstrom\S*)\s*/i, ''));
      const g = { typ: 'RCD', wert: d.wert || std.rcd.wert, art: d.art || std.rcd.art };
      if (!g.wert) offen.push(`Nr. ${p}: RCD-Daten fehlen (oben „RCD ohne Angabe sind“ ist leer)`);
      return g;
    }
    if (/^(afdd|brand)/i.test(roh)) return { typ: 'AFDD', wert: kennung(roh) || std.ls };
    if (/^sls/i.test(roh)) return { typ: 'SLS', wert: kennung(roh) || roh.replace(/^sls\s*/i, '') };
    if (/^[BCDKZ]\s*-?\s*\d{1,3}\s*A?$/i.test(roh)) return { typ: 'LS', wert: kennung(roh) };
    if (/neozed|diazed|^d0\d|^si\b|sicherung/i.test(roh)) return { typ: 'SI', wert: roh };
    if (/^(spd|überspann|ueberspann|üss|ues)/i.test(roh)) return { typ: 'SPD' };
    if (/^(hs\b|haupt)/i.test(roh)) return { typ: 'HS' };
    if (/trafo|klingel/i.test(roh)) return { typ: 'TRAFO', wert: (/\d+\s*\/\s*\d+\s*V|\d+\s*V/i.exec(roh) || [''])[0] };
    if (/sch(ü|ue)tz/i.test(roh)) return { typ: 'SCHUETZ', wert: (/\d+\s*A/i.exec(roh) || [''])[0] };
    if (/^sts\b|stromsto/i.test(roh)) return { typ: 'STS' };
    if (/uhr|zeitschalt/i.test(roh)) return { typ: 'UHR' };
    if (/kwh|z(ä|ae)hler/i.test(roh)) return { typ: 'ZAEHLER' };
    if (/steckdose|^sd$/i.test(roh)) return { typ: 'SD' };
    if (/^\d{1,3}\s*A?$/i.test(roh)) {
      offen.push(`Nr. ${p}: „${roh}“ – Auslösecharakteristik (B/C) fehlt`);
      return { typ: 'LS', wert: roh.replace(/\s*A$/i, '') + ' A', unsicher: true };
    }
    offen.push(`Nr. ${p}: „${roh}“ ist keinem Gerätetyp zugeordnet`);
    return { typ: 'SONST', wert: roh, unsicher: true };
  }

  // Aus dem Freitext "RCD-Zuordnung" lesen, woher Reihe `ziel` ihren Schutz bekommt.
  // Ergebnis: Reihennummer, 'ohne' oder null (nicht eindeutig)
  function reiheAusZuordnung(text, ziel) {
    for (const satz of (text || '').split(/[;\n]|\bund\b|,/i)) {
      const reihen = [...satz.matchAll(/\b(?:Reihe|R)\s*(\d)\b/gi)].map(m => Number(m[1]));
      if (!reihen.includes(ziel)) continue;
      if (/ohne/i.test(satz)) return 'ohne';
      const quelle = /RCD\s*(?:aus|in|der|von)?\s*(?:Reihe|R)\s*(\d)/i.exec(satz);
      if (quelle && Number(quelle[1]) !== ziel) return Number(quelle[1]);
    }
    return null;
  }

  function zuPlan(felder) {
    const w = {};
    // Manche Programme verschachteln Feldnamen ("formular.kunde") - es zaehlt der letzte Teil
    for (const [k, v] of Object.entries(felder || {})) w[String(k).split('.').pop()] = v;
    const t = k => (w[k] == null || w[k] === false ? '' : String(w[k])).trim();
    const an = k => w[k] === true || /^\/?(ja|on|yes|true)$/i.test(t(k));
    const offen = [];

    const netz = [an('netz_tncs') && 'TN-C-S', an('netz_tns') && 'TN-S', an('netz_tt') && 'TT'].filter(Boolean);
    if (netz.length > 1) offen.push(`Netzsystem: mehrere angekreuzt (${netz.join(', ')})`);
    const plan = {
      kunde: t('craftnote_1_customer_name') || t('craftnote_1_project_name'),
      adresse: [t('craftnote_1_project_street'),
        [t('craftnote_1_project_zipcode'), t('craftnote_1_project_city')].filter(Boolean).join(' ')].filter(Boolean).join(', '),
      verteiler: t('verteiler'),
      standort: t('standort'),
      netz: netz.length === 1 ? netz[0] : '',
      vorsicherung: t('vorsicherung'),
      datum: isoDatum(t('datum')),
      bearbeiter: '',
      bemerkung: '',
      te_pro_reihe: BREITE,
      reihen: [],
      offen
    };
    if (t('datum') && !plan.datum) offen.push(`Datum „${t('datum')}“ nicht erkannt`);
    if (t('notizen')) plan.notizen = t('notizen');
    const std = { ls: kennung(t('ls_standard')) || t('ls_standard'), rcd: rcdDaten(t('rcd_standard')) };

    const reihen = [];
    let letzte = 0;
    for (let r = 1; r <= REIHEN; r++) {
      const geraete = [];
      for (let i = 0; i < BREITE; i++) {
        const p = (r - 1) * BREITE + i + 1;
        let s = t('s' + zwei(p));
        const linie = t('t' + zwei(p));
        const vor = geraete[geraete.length - 1];
        if (/^(=|"|〃|''|dito)$/i.test(s)) {
          if (vor && vor.typ !== 'LEER') {
            vor.te++;
            if (linie && !vor.text) vor.text = linie;
            else if (linie && linie !== vor.text) vor.hinweis = [vor.hinweis, linie].filter(Boolean).join(' · ');
            continue;
          }
          offen.push(`Nr. ${p}: „=“ ohne Gerät links daneben`);
          s = '?';
        }
        if (!s && !linie) {
          if (vor && vor.typ === 'LEER') vor.te++; else geraete.push({ typ: 'LEER', te: 1 });
          continue;
        }
        const g = geraetAus(s, std, p, offen);
        g.te = 1;
        let text = linie;
        if (/ohne\s*rcd/i.test(text)) {
          g.rcd = 'ohne';
          text = text.replace(/\(?\s*ohne\s*rcd\s*\)?/i, ' ').replace(/\s{2,}/g, ' ').replace(/^[\s,–-]+|[\s,–-]+$/g, '');
        }
        if (text) g.text = text;
        g.platz = p;
        geraete.push(g);
      }
      // Polzahl ergibt sich aus der Zahl der belegten Plaetze
      for (const g of geraete) {
        if (g.typ === 'RCD') {
          g.pole = g.te >= 3 ? 4 : 2;
          if (g.te < 2) offen.push(`Nr. ${g.platz}: RCD belegt nur einen Platz – „=“ in den weiteren Kästchen vergessen?`);
        } else if (['LS', 'SLS', 'SI'].includes(g.typ) && g.te > 1) g.pole = g.te;
        else if (['FILS', 'AFDD'].includes(g.typ) && g.te >= 2) g.pole = g.te >= 4 ? '3+N' : '1+N';
        delete g.platz;
      }
      while (geraete.length && geraete[geraete.length - 1].typ === 'LEER') geraete.pop();
      if (geraete.length) letzte = r;
      reihen.push({ geraete });
    }
    plan.reihen = reihen.slice(0, letzte);

    // Reihen ohne eigenen RCD: Zuordnung aus dem Bogen lesen, sonst als offen markieren
    const ersterRcd = [];
    let n = 0;
    plan.reihen.forEach((r, i) => r.geraete.forEach(g => { if (g.typ === 'RCD') { n++; if (!ersterRcd[i]) ersterRcd[i] = n; } }));
    const zuordnung = t('rcd_zuordnung');
    plan.reihen.forEach((r, i) => {
      if (ersterRcd[i]) return;
      if (!r.geraete.some(g => KREISE.includes(g.typ) && g.rcd === undefined)) return;
      const quelle = reiheAusZuordnung(zuordnung, i + 1);
      if (quelle === 'ohne') r.rcd = 'ohne';
      else if (quelle && ersterRcd[quelle - 1]) r.rcd = ersterRcd[quelle - 1];
      else {
        r.rcd = '?';
        offen.push(`Reihe ${i + 1} hat keinen eigenen RCD – welcher RCD schützt sie?` + (zuordnung ? ` (Bogen: „${zuordnung}“)` : ''));
      }
    });
    if (!plan.reihen.length) offen.push('Im Bogen sind keine Plätze ausgefüllt');
    return plan;
  }

  const api = { zuPlan, rcdDaten, kennung, isoDatum };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else global.BogenImport = api;
})(typeof window !== 'undefined' ? window : globalThis);
